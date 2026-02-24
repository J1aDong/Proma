import { randomUUID } from 'node:crypto'
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

function splitIntoDeltas(content: string, segmentSize = 64): string[] {
  const output: string[] = []
  for (let cursor = 0; cursor < content.length; cursor += segmentSize) {
    output.push(content.slice(cursor, cursor + segmentSize))
  }
  return output
}

function buildAnswerText(input: {
  question: string
  knowledgeBaseId: string
  references: PluginDocumentChatReference[]
}): string {
  const bullets = input.references
    .map((item, index) => {
      return `${index + 1}. (${item.filePath}) ${item.snippet}`
    })
    .join('\n')

  return [
    `基于知识库 \`${input.knowledgeBaseId}\`，我检索了与问题最相关的片段。`,
    `问题：${input.question}`,
    '',
    bullets || '未检索到有效片段，请先重新扫描仓库。',
  ].join('\n')
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
      const references: PluginDocumentChatReference[] = knowledgeBase.chunks
        .map((chunk) => {
          return {
            chunkId: chunk.id,
            filePath: chunk.filePath,
            score: cosineSimilarity(queryEmbedding, chunk.embedding),
            snippet: chunk.content.slice(0, 220),
          }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)

      const systemMessage = buildAnswerText({
        question: userQuestion,
        knowledgeBaseId,
        references,
      })

      const assistantMessage: PluginDocumentChatMessage = {
        role: 'assistant',
        content: '',
        createdAt: nowIso(),
      }
      session.messages.push(assistantMessage)

      if (references.length > 0) {
        this.emit({
          type: 'citation',
          pluginId: input.pluginId,
          knowledgeBaseId,
          sessionId: normalizedSessionId,
          model: resolvedModel,
          references,
          timestamp: nowIso(),
        })
      }

      // 组装历史消息
      const historyForProvider = incomingMessages.slice(0, -1).map(msg => ({
        id: randomUUID(),
        role: msg.role === 'user' ? 'user' : 'assistant' as 'user' | 'assistant',
        content: msg.content,
        createdAt: new Date(msg.createdAt ?? nowIso()).getTime(),
      }))

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
