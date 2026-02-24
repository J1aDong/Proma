import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type {
  PluginAiIndexChunkRecord,
  PluginAiIndexChunkStrategy,
  PluginAiIndexMetadata,
  PluginAiIndexSummary,
  PluginStartAiIndexingTaskInput,
  PluginTaskOperationResult,
} from '@proma/shared'
import { getAgentModelIdFromSettings } from '../settings-service'
import { pluginTaskRuntime } from './task-runtime'
import { getAdapter, streamSSE } from '@proma/core'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { getFetchFn } from '../proxy-fetch'
import { resolveChannelAndModel } from './model-resolution'

const INDEX_VERSION = 'plugin-ai-index-v1'
const DEFAULT_CHUNK_STRATEGY: PluginAiIndexChunkStrategy = {
  maxChunkChars: 1200,
  overlapChars: 120,
}
const VECTOR_DIMENSIONS = 64
const MAX_FILE_BYTES = 700 * 1024
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.txt',
  '.yml', '.yaml', '.toml', '.ini', '.sh', '.zsh', '.bash', '.go', '.rs', '.py',
  '.java', '.kt', '.swift', '.dart', '.vue', '.svelte', '.css', '.scss', '.less',
  '.html', '.xml', '.sql', '.proto', '.env', '.lock', '.tsx', '.tsx', '.tsx',
])
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.turbo', '.idea', '.vscode'])

interface KnowledgeBaseIndex {
  metadata: PluginAiIndexMetadata
  chunks: PluginAiIndexChunkRecord[]
}

interface ScanComputationResult {
  metadata: PluginAiIndexMetadata
  chunks: PluginAiIndexChunkRecord[]
  markdown: string
  reusedFiles: number
  rebuiltFiles: number
}

interface ResolvedPluginModel {
  model: string
  source: 'explicit' | 'agent-settings' | 'agent-default' | 'legacy-fallback'
}

function stableHash(input: string): string {
  return createHash('sha1').update(input).digest('hex')
}

function sanitizeKnowledgeBaseId(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized || 'default-kb'
}

function normalizeChunkStrategy(input?: Partial<PluginAiIndexChunkStrategy>): PluginAiIndexChunkStrategy {
  const maxChunkChars = input?.maxChunkChars && Number.isFinite(input.maxChunkChars)
    ? Math.max(200, Math.min(4000, Math.floor(input.maxChunkChars)))
    : DEFAULT_CHUNK_STRATEGY.maxChunkChars

  const overlapChars = input?.overlapChars && Number.isFinite(input.overlapChars)
    ? Math.max(0, Math.min(Math.floor(maxChunkChars / 2), Math.floor(input.overlapChars)))
    : DEFAULT_CHUNK_STRATEGY.overlapChars

  return {
    maxChunkChars,
    overlapChars,
  }
}

export function computeEmbedding(text: string): number[] {
  const digest = createHash('sha256').update(text).digest()
  const output = new Array<number>(VECTOR_DIMENSIONS)

  for (let i = 0; i < VECTOR_DIMENSIONS; i += 1) {
    const value = digest[i % digest.length] ?? 0
    output[i] = (value / 127.5) - 1
  }

  return output
}

function chunkText(content: string, strategy: PluginAiIndexChunkStrategy): string[] {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (normalized.length === 0) {
    return []
  }

  const chunks: string[] = []
  const step = Math.max(1, strategy.maxChunkChars - strategy.overlapChars)

  for (let cursor = 0; cursor < normalized.length; cursor += step) {
    const next = Math.min(normalized.length, cursor + strategy.maxChunkChars)
    const slice = normalized.slice(cursor, next).trim()
    if (slice.length > 0) {
      chunks.push(slice)
    }
    if (next >= normalized.length) {
      break
    }
  }

  return chunks
}

function getKnowledgeBaseRoot(workspacePath: string, knowledgeBaseId: string): string {
  return join(workspacePath, 'wiki', 'knowledge-bases', sanitizeKnowledgeBaseId(knowledgeBaseId))
}

function getKnowledgeBaseMetadataPath(workspacePath: string, knowledgeBaseId: string): string {
  return join(getKnowledgeBaseRoot(workspacePath, knowledgeBaseId), 'metadata.json')
}

function getKnowledgeBaseChunksPath(workspacePath: string, knowledgeBaseId: string): string {
  return join(getKnowledgeBaseRoot(workspacePath, knowledgeBaseId), 'chunks.json')
}

function getLatestKnowledgeBasePointerPath(workspacePath: string): string {
  return join(workspacePath, 'wiki', 'knowledge-bases', 'latest.json')
}

function getLatestMarkdownPath(workspacePath: string): string {
  return join(workspacePath, 'wiki', 'latest.md')
}

function getLatestJsonPath(workspacePath: string): string {
  return join(workspacePath, 'wiki', 'latest.json')
}

function getLatestIndexSummaryPath(workspacePath: string): string {
  return join(workspacePath, 'wiki', 'latest-index-summary.json')
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) {
    return null
  }

  try {
    const content = await readFile(path, 'utf-8')
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function isMetadataCompatible(
  metadata: PluginAiIndexMetadata | null,
  pluginId: string,
  knowledgeBaseId: string,
  model: string,
  strategy: PluginAiIndexChunkStrategy,
): metadata is PluginAiIndexMetadata {
  if (!metadata) {
    return false
  }

  return metadata.indexVersion === INDEX_VERSION
    && metadata.pluginId === pluginId
    && metadata.knowledgeBaseId === knowledgeBaseId
    && metadata.model === model
    && metadata.chunkStrategy.maxChunkChars === strategy.maxChunkChars
    && metadata.chunkStrategy.overlapChars === strategy.overlapChars
}

function extractTopLevelEntries(repositoryPath: string, filePaths: string[]): Array<{ name: string; type: 'dir' | 'file' }> {
  const entries = new Map<string, 'dir' | 'file'>()

  for (const filePath of filePaths) {
    const rel = relative(repositoryPath, filePath)
    if (!rel || rel.startsWith('..')) {
      continue
    }

    const [first, second] = rel.split('/')
    if (!first) {
      continue
    }

    if (second) {
      entries.set(first, 'dir')
    } else if (!entries.has(first)) {
      entries.set(first, 'file')
    }
  }

  return [...entries.entries()]
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 30)
}

async function generateRepositorySummary(
  model: string,
  language: 'zh' | 'en' | string | undefined,
  analysisDepth: 'standard' | 'deep' | string | undefined,
  repositoryPath: string,
  topLevelEntries: Array<{ name: string; type: 'dir' | 'file' }>,
  sampleFiles: string[]
): Promise<string> {
  const { channel, modelId: actualModelId, apiKey } = resolveChannelAndModel(model)

  const adapter = getAdapter(channel.provider)

  const topLines = topLevelEntries.length > 0
    ? topLevelEntries.map((entry) => `- [${entry.type === 'dir' ? 'DIR' : 'FILE'}] ${entry.name}`).join('\n')
    : '- (空)'

  const samples = sampleFiles.length > 0
    ? sampleFiles.map((item) => `- ${item}`).join('\n')
    : '- (无)'

  const langInstruction = language === 'en'
    ? 'Please answer in English.'
    : '请用中文回答。'

  const depthInstruction = analysisDepth === 'deep'
    ? '请生成一份深度的仓库洞察分析报告，必须包含以下四个章节：\n1. 仓库整体架构概述\n2. 关键模块目录功能与依赖关系信号\n3. 核心能力线索分析\n4. 潜在风险或待补充完善之处'
    : '请生成一份简洁的摘要，包含仓库的潜在用途、技术栈猜测以及目录结构概述。'

  const userMessage = [
    `请根据以下提供的代码仓库基本结构，生成仓库洞察报告。不要包含任何闲聊，仅输出分析内容。`,
    langInstruction,
    depthInstruction,
    '',
    `仓库路径：${repositoryPath}`,
    '',
    `## 顶层结构`,
    topLines,
    '',
    `## 样本文件列表`,
    samples,
  ].join('\n')

  const request = adapter.buildStreamRequest({
    baseUrl: channel.baseUrl,
    apiKey,
    modelId: actualModelId,
    history: [],
    userMessage,
    readImageAttachments: () => [],
    thinkingEnabled: false,
  })

  const proxyUrl = await getEffectiveProxyUrl()
  const fetchFn = getFetchFn(proxyUrl)

  let summary = ''

  await streamSSE({
    request,
    adapter,
    fetchFn,
    onEvent: (event) => {
      if (event.type === 'chunk') {
        summary += event.delta
      }
    }
  })

  return summary.trim()
}

function renderLatestMarkdown(input: {
  repositoryPath: string
  metadata: PluginAiIndexMetadata
  topLevelEntries: Array<{ name: string; type: 'dir' | 'file' }>
  sampleFiles: string[]
  aiSummary?: string
}): string {
  const isEn = input.metadata.language === 'en'

  const title = isEn ? 'Local Repository Wiki (AI Indexed)' : '本地仓库 Wiki（AI 索引版）'
  const summaryTitle = isEn ? '## 🤖 AI Repository Insight' : '## 🤖 AI 智能仓库洞察'
  const summaryDesc = isEn ? '> Generated based on deep repository scan' : '> 基于代码库全量扫描生成的深度分析报告'

  const statsTitle = isEn ? '## Indexing Statistics' : '## 扫描构建统计'
  const structTitle = isEn ? '## Top Level Structure' : '## 顶层结构'
  const samplesTitle = isEn ? '## Sample Files' : '## 样本文件'
  const metaTitle = isEn ? '## Indexing Metadata' : '## 索引元数据'

  const topLines = input.topLevelEntries.length > 0
    ? input.topLevelEntries.map((entry) => `- [${entry.type === 'dir' ? 'DIR' : 'FILE'}] ${entry.name}`).join('\n')
    : '- (空)'

  const samples = input.sampleFiles.length > 0
    ? input.sampleFiles.map((item) => `- ${item}`).join('\n')
    : '- (无)'

  const result = [
    `# ${title}`,
    '',
  ]

  if (input.aiSummary) {
    result.push(
      summaryTitle,
      summaryDesc,
      '',
      input.aiSummary,
      ''
    )
  }

  result.push(
    statsTitle,
    `- 仓库路径：\`${input.repositoryPath}\``,
    `- 文档库：\`${input.metadata.knowledgeBaseId}\``,
    `- 扫描模型：\`${input.metadata.model}\``,
    `- 索引版本：\`${input.metadata.indexVersion}\``,
    `- 生成时间：${input.metadata.generatedAt}`,
    `- 文件数：${input.metadata.totalFiles}`,
    `- 分块数：${input.metadata.totalChunks}`,
    `- 增量复用分块：${input.metadata.reusedChunks}`,
    `- 本次重建分块：${input.metadata.rebuiltChunks}`,
    '',
    structTitle,
    topLines,
    '',
    samplesTitle,
    samples,
    '',
    metaTitle,
    '```json',
    JSON.stringify(input.metadata, null, 2),
    '```',
  )

  return result.join('\n')
}

async function collectRepositoryFiles(
  repositoryPath: string,
  checkpoint: () => Promise<void>,
  onProgress: (processedDirs: number) => void,
): Promise<string[]> {
  const queue: string[] = [repositoryPath]
  const output: string[] = []
  let processedDirs = 0

  while (queue.length > 0) {
    await checkpoint()

    const current = queue.shift()
    if (!current) {
      continue
    }

    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    processedDirs += 1
    onProgress(processedDirs)

    for (const entry of entries) {
      const fullPath = resolve(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          queue.push(fullPath)
        }
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      const ext = extname(entry.name).toLowerCase()
      if (!TEXT_EXTENSIONS.has(ext) && entry.name !== 'README') {
        continue
      }

      output.push(fullPath)
    }
  }

  return output
}

async function collectEnabledModels(): Promise<string[]> {
  const { listChannels } = await import('../channel-manager')
  const channels = listChannels().filter((channel) => channel.enabled)
  const availableModels = channels
    .flatMap((channel) => channel.models)
    .filter((item) => item.enabled)
    .map((item) => item.id)

  return [...new Set(availableModels)].sort((a, b) => a.localeCompare(b))
}

function pickModelFromCandidate(candidate: string | undefined, availableModels: string[]): string | undefined {
  const normalized = candidate?.trim()
  if (!normalized) {
    return undefined
  }

  const exact = availableModels.find((modelId) => modelId === normalized)
  if (exact) {
    return exact
  }

  const lowerCandidate = normalized.toLowerCase()
  const caseInsensitive = availableModels.find((modelId) => modelId.toLowerCase() === lowerCandidate)
  if (caseInsensitive) {
    return caseInsensitive
  }

  const fuzzy = availableModels.find((modelId) => modelId.toLowerCase().includes(lowerCandidate))
  if (fuzzy) {
    return fuzzy
  }

  return undefined
}

function pickFirstAvailableModel(candidates: Array<string | undefined>, availableModels: string[]): string | undefined {
  for (const candidate of candidates) {
    const resolved = pickModelFromCandidate(candidate, availableModels)
    if (resolved) {
      return resolved
    }
  }

  return undefined
}

async function resolvePluginModel(model?: string): Promise<ResolvedPluginModel> {
  if (process.env.PROMA_PLUGIN_MODEL_VALIDATION_BYPASS === '1') {
    const fallback = model?.trim() || 'test-model'
    return {
      model: fallback,
      source: model?.trim() ? 'explicit' : 'agent-default',
    }
  }

  const availableModels = await collectEnabledModels()

  if (model && model.trim().length > 0) {
    const explicitModel = model.trim()
    if (!availableModels.includes(explicitModel)) {
      const preview = availableModels.slice(0, 10).join(', ')
      throw new Error(`模型不可用: ${explicitModel}。可用模型: ${preview || '无'}`)
    }

    return {
      model: explicitModel,
      source: 'explicit',
    }
  }

  if (availableModels.length === 0) {
    throw new Error('没有可用模型。请先在渠道配置中启用至少一个模型。')
  }

  const agentModel = getAgentModelIdFromSettings()
  const agentDefaultModel = 'claude-sonnet-4-5-20250929'

  const resolvedAgentModel = pickModelFromCandidate(agentModel, availableModels)
  const resolvedAgentDefaultModel = pickModelFromCandidate(agentDefaultModel, availableModels)
  const preferredModel = pickFirstAvailableModel([agentModel, agentDefaultModel], availableModels)

  if (preferredModel && resolvedAgentModel && preferredModel === resolvedAgentModel) {
    return {
      model: preferredModel,
      source: 'agent-settings',
    }
  }

  if (preferredModel && resolvedAgentDefaultModel && preferredModel === resolvedAgentDefaultModel) {
    return {
      model: preferredModel,
      source: 'agent-default',
    }
  }

  return {
    model: availableModels[0]!,
    source: 'legacy-fallback',
  }
}

export async function resolvePluginModelOrThrow(model?: string): Promise<string> {
  const resolved = await resolvePluginModel(model)
  console.log(`[插件索引] 模型解析来源: ${resolved.source}, model=${resolved.model}`)
  return resolved.model
}


async function computeScanResult(input: {
  pluginId: string
  workspacePath: string
  repositoryPath: string
  knowledgeBaseId: string
  model: string
  language: 'zh' | 'en' | string | undefined
  analysisDepth: 'standard' | 'deep' | string | undefined
  strategy: PluginAiIndexChunkStrategy
  checkpoint: () => Promise<void>
  reportProgress: (stage: string, percent: number, detail: string, processed?: number, total?: number) => void
}): Promise<ScanComputationResult> {
  const previousMetadata = await readJsonFile<PluginAiIndexMetadata>(
    getKnowledgeBaseMetadataPath(input.workspacePath, input.knowledgeBaseId),
  )
  const previousChunks = await readJsonFile<PluginAiIndexChunkRecord[]>(
    getKnowledgeBaseChunksPath(input.workspacePath, input.knowledgeBaseId),
  )

  const canReuse = isMetadataCompatible(
    previousMetadata,
    input.pluginId,
    input.knowledgeBaseId,
    input.model,
    input.strategy,
  )

  const previousChunkMap = new Map<string, PluginAiIndexChunkRecord[]>()
  if (canReuse && previousChunks) {
    for (const chunk of previousChunks) {
      const list = previousChunkMap.get(chunk.fileFingerprint) ?? []
      list.push(chunk)
      previousChunkMap.set(chunk.fileFingerprint, list)
    }
  }

  input.reportProgress('scan', 2, '正在遍历仓库目录...')
  const files = await collectRepositoryFiles(input.repositoryPath, input.checkpoint, (processedDirs) => {
    input.reportProgress('scan', 5, `已扫描目录: ${processedDirs}`, processedDirs)
  })

  const chunks: PluginAiIndexChunkRecord[] = []
  const fileFingerprints: Record<string, string> = {}
  const sampleFiles: string[] = []
  let reusedFiles = 0
  let rebuiltFiles = 0
  let reusedChunks = 0
  let rebuiltChunks = 0

  for (let index = 0; index < files.length; index += 1) {
    await input.checkpoint()

    const filePath = files[index]!
    const relPath = relative(input.repositoryPath, filePath)

    let fileStat
    try {
      fileStat = await stat(filePath)
    } catch {
      continue
    }

    if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) {
      continue
    }

    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      continue
    }

    if (!content.trim()) {
      continue
    }

    if (sampleFiles.length < 20) {
      sampleFiles.push(relPath)
    }

    const fileFingerprint = stableHash(`${relPath}|${content}`)
    fileFingerprints[relPath] = fileFingerprint

    const progressBase = 10 + (index / Math.max(1, files.length)) * 75
    input.reportProgress('chunk', progressBase, `处理文件: ${relPath}`, index + 1, files.length)

    const reusableChunks = previousChunkMap.get(fileFingerprint)
    if (reusableChunks && reusableChunks.length > 0) {
      reusedFiles += 1
      reusedChunks += reusableChunks.length
      chunks.push(...reusableChunks)
      continue
    }

    rebuiltFiles += 1
    const fileChunks = chunkText(content, input.strategy)
    for (let chunkIndex = 0; chunkIndex < fileChunks.length; chunkIndex += 1) {
      await input.checkpoint()
      const chunkContent = fileChunks[chunkIndex]!
      rebuiltChunks += 1

      chunks.push({
        id: `${relPath}:${chunkIndex}:${fileFingerprint.slice(0, 10)}`,
        filePath: relPath,
        fileFingerprint,
        chunkIndex,
        content: chunkContent,
        embedding: computeEmbedding(chunkContent),
      })
    }
  }

  const fingerprintInput = Object.keys(fileFingerprints)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}:${fileFingerprints[key]}`)
    .join('\n')

  const metadata: PluginAiIndexMetadata = {
    indexVersion: INDEX_VERSION,
    pluginId: input.pluginId,
    knowledgeBaseId: input.knowledgeBaseId,
    repositoryPath: input.repositoryPath,
    repositoryFingerprint: stableHash(fingerprintInput),
    model: input.model,
    language: input.language as PluginAiIndexMetadata['language'],
    analysisDepth: input.analysisDepth as PluginAiIndexMetadata['analysisDepth'],
    chunkStrategy: input.strategy,
    generatedAt: new Date().toISOString(),
    totalFiles: Object.keys(fileFingerprints).length,
    totalChunks: chunks.length,
    reusedChunks,
    rebuiltChunks,
    fileFingerprints,
  }

  input.reportProgress('summarize', 90, '正在生成 AI 摘要...')
  let aiSummary = ''
  try {
    aiSummary = await generateRepositorySummary(
      input.model,
      input.language,
      input.analysisDepth,
      input.repositoryPath,
      extractTopLevelEntries(input.repositoryPath, files),
      sampleFiles
    )
  } catch (error) {
    console.error('[插件索引] 生成 AI 摘要失败:', error)
  }

  const markdown = renderLatestMarkdown({
    repositoryPath: input.repositoryPath,
    metadata,
    topLevelEntries: extractTopLevelEntries(input.repositoryPath, files),
    sampleFiles,
    aiSummary
  })

  return {
    metadata,
    chunks,
    markdown,
    reusedFiles,
    rebuiltFiles,
  }
}

async function persistKnowledgeBase(input: {
  workspacePath: string
  knowledgeBaseId: string
  metadata: PluginAiIndexMetadata
  chunks: PluginAiIndexChunkRecord[]
  markdown: string
  reusedFiles: number
  rebuiltFiles: number
}): Promise<PluginAiIndexSummary> {
  const kbRoot = getKnowledgeBaseRoot(input.workspacePath, input.knowledgeBaseId)
  const metadataPath = getKnowledgeBaseMetadataPath(input.workspacePath, input.knowledgeBaseId)
  const chunksPath = getKnowledgeBaseChunksPath(input.workspacePath, input.knowledgeBaseId)
  const latestMarkdownPath = getLatestMarkdownPath(input.workspacePath)
  const latestJsonPath = getLatestJsonPath(input.workspacePath)
  const latestSummaryPath = getLatestIndexSummaryPath(input.workspacePath)
  const latestPointerPath = getLatestKnowledgeBasePointerPath(input.workspacePath)

  await mkdir(kbRoot, { recursive: true })
  await writeJsonFile(metadataPath, input.metadata)
  await writeJsonFile(chunksPath, input.chunks)

  await mkdir(dirname(latestMarkdownPath), { recursive: true })
  await writeFile(latestMarkdownPath, `${input.markdown}\n`, 'utf-8')

  const summary: PluginAiIndexSummary = {
    knowledgeBaseId: input.knowledgeBaseId,
    metadata: input.metadata,
    indexPath: chunksPath,
    markdownPath: latestMarkdownPath,
  }

  await writeJsonFile(latestSummaryPath, summary)
  await writeJsonFile(latestPointerPath, {
    knowledgeBaseId: input.knowledgeBaseId,
  })

  await writeJsonFile(latestJsonPath, {
    rootPath: input.metadata.repositoryPath,
    generatedAt: input.metadata.generatedAt,
    stats: {
      directories: -1,
      files: input.metadata.totalFiles,
      codeFiles: input.metadata.totalFiles,
    },
    topLevelEntries: [],
    sampleCodeFiles: input.chunks.slice(0, 20).map((chunk) => chunk.filePath),
    keyFiles: [],
    markdown: input.markdown,
    indexSummary: {
      knowledgeBaseId: input.knowledgeBaseId,
      model: input.metadata.model,
      indexVersion: input.metadata.indexVersion,
      repositoryFingerprint: input.metadata.repositoryFingerprint,
      generatedAt: input.metadata.generatedAt,
      totalChunks: input.metadata.totalChunks,
      reusedChunks: input.metadata.reusedChunks,
      rebuiltChunks: input.metadata.rebuiltChunks,
      reusedFiles: input.reusedFiles,
      rebuiltFiles: input.rebuiltFiles,
    },
  })

  return summary
}

export async function loadKnowledgeBaseIndex(
  pluginId: string,
  workspacePath: string,
  knowledgeBaseId: string,
  expectedModel?: string,
): Promise<KnowledgeBaseIndex> {
  const kbId = sanitizeKnowledgeBaseId(knowledgeBaseId)
  const metadata = await readJsonFile<PluginAiIndexMetadata>(
    getKnowledgeBaseMetadataPath(workspacePath, kbId),
  )
  const chunks = await readJsonFile<PluginAiIndexChunkRecord[]>(
    getKnowledgeBaseChunksPath(workspacePath, kbId),
  )

  if (!metadata || !chunks) {
    throw new Error(`知识库不可用: ${kbId}。请先完成扫描任务。`)
  }

  if (metadata.indexVersion !== INDEX_VERSION) {
    throw new Error(`索引版本不兼容: ${metadata.indexVersion}，需要 ${INDEX_VERSION}`)
  }

  if (metadata.pluginId !== pluginId) {
    throw new Error(`索引插件隔离校验失败: ${metadata.pluginId} != ${pluginId}`)
  }

  if (metadata.knowledgeBaseId !== kbId) {
    throw new Error(`索引知识库校验失败: ${metadata.knowledgeBaseId} != ${kbId}`)
  }

  if (expectedModel && metadata.model !== expectedModel) {
    throw new Error(`索引模型不匹配: 当前 ${metadata.model}，期望 ${expectedModel}`)
  }

  return {
    metadata,
    chunks,
  }
}

export async function getLatestIndexSummary(
  pluginId: string,
  workspacePath: string,
  knowledgeBaseId?: string,
): Promise<PluginAiIndexSummary | null> {
  if (knowledgeBaseId && knowledgeBaseId.trim()) {
    const kbId = sanitizeKnowledgeBaseId(knowledgeBaseId)
    const metadata = await readJsonFile<PluginAiIndexMetadata>(
      getKnowledgeBaseMetadataPath(workspacePath, kbId),
    )
    if (!metadata || metadata.pluginId !== pluginId) {
      return null
    }

    return {
      knowledgeBaseId: kbId,
      metadata,
      indexPath: getKnowledgeBaseChunksPath(workspacePath, kbId),
      markdownPath: getLatestMarkdownPath(workspacePath),
    }
  }

  const pointer = await readJsonFile<{ knowledgeBaseId: string }>(getLatestKnowledgeBasePointerPath(workspacePath))
  if (!pointer?.knowledgeBaseId) {
    return null
  }

  return getLatestIndexSummary(pluginId, workspacePath, pointer.knowledgeBaseId)
}

export async function startAiIndexingTask(input: {
  pluginId: string
  workspacePath: string
  payload: Omit<PluginStartAiIndexingTaskInput, 'pluginId'>
}): Promise<PluginTaskOperationResult> {
  const repositoryPath = resolve(input.payload.repositoryPath)
  const knowledgeBaseId = sanitizeKnowledgeBaseId(
    input.payload.knowledgeBaseId?.trim() || basename(repositoryPath),
  )
  const model = await resolvePluginModelOrThrow(input.payload.model)
  const strategy = normalizeChunkStrategy(input.payload.chunkStrategy)

  return pluginTaskRuntime.startTask(
    {
      pluginId: input.pluginId,
      taskType: 'ai-indexing-scan',
      metadata: {
        repositoryPath,
        knowledgeBaseId,
        model,
        language: input.payload.language,
        analysisDepth: input.payload.analysisDepth,
      },
    },
    async (taskContext) => {
      taskContext.reportProgress({
        stage: 'prepare',
        percent: 1,
        detail: '准备扫描任务...',
      })

      const result = await computeScanResult({
        pluginId: input.pluginId,
        workspacePath: input.workspacePath,
        repositoryPath,
        knowledgeBaseId,
        model,
        language: input.payload.language,
        analysisDepth: input.payload.analysisDepth,
        strategy,
        checkpoint: taskContext.checkpoint,
        reportProgress: (stage, percent, detail, processed, total) => {
          taskContext.reportProgress({
            stage,
            percent,
            detail,
            processed,
            total,
          })
        },
      })

      taskContext.reportProgress({
        stage: 'persist',
        percent: 92,
        detail: '正在写入索引文件...',
      })

      const summary = await persistKnowledgeBase({
        workspacePath: input.workspacePath,
        knowledgeBaseId,
        metadata: result.metadata,
        chunks: result.chunks,
        markdown: result.markdown,
        reusedFiles: result.reusedFiles,
        rebuiltFiles: result.rebuiltFiles,
      })

      taskContext.reportProgress({
        stage: 'done',
        percent: 100,
        detail: '扫描完成',
      })

      return {
        knowledgeBaseId,
        summary,
      }
    },
  )
}
