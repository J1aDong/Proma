import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  PluginDocumentChatEvent,
  PluginDocumentChatHistoryInput,
  PluginDocumentChatHistoryResult,
  PluginDocumentChatMessage,
  PluginDocumentChatReference,
  PluginDocumentChatSendInput,
  PluginDocumentChatSendResult,
} from '@proma/shared'
import { computeEmbedding, loadKnowledgeBaseIndex, resolvePluginModelOrThrow } from './ai-indexing-service'
import { getAdapter, streamSSE } from '@proma/core'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { getFetchFn } from '../proxy-fetch'
import { resolveChannelAndModel } from './model-resolution'

const LATEST_INDEX_SUMMARY_PATH = 'wiki/latest-index-summary.json'

interface WikiPageContext {
  id: string
  title: string
  path: string
  content: string
}

interface ChatSessionRecord {
  pluginId: string
  knowledgeBaseId: string
  sessionId: string
  model?: string
  messages: PluginDocumentChatMessage[]
}

type ChatEventListener = (event: PluginDocumentChatEvent) => void

function nowIso(): string {
  return new Date().toISOString()
}

function sessionKey(pluginId: string, knowledgeBaseId: string, sessionId: string): string {
  return `${pluginId}::${knowledgeBaseId}::${sessionId}`
}

function cosineSimilarity(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length)
  if (size === 0) {
    return 0
  }

  let dot = 0
  let normLeft = 0
  let normRight = 0

  for (let i = 0; i < size; i += 1) {
    const a = left[i] ?? 0
    const b = right[i] ?? 0
    dot += a * b
    normLeft += a * a
    normRight += b * b
  }

  if (normLeft <= 0 || normRight <= 0) {
    return 0
  }

  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight))
}

function extractSnippet(content: string, maxChars = 260): string {
  const normalized = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')

  if (normalized.length <= maxChars) {
    return normalized
  }

  return `${normalized.slice(0, maxChars)}...`
}

function extractFilePathHintsFromWikiPages(pages: WikiPageContext[]): Set<string> {
  const hints = new Set<string>()
  const patterns = [
    /`([^`\n]+\.[a-zA-Z0-9]+)`/g,
    /([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+)/g,
  ]

  for (const page of pages) {
    for (const pattern of patterns) {
      let matched = pattern.exec(page.content)
      while (matched) {
        const value = matched[1]?.trim()
        if (value) {
          hints.add(value)
        }
        matched = pattern.exec(page.content)
      }
    }
  }

  return hints
}

async function readWorkspaceJsonIfExists<T>(workspacePath: string, relativePath: string): Promise<T | null> {
  try {
    const absolutePath = resolve(workspacePath, relativePath)
    const content = await readFile(absolutePath, 'utf-8')
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

async function readWorkspaceTextIfExists(workspacePath: string, relativePath: string): Promise<string | null> {
  try {
    const absolutePath = resolve(workspacePath, relativePath)
    return await readFile(absolutePath, 'utf-8')
  } catch {
    return null
  }
}

async function loadWikiPagesForKnowledgeBase(input: {
  workspacePath: string
  knowledgeBaseId: string
}): Promise<WikiPageContext[]> {
  const summary = await readWorkspaceJsonIfExists<{
    knowledgeBaseId?: string
    pages?: Array<{ id?: string; title?: string; path?: string }>
  }>(input.workspacePath, LATEST_INDEX_SUMMARY_PATH)

  const normalizedKb = input.knowledgeBaseId.trim()
  const summaryPages = summary
    && typeof summary.knowledgeBaseId === 'string'
    && summary.knowledgeBaseId === normalizedKb
    && Array.isArray(summary.pages)
      ? summary.pages
      : []

  const normalizedPages = summaryPages
    .map((item) => ({
      id: typeof item?.id === 'string' ? item.id.trim() : '',
      title: typeof item?.title === 'string' ? item.title.trim() : '',
      path: typeof item?.path === 'string' ? item.path.trim() : '',
    }))
    .filter((item) => item.id.length > 0 && item.title.length > 0 && item.path.length > 0)

  const fallbackPages = [
    { id: 'index', title: '首页', path: `wiki/knowledge-bases/${normalizedKb}/pages/index.md` },
    { id: 'architecture', title: '架构总览', path: `wiki/knowledge-bases/${normalizedKb}/pages/architecture.md` },
    { id: 'runtime', title: '运行链路', path: `wiki/knowledge-bases/${normalizedKb}/pages/runtime.md` },
    { id: 'modules', title: '模块明细', path: `wiki/knowledge-bases/${normalizedKb}/pages/modules.md` },
    { id: 'data-risks', title: '数据与风险', path: `wiki/knowledge-bases/${normalizedKb}/pages/data-risks.md` },
  ]

  const pagesToLoad = normalizedPages.length > 0 ? normalizedPages : fallbackPages
  const output: WikiPageContext[] = []

  for (const page of pagesToLoad) {
    const content = await readWorkspaceTextIfExists(input.workspacePath, page.path)
    if (!content) {
      continue
    }
    output.push({
      id: page.id,
      title: page.title,
      path: page.path,
      content,
    })
  }

  return output
}

function buildDocumentChatPrompt(input: {
  question: string
  knowledgeBaseId: string
  wikiPages: WikiPageContext[]
  references: PluginDocumentChatReference[]
}): { systemMessage: string; mergedReferences: PluginDocumentChatReference[] } {
  const wikiReferences = input.wikiPages.map((page) => ({
    chunkId: `wiki:${page.id}`,
    filePath: page.path,
    score: 1,
    snippet: extractSnippet(page.content, 200),
  }))

  const mergedReferences = [...wikiReferences, ...input.references]
  const wikiSection = input.wikiPages.length > 0
    ? input.wikiPages
      .map((page, index) => [
        `### Wiki-${index + 1}: ${page.title} (${page.path})`,
        '```markdown',
        extractSnippet(page.content, 1000),
        '```',
      ].join('\n'))
      .join('\n\n')
    : '无可用 Wiki 页面，请优先依据源码证据回答。'

  const sourceBullets = input.references
    .map((item, index) => {
      return `${index + 1}. ${item.filePath}\n${item.snippet}`
    })
    .join('\n')

  const systemMessage = [
    '你是仓库 Wiki 助手，请严格基于证据回答。',
    `当前知识库：${input.knowledgeBaseId}`,
    '回答要求：',
    '- 当前是只读问答模式，不执行代码、不调用工具、不提供写入动作；',
    '- 先根据 Wiki 章节定位问题语义，再下钻源码片段给出结论；',
    '- 回答中明确区分「Wiki 结论」与「源码证据」；',
    '- 每条关键结论都要标注来源文件路径；',
    '- 若证据不足，请明确说明不确定点，不要编造。',
    '',
    '## Wiki 关键上下文',
    wikiSection,
    '',
    '## 源码语义检索结果',
    sourceBullets || '未检索到有效源码片段。',
    '',
    `## 用户问题`,
    input.question,
  ].join('\n')

  return {
    systemMessage,
    mergedReferences,
  }
}

export class PluginDocumentChatBridge {
  private readonly sessions = new Map<string, ChatSessionRecord>()
  private readonly listeners = new Set<ChatEventListener>()

  onEvent(listener: ChatEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async sendMessage(input: {
    pluginId: string
    workspacePath: string
    payload: Omit<PluginDocumentChatSendInput, 'pluginId'>
  }): Promise<PluginDocumentChatSendResult> {
    const knowledgeBaseId = input.payload.knowledgeBaseId.trim()
    if (!knowledgeBaseId) {
      return {
        success: false,
        pluginId: input.pluginId,
        knowledgeBaseId,
        sessionId: input.payload.sessionId ?? '',
        error: 'knowledgeBaseId 不能为空',
      }
    }

    const normalizedSessionId = input.payload.sessionId?.trim() || randomUUID()
    const key = sessionKey(input.pluginId, knowledgeBaseId, normalizedSessionId)

    const session = this.sessions.get(key) ?? {
      pluginId: input.pluginId,
      knowledgeBaseId,
      sessionId: normalizedSessionId,
      model: input.payload.model,
      messages: [],
    }

    const incomingMessages = input.payload.messages
      .filter((message) => message.content.trim().length > 0)
      .map((message) => ({ ...message, createdAt: message.createdAt ?? nowIso() }))

    if (incomingMessages.length === 0) {
      return {
        success: false,
        pluginId: input.pluginId,
        knowledgeBaseId,
        sessionId: normalizedSessionId,
        error: 'messages 不能为空',
      }
    }

    session.messages.push(...incomingMessages)
    this.sessions.set(key, session)

    const userQuestion = [...incomingMessages].reverse().find((item) => item.role === 'user')?.content.trim()
    if (!userQuestion) {
      return {
        success: false,
        pluginId: input.pluginId,
        knowledgeBaseId,
        sessionId: normalizedSessionId,
        error: '缺少用户问题消息',
      }
    }

    let resolvedModel: string | undefined

    try {
      resolvedModel = await resolvePluginModelOrThrow(input.payload.model)
      const { channel, modelId: actualModelId, apiKey } = resolveChannelAndModel(resolvedModel)

      const adapter = getAdapter(channel.provider)

      const knowledgeBase = await loadKnowledgeBaseIndex(
        input.pluginId,
        input.workspacePath,
        knowledgeBaseId,
        resolvedModel,
      )

      const topK = Math.max(1, Math.min(20, Math.floor(input.payload.topK ?? 6)))
      const queryEmbedding = computeEmbedding(userQuestion)
      const wikiPages = await loadWikiPagesForKnowledgeBase({
        workspacePath: input.workspacePath,
        knowledgeBaseId,
      })
      const rankedWikiPages = wikiPages
        .map((page) => ({
          page,
          score: cosineSimilarity(queryEmbedding, computeEmbedding(page.content.slice(0, 4000))),
        }))
        .sort((a, b) => b.score - a.score)
      const selectedWikiPages = rankedWikiPages.slice(0, 3).map((item) => item.page)
      const wikiFileHintCandidates = [...extractFilePathHintsFromWikiPages(selectedWikiPages)].slice(0, 40)
      const wikiFileHints = new Set(wikiFileHintCandidates)
      const references: PluginDocumentChatReference[] = knowledgeBase.chunks
        .map((chunk) => {
          const score = cosineSimilarity(queryEmbedding, chunk.embedding)
          const pathBoost = wikiFileHints.has(chunk.filePath)
            ? 0.12
            : wikiFileHintCandidates.some((hint) => hint.length > 0 && chunk.filePath.endsWith(hint))
              ? 0.07
              : 0
          return {
            chunkId: chunk.id,
            filePath: chunk.filePath,
            score: score + pathBoost,
            snippet: extractSnippet(chunk.content, 240),
          }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)

      const { systemMessage, mergedReferences } = buildDocumentChatPrompt({
        question: userQuestion,
        knowledgeBaseId,
        wikiPages: selectedWikiPages,
        references,
      })

      const assistantMessage: PluginDocumentChatMessage = {
        role: 'assistant',
        content: '',
        createdAt: nowIso(),
      }
      session.messages.push(assistantMessage)

      if (mergedReferences.length > 0) {
        this.emit({
          type: 'citation',
          pluginId: input.pluginId,
          knowledgeBaseId,
          sessionId: normalizedSessionId,
          model: resolvedModel,
          references: mergedReferences,
          timestamp: nowIso(),
        })
      }

      // 组装历史消息
      const historyForProvider = session.messages
        .slice(0, -1)
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((msg) => {
          const role: 'user' | 'assistant' = msg.role === 'user' ? 'user' : 'assistant'
          return {
            id: randomUUID(),
            role,
            content: msg.content,
            createdAt: new Date(msg.createdAt ?? nowIso()).getTime(),
          }
        })

      // 调用适配器获取真实数据
      const request = adapter.buildStreamRequest({
        baseUrl: channel.baseUrl,
        apiKey,
        modelId: actualModelId,
        history: historyForProvider,
        userMessage: userQuestion,
        systemMessage,
        readImageAttachments: () => [], // DeepWiki 目前不支持图片
        thinkingEnabled: false,
      })

      const proxyUrl = await getEffectiveProxyUrl()
      const fetchFn = getFetchFn(proxyUrl)

      await streamSSE({
        request,
        adapter,
        fetchFn,
        onEvent: (event) => {
          if (event.type === 'chunk') {
            assistantMessage.content += event.delta
            this.emit({
              type: 'delta',
              pluginId: input.pluginId,
              knowledgeBaseId,
              sessionId: normalizedSessionId,
              model: resolvedModel,
              delta: event.delta,
              timestamp: nowIso(),
            })
          } else if (event.type === 'error') {
            this.emit({
              type: 'error',
              pluginId: input.pluginId,
              knowledgeBaseId,
              sessionId: normalizedSessionId,
              model: resolvedModel,
              error: event.error,
              timestamp: nowIso(),
            })
          }
        }
      })

      this.emit({
        type: 'done',
        pluginId: input.pluginId,
        knowledgeBaseId,
        sessionId: normalizedSessionId,
        model: resolvedModel,
        message: { ...assistantMessage },
        timestamp: nowIso(),
      })

      return {
        success: true,
        pluginId: input.pluginId,
        knowledgeBaseId,
        sessionId: normalizedSessionId,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({
        type: 'error',
        pluginId: input.pluginId,
        knowledgeBaseId,
        sessionId: normalizedSessionId,
        model: resolvedModel ?? input.payload.model,
        error: message,
        timestamp: nowIso(),
      })

      return {
        success: false,
        pluginId: input.pluginId,
        knowledgeBaseId,
        sessionId: normalizedSessionId,
        error: message,
      }
    }
  }

  endSession(input: { pluginId: string; knowledgeBaseId: string; sessionId: string }): { success: boolean; error?: string } {
    const key = sessionKey(input.pluginId, input.knowledgeBaseId, input.sessionId)
    if (!this.sessions.has(key)) {
      return {
        success: false,
        error: `会话不存在: ${input.sessionId}`,
      }
    }

    this.sessions.delete(key)
    return { success: true }
  }

  getHistory(input: PluginDocumentChatHistoryInput): PluginDocumentChatHistoryResult {
    const key = sessionKey(input.pluginId, input.knowledgeBaseId, input.sessionId)
    const session = this.sessions.get(key)

    return {
      pluginId: input.pluginId,
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId: input.sessionId,
      messages: session ? session.messages.map((item) => ({ ...item })) : [],
    }
  }

  clearPluginSessions(pluginId: string): void {
    for (const [key, session] of this.sessions.entries()) {
      if (session.pluginId === pluginId) {
        this.sessions.delete(key)
      }
    }
  }

  private emit(event: PluginDocumentChatEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 监听器异常不影响主流程
      }
    }
  }
}

export const pluginDocumentChatBridge = new PluginDocumentChatBridge()
