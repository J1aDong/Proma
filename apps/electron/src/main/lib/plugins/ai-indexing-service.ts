import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type {
  PluginAiIndexChunkRecord,
  PluginAiIndexChunkStrategy,
  PluginAiIndexMetadata,
  PluginAiScanMode,
  PluginAiIndexSummary,
  PluginStartAiIndexingTaskInput,
  PluginTaskOperationResult,
  PluginTaskSnapshot,
} from '@proma/shared'
import { getAgentModelIdFromSettings } from '../settings-service'
import { pluginTaskRuntime } from './task-runtime'
import { getAdapter, streamSSE } from '@proma/core'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { getFetchFn } from '../proxy-fetch'
import { resolveChannelAndModel } from './model-resolution'
import {
  appendWikiTaskEvent,
  applyWikiTaskSnapshot,
  createWikiTaskRecord,
  listRecoverableWikiTasks,
  persistWikiTaskArtifacts,
  updateWikiTaskRecord,
} from './wiki-task-persistence'

const INDEX_VERSION = 'plugin-ai-index-v1'
const DEFAULT_SCAN_MODE: PluginAiScanMode = 'smart'
const DEFAULT_SUBAGENT_COUNT = 4
const MAX_SUBAGENT_COUNT = 8
const DEFAULT_MAX_FILE_BYTES_FOR_FULL_ANALYZE = 700 * 1024
const WIKI_LOCAL_REPOSITORY_PLUGIN_ID = 'wiki-local-repository-plugin'
const DEFAULT_CHUNK_STRATEGY: PluginAiIndexChunkStrategy = {
  maxChunkChars: 1200,
  overlapChars: 120,
}
const VECTOR_DIMENSIONS = 64
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.txt',
  '.yml', '.yaml', '.toml', '.ini', '.sh', '.zsh', '.bash', '.go', '.rs', '.py',
  '.java', '.kt', '.swift', '.dart', '.vue', '.svelte', '.css', '.scss', '.less',
  '.html', '.xml', '.sql', '.proto', '.env', '.lock', '.tsx', '.tsx', '.tsx',
])
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.turbo', '.idea', '.vscode'])

let taskPersistenceBindingReady = false
const latestProgressFingerprintMap = new Map<string, string>()

interface RepositoryFileManifestItem {
  relPath: string
  size: number
  extension: string
  modifiedAt: string
  language: string
  isBinary: boolean
  canAnalyze: boolean
  skipReason?: string
}

interface RepositoryTextFile {
  relPath: string
  content: string
}

interface CoreFileClassification {
  core: string[]
  supporting: string[]
  peripheral: string[]
  modules: Array<{ name: string; files: string[] }>
}

interface SemanticTask {
  id: string
  name: string
  type: 'module' | 'batch'
  filePaths: string[]
}

interface SemanticTaskResult {
  taskId: string
  name: string
  type: 'module' | 'batch'
  summary: string
  keyFlows: string[]
  risks: string[]
  evidence: string[]
}

interface WikiPageArtifact {
  id: string
  title: string
  path: string
  content: string
}

interface KnowledgeBaseIndex {
  metadata: PluginAiIndexMetadata
  chunks: PluginAiIndexChunkRecord[]
}

interface ScanComputationResult {
  metadata: PluginAiIndexMetadata
  chunks: PluginAiIndexChunkRecord[]
  markdown: string
  pages: WikiPageArtifact[]
  reusedFiles: number
  rebuiltFiles: number
}

interface ResolvedPluginModel {
  model: string
  source: 'explicit' | 'agent-settings' | 'agent-default' | 'legacy-fallback'
}

interface KeyFileInsight {
  filePath: string
  reason: string
  excerpt: string
}

interface DirectoryInsight {
  name: string
  fileCount: number
  chunkCount: number
}

interface FileContentClue {
  filePath: string
  symbols: string[]
  snippet: string
}

interface ArchitectureTopologyLayer {
  name: string
  modules: string[]
}

interface ArchitectureTopologyDependency {
  from: string
  to: string
  reason: string
}

interface ArchitectureTopologyFlow {
  name: string
  steps: string[]
}

interface ArchitectureTopology {
  layers: ArchitectureTopologyLayer[]
  dependencies: ArchitectureTopologyDependency[]
  criticalFlows: ArchitectureTopologyFlow[]
  entryModules: string[]
}

function nowIso(): string {
  return new Date().toISOString()
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

function normalizeScanMode(mode: PluginAiScanMode | string | undefined): PluginAiScanMode {
  return mode === 'full' ? 'full' : DEFAULT_SCAN_MODE
}

function normalizeSubagentCount(raw: number | undefined): number {
  const numeric = typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SUBAGENT_COUNT
  }

  return Math.max(1, Math.min(MAX_SUBAGENT_COUNT, Math.floor(numeric)))
}

function normalizeMaxFileBytes(raw: number | undefined): number {
  const numeric = typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(numeric)) {
    return DEFAULT_MAX_FILE_BYTES_FOR_FULL_ANALYZE
  }

  return Math.max(128 * 1024, Math.min(8 * 1024 * 1024, Math.floor(numeric)))
}

function buildProgressFingerprint(progress: PluginTaskSnapshot['progress']): string {
  if (!progress) {
    return ''
  }
  return `${progress.stage}|${Math.round(progress.percent)}|${progress.detail ?? ''}`
}

function bindTaskPersistenceListener(): void {
  if (taskPersistenceBindingReady) {
    return
  }

  taskPersistenceBindingReady = true
  pluginTaskRuntime.onEvent((event) => {
    if (event.task.taskType !== 'ai-indexing-scan') {
      return
    }

    const taskId = event.task.taskId
    const nextFingerprint = buildProgressFingerprint(event.task.progress)
    const prevFingerprint = latestProgressFingerprintMap.get(taskId) ?? ''
    const shouldPersistProgress = event.type !== 'progress' || nextFingerprint !== prevFingerprint
    if (!shouldPersistProgress) {
      return
    }

    latestProgressFingerprintMap.set(taskId, nextFingerprint)

    void (async () => {
      await applyWikiTaskSnapshot(event.task)
      await appendWikiTaskEvent({
        taskId,
        type: event.type,
        timestamp: event.timestamp,
        task: event.task,
      })

      if (
        event.type === 'completed'
        || event.type === 'failed'
        || event.type === 'stopped'
      ) {
        latestProgressFingerprintMap.delete(taskId)
      }
    })().catch((error) => {
      console.warn('[插件索引] 写入任务持久化事件失败:', error)
    })
  })
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

function getKnowledgeBaseMarkdownPath(workspacePath: string, knowledgeBaseId: string): string {
  return join(getKnowledgeBaseRoot(workspacePath, knowledgeBaseId), 'latest.md')
}

function getKnowledgeBasePagesRoot(workspacePath: string, knowledgeBaseId: string): string {
  return join(getKnowledgeBaseRoot(workspacePath, knowledgeBaseId), 'pages')
}

function getKnowledgeBasePagePath(workspacePath: string, knowledgeBaseId: string, pageId: string): string {
  return join(getKnowledgeBasePagesRoot(workspacePath, knowledgeBaseId), `${pageId}.md`)
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

function getWikiPagesRoot(workspacePath: string): string {
  return join(workspacePath, 'wiki', 'pages')
}

function getWikiPagePath(workspacePath: string, pageId: string): string {
  return join(getWikiPagesRoot(workspacePath), `${pageId}.md`)
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

function extractSnippet(content: string, maxChars = 360): string {
  const normalized = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 8)
    .join('\n')

  if (normalized.length <= maxChars) {
    return normalized
  }

  return `${normalized.slice(0, maxChars)}...`
}

function extractSymbolHints(content: string, limit = 8): string[] {
  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_][\w$]*)/g,
    /\bfunction\s+([A-Za-z_][\w$]*)\s*\(/g,
    /\bclass\s+([A-Za-z_][\w$]*)/g,
    /\binterface\s+([A-Za-z_][\w$]*)/g,
    /\bconst\s+([A-Za-z_][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    /\btype\s+([A-Za-z_][\w$]*)\s*=/g,
  ]

  const dedup = new Set<string>()
  for (const pattern of patterns) {
    let matched = pattern.exec(content)
    while (matched) {
      const symbol = matched[1]?.trim()
      if (symbol) {
        dedup.add(symbol)
      }
      if (dedup.size >= limit) {
        return [...dedup]
      }
      matched = pattern.exec(content)
    }
  }

  return [...dedup]
}

function buildFileContentClues(input: {
  textFiles: RepositoryTextFile[]
  keyFiles: KeyFileInsight[]
}): FileContentClue[] {
  const textFileMap = new Map(input.textFiles.map((item) => [item.relPath, item.content]))
  const selected = new Set<string>()
  const output: FileContentClue[] = []

  const append = (filePath: string): void => {
    if (selected.has(filePath) || output.length >= 30) {
      return
    }

    const content = textFileMap.get(filePath)
    if (!content) {
      return
    }

    selected.add(filePath)
    output.push({
      filePath,
      symbols: extractSymbolHints(content, 10),
      snippet: extractSnippet(content, 520),
    })
  }

  for (const keyFile of input.keyFiles) {
    append(keyFile.filePath)
  }

  for (const file of input.textFiles) {
    if (output.length >= 30) {
      break
    }

    const lower = file.relPath.toLowerCase()
    if (
      lower.includes('/src/')
      || lower.includes('/app/')
      || lower.endsWith('/main.ts')
      || lower.endsWith('/main.tsx')
      || lower.endsWith('/index.ts')
      || lower.endsWith('/index.tsx')
    ) {
      append(file.relPath)
    }
  }

  for (const file of input.textFiles) {
    if (output.length >= 30) {
      break
    }
    append(file.relPath)
  }

  return output
}

function getKeyFileReason(relPath: string): string | null {
  const normalized = relPath.toLowerCase()

  if (normalized === 'readme.md' || normalized === 'readme') {
    return '项目入口与定位'
  }
  if (normalized === 'package.json') {
    return 'JavaScript 依赖与脚本'
  }
  if (normalized === 'bun.lock' || normalized === 'bun.lockb') {
    return 'Bun 依赖锁定文件'
  }
  if (normalized === 'tsconfig.json') {
    return 'TypeScript 编译配置'
  }
  if (normalized.endsWith('/vite.config.ts') || normalized.endsWith('/vite.config.js')) {
    return '前端构建配置'
  }
  if (normalized.endsWith('/electron-builder.yml') || normalized.endsWith('/electron-builder.yaml')) {
    return '桌面应用打包配置'
  }
  if (normalized === 'requirements.txt' || normalized === 'pyproject.toml') {
    return 'Python 依赖与项目配置'
  }
  if (normalized === 'cargo.toml') {
    return 'Rust 依赖与项目配置'
  }
  if (normalized.endsWith('/main.ts') || normalized.endsWith('/main.tsx')) {
    return '主入口或核心启动流程'
  }
  if (normalized.includes('/src/main/')) {
    return '主进程核心逻辑'
  }
  if (normalized.includes('/src/renderer/')) {
    return '渲染层核心逻辑'
  }
  if (normalized.includes('/src/components/') || normalized.includes('/components/')) {
    return 'UI 组件实现'
  }
  if (normalized.includes('/src/lib/') || normalized.includes('/lib/')) {
    return '基础能力或服务封装'
  }
  if (normalized.includes('/docs/')) {
    return '项目文档与设计说明'
  }

  return null
}

function inferLanguageByExtension(extension: string): string {
  const ext = extension.toLowerCase()
  if (ext === '.ts' || ext === '.tsx') return 'TypeScript'
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'JavaScript'
  if (ext === '.rs') return 'Rust'
  if (ext === '.py') return 'Python'
  if (ext === '.go') return 'Go'
  if (ext === '.java') return 'Java'
  if (ext === '.kt') return 'Kotlin'
  if (ext === '.swift') return 'Swift'
  if (ext === '.dart') return 'Dart'
  if (ext === '.vue') return 'Vue'
  if (ext === '.svelte') return 'Svelte'
  if (ext === '.css' || ext === '.scss' || ext === '.less') return 'CSS'
  if (ext === '.html' || ext === '.xml') return 'Markup'
  if (ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.toml' || ext === '.ini') return 'Config'
  if (ext === '.md' || ext === '.mdx' || ext === '.txt') return 'Docs'
  return ext ? ext.replace('.', '').toUpperCase() : 'Unknown'
}

function wildcardPatternToRegExp(pattern: string): RegExp | null {
  const normalized = pattern.trim().replace(/\\/g, '/')
  if (!normalized) {
    return null
  }

  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const regexBody = escaped
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  const anchored = normalized.startsWith('/')
    ? `^${regexBody.slice(1)}$`
    : `(^|.*/)${regexBody}$`

  try {
    return new RegExp(anchored)
  } catch {
    return null
  }
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '')
}

function isIgnoredByGitignore(relPath: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false
  }

  const normalized = normalizeRelPath(relPath)
  let ignored = false

  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim()
    if (!pattern || pattern.startsWith('#')) {
      continue
    }

    const isNegated = pattern.startsWith('!')
    const testPattern = isNegated ? pattern.slice(1) : pattern
    if (!testPattern) {
      continue
    }

    let matched = false

    if (testPattern.endsWith('/')) {
      const dirPattern = normalizeRelPath(testPattern.slice(0, -1))
      matched = normalized === dirPattern || normalized.startsWith(`${dirPattern}/`)
    } else if (!testPattern.includes('*') && !testPattern.includes('?')) {
      const plainPattern = normalizeRelPath(testPattern)
      if (plainPattern.includes('/')) {
        matched = normalized === plainPattern || normalized.startsWith(`${plainPattern}/`)
      } else {
        const segments = normalized.split('/')
        matched = segments.includes(plainPattern)
      }
    } else {
      const patternRegex = wildcardPatternToRegExp(testPattern)
      matched = patternRegex ? patternRegex.test(normalized) : false
    }

    if (matched) {
      ignored = !isNegated
    }
  }

  return ignored
}

async function readGitignorePatterns(repositoryPath: string): Promise<string[]> {
  const gitignorePath = join(repositoryPath, '.gitignore')
  if (!existsSync(gitignorePath)) {
    return []
  }

  try {
    const content = await readFile(gitignorePath, 'utf-8')
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  } catch {
    return []
  }
}

function selectTopLanguages(extensionCounts: Record<string, number>, limit = 8): Array<{ ext: string; count: number }> {
  return Object.entries(extensionCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ext, count]) => ({ ext, count }))
}

function buildDirectoryInsights(
  directoryFileCountMap: Record<string, number>,
  directoryChunkCountMap: Record<string, number>,
  limit = 10,
): DirectoryInsight[] {
  return Object.keys(directoryFileCountMap)
    .map((name) => ({
      name,
      fileCount: directoryFileCountMap[name] ?? 0,
      chunkCount: directoryChunkCountMap[name] ?? 0,
    }))
    .sort((a, b) => b.fileCount - a.fileCount)
    .slice(0, limit)
}

function appendUniqueSignals(target: Set<string>, entries: string[], limit = 20): void {
  for (const item of entries) {
    if (target.size >= limit) {
      break
    }
    const normalized = item.trim()
    if (!normalized) {
      continue
    }
    target.add(normalized)
  }
}

function extractPackageJsonSignals(content: string): { dependencies: string[]; scripts: string[] } {
  try {
    const parsed = JSON.parse(content) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      scripts?: Record<string, string>
    }
    const dependencies = [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ].slice(0, 30)
    const scripts = Object.keys(parsed.scripts ?? {}).slice(0, 20)
    return { dependencies, scripts }
  } catch {
    return { dependencies: [], scripts: [] }
  }
}

function extractRequirementsSignals(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split(/[=<>!~]/)[0]?.trim() ?? '')
    .filter((line) => line.length > 0)
    .slice(0, 25)
}

function extractCargoSignals(content: string): string[] {
  const lines = content.split(/\r?\n/)
  const deps: string[] = []
  let inDepsBlock = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inDepsBlock = trimmed === '[dependencies]'
      continue
    }
    if (!inDepsBlock || !trimmed || trimmed.startsWith('#')) {
      continue
    }

    const key = trimmed.split('=')[0]?.trim()
    if (key) {
      deps.push(key)
    }
    if (deps.length >= 25) {
      break
    }
  }

  return deps
}

function renderFallbackRepositorySummary(input: {
  repositoryPath: string
  language: 'zh' | 'en' | string | undefined
  analysisDepth: 'standard' | 'deep' | string | undefined
  topLanguages: Array<{ ext: string; count: number }>
  directoryInsights: DirectoryInsight[]
  keyFiles: KeyFileInsight[]
  dependencySignals: string[]
  commandSignals: string[]
  sampleFiles: string[]
}): string {
  const isEn = input.language === 'en'
  const moduleNodes = input.directoryInsights.slice(0, 6)
  const langLine = input.topLanguages.length > 0
    ? input.topLanguages.map((item) => `${item.ext}(${item.count})`).join(' / ')
    : isEn ? 'Unknown' : '未知'
  const depLine = input.dependencySignals.length > 0
    ? input.dependencySignals.slice(0, 12).join(', ')
    : isEn ? 'Not detected' : '未检测到明显依赖信号'

  const commandLine = input.commandSignals.length > 0
    ? input.commandSignals.slice(0, 10).map((script) => `- \`${script}\``).join('\n')
    : isEn ? '- Not detected' : '- 未检测到脚本命令'

  const directoryLines = input.directoryInsights.length > 0
    ? input.directoryInsights
      .slice(0, 10)
      .map((item) => `- \`${item.name}\`：${item.fileCount} files / ${item.chunkCount} chunks`)
      .join('\n')
    : '- (empty)'

  const keyFileLines = input.keyFiles.length > 0
    ? input.keyFiles
      .slice(0, 8)
      .map((item) => `### \`${item.filePath}\`\n- ${item.reason}\n\n\`\`\`text\n${item.excerpt || '(empty)'}\n\`\`\``)
      .join('\n\n')
    : isEn ? 'No representative files captured.' : '未捕获到代表性文件片段。'

  const sampleLines = input.sampleFiles.length > 0
    ? input.sampleFiles.slice(0, 15).map((file) => `- ${file}`).join('\n')
    : '- (none)'

  const graphLines = [
    '```mermaid',
    'graph TD',
    `Repo["${basename(input.repositoryPath)}"]`,
    ...moduleNodes.map((item, index) => `Repo --> M${index}["${item.name} (${item.fileCount})"]`),
    '```',
  ].join('\n')

  if (isEn) {
    return [
      '## Repository Positioning',
      `- Path: \`${input.repositoryPath}\``,
      `- Analysis depth: \`${input.analysisDepth ?? 'standard'}\``,
      `- Language signals: ${langLine}`,
      `- Dependency signals: ${depLine}`,
      '',
      '## Architecture Map',
      graphLines,
      '',
      '## Core Modules',
      directoryLines,
      '',
      '## Representative Files',
      keyFileLines,
      '',
      '## Runtime Scripts',
      commandLine,
      '',
      '## Sample Files',
      sampleLines,
      '',
      '## Risks & Next Steps',
      '- The summary falls back to deterministic extraction because AI summarization is unavailable.',
      '- Recommend enabling a stronger model and increasing analysis depth for richer semantic understanding.',
    ].join('\n')
  }

  return [
    '## 仓库定位',
    `- 路径：\`${input.repositoryPath}\``,
    `- 分析深度：\`${input.analysisDepth ?? 'standard'}\``,
    `- 语言信号：${langLine}`,
    `- 依赖信号：${depLine}`,
    '',
    '## 架构总览',
    graphLines,
    '',
    '## 核心模块',
    directoryLines,
    '',
    '## 代表性文件',
    keyFileLines,
    '',
    '## 运行命令线索',
    commandLine,
    '',
    '## 样本文件',
    sampleLines,
    '',
    '## 风险与建议',
    '- 当前为规则提取回退结果，语义层面的推断能力有限。',
    '- 建议启用可用的大模型并使用深度模式，获得更接近 DeepWiki 的分析质量。',
  ].join('\n')
}

function isSummaryQualified(summary: string, analysisDepth: 'standard' | 'deep' | string | undefined): boolean {
  const normalized = summary.trim()
  if (normalized.length === 0) {
    return false
  }

  const headingCount = (normalized.match(/^##\s+/gm) ?? []).length
  const hasMermaid = normalized.includes('```mermaid')

  if (analysisDepth === 'deep') {
    return normalized.length >= 800 && headingCount >= 4 && hasMermaid
  }

  return normalized.length >= 300 && headingCount >= 2
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
  sampleFiles: string[],
  directoryInsights: DirectoryInsight[],
  topLanguages: Array<{ ext: string; count: number }>,
  keyFiles: KeyFileInsight[],
  dependencySignals: string[],
  commandSignals: string[],
): Promise<string> {
  const { channel, modelId: actualModelId, apiKey } = resolveChannelAndModel(model)
  console.log(`[插件索引] 开始调用 AI 生成仓库文档: channel=${channel.id}, provider=${channel.provider}, model=${actualModelId}`)

  const adapter = getAdapter(channel.provider)

  const topLines = topLevelEntries.length > 0
    ? topLevelEntries.map((entry) => `- [${entry.type === 'dir' ? 'DIR' : 'FILE'}] ${entry.name}`).join('\n')
    : '- (空)'

  const samples = sampleFiles.length > 0
    ? sampleFiles.map((item) => `- ${item}`).join('\n')
    : '- (无)'

  const directoryLines = directoryInsights.length > 0
    ? directoryInsights.map((item) => `- ${item.name}: files=${item.fileCount}, chunks=${item.chunkCount}`).join('\n')
    : '- (无)'

  const languageLines = topLanguages.length > 0
    ? topLanguages.map((item) => `- ${item.ext}: ${item.count}`).join('\n')
    : '- (无)'

  const keyFileLines = keyFiles.length > 0
    ? keyFiles
      .slice(0, 12)
      .map((item) => [
        `### ${item.filePath}`,
        `- 作用猜测：${item.reason}`,
        '```text',
        item.excerpt || '(empty)',
        '```',
      ].join('\n'))
      .join('\n\n')
    : '- (无)'

  const dependencyLines = dependencySignals.length > 0
    ? dependencySignals.slice(0, 25).map((item) => `- ${item}`).join('\n')
    : '- (无)'

  const commandLines = commandSignals.length > 0
    ? commandSignals.slice(0, 20).map((item) => `- ${item}`).join('\n')
    : '- (无)'

  const langInstruction = language === 'en'
    ? 'Please answer in English and keep all section headers in English.'
    : '请用中文回答。'

  const depthInstruction = analysisDepth === 'deep'
    ? '请输出接近 DeepWiki 风格的仓库文档，内容要具体，强调架构、模块职责、运行链路、配置与风险。'
    : '请输出实用的仓库 Wiki 摘要，覆盖项目定位、主要模块、运行方式与风险。'

  const styleInstruction = language === 'en'
    ? [
      'Output markdown only.',
      'Required sections (in this order):',
      '1. Repository Purpose',
      '2. Architecture Overview (must include a mermaid graph)',
      '3. Core Modules (table: module | responsibility | key files | dependency signals)',
      '4. Key Execution Flows',
      '5. Configuration and Runtime',
      '6. Risks and Improvement Suggestions',
      '7. Evidence Index (list quoted files)',
      'Only infer from provided evidence; mark uncertain claims as assumptions.',
    ].join('\n')
    : [
      '只输出 Markdown 正文。',
      '必须按顺序包含以下章节：',
      '1. 仓库定位与目标',
      '2. 架构总览（必须包含 mermaid 图）',
      '3. 核心模块（表格：模块 | 职责 | 关键文件 | 依赖信号）',
      '4. 关键执行流',
      '5. 配置与运行方式',
      '6. 风险与改进建议',
      '7. 证据索引（列出引用到的文件）',
      '只能基于已给材料推断，不确定的结论请显式标注为假设。',
    ].join('\n')

  const userMessage = [
    '你是资深代码库分析助手，请根据输入材料生成可读性强的工程 Wiki。',
    langInstruction,
    depthInstruction,
    styleInstruction,
    '',
    `仓库路径：${repositoryPath}`,
    '',
    `## 顶层结构`,
    topLines,
    '',
    '## 目录规模信号',
    directoryLines,
    '',
    '## 语言信号（按文件数）',
    languageLines,
    '',
    '## 依赖信号',
    dependencyLines,
    '',
    '## 脚本命令信号',
    commandLines,
    '',
    `## 样本文件列表`,
    samples,
    '',
    '## 关键文件片段',
    keyFileLines,
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

  const normalizedSummary = summary.trim()
  console.log(`[插件索引] AI 文档生成结束: length=${normalizedSummary.length}`)
  return normalizedSummary
}

function renderLatestMarkdown(input: {
  repositoryPath: string
  metadata: PluginAiIndexMetadata
  topLevelEntries: Array<{ name: string; type: 'dir' | 'file' }>
  sampleFiles: string[]
  aiSummary?: string
}): string {
  const isEn = input.metadata.language === 'en'

  const title = isEn ? 'Local Repository Wiki' : '本地仓库 Wiki'
  const summaryTitle = isEn ? '## 🤖 AI Repository Insight' : '## 🤖 AI 智能仓库洞察'
  const summaryDesc = isEn ? '> Generated based on deep repository scan' : '> 基于代码库全量扫描生成的深度分析报告'

  const statsTitle = isEn ? '## Indexing Statistics' : '## 扫描构建统计'
  const structTitle = isEn ? '## Top Level Structure' : '## 顶层结构'
  const samplesTitle = isEn ? '## Sample Files' : '## 样本文件'

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
  )

  return result.join('\n')
}

async function collectRepositoryManifest(input: {
  repositoryPath: string
  scanMode: PluginAiScanMode
  maxFileBytesForFullAnalyze: number
  checkpoint: () => Promise<void>
  onProgress: (processedDirs: number) => void
}): Promise<{ manifest: RepositoryFileManifestItem[]; textFiles: RepositoryTextFile[] }> {
  const queue: string[] = [input.repositoryPath]
  const manifest: RepositoryFileManifestItem[] = []
  const textFiles: RepositoryTextFile[] = []
  let processedDirs = 0

  const gitignorePatterns = input.scanMode === 'smart'
    ? await readGitignorePatterns(input.repositoryPath)
    : []

  while (queue.length > 0) {
    await input.checkpoint()

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
    input.onProgress(processedDirs)

    for (const entry of entries) {
      const fullPath = resolve(current, entry.name)
      const relPath = normalizeRelPath(relative(input.repositoryPath, fullPath))
      if (!relPath || relPath.startsWith('..')) {
        continue
      }

      if (entry.isDirectory()) {
        if (entry.name === '.git') {
          continue
        }

        if (input.scanMode === 'smart') {
          if (SKIP_DIRS.has(entry.name)) {
            continue
          }
          if (isIgnoredByGitignore(relPath, gitignorePatterns)) {
            continue
          }
        }

        queue.push(fullPath)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      if (input.scanMode === 'smart' && isIgnoredByGitignore(relPath, gitignorePatterns)) {
        continue
      }

      let fileStat
      try {
        fileStat = await stat(fullPath)
      } catch {
        continue
      }

      if (!fileStat.isFile()) {
        continue
      }

      const extension = extname(relPath).toLowerCase()
      const isTextByExt = TEXT_EXTENSIONS.has(extension)
        || relPath.toLowerCase().endsWith('/readme')
        || relPath.toLowerCase() === 'readme'

      let skipReason: string | undefined
      let isBinary = !isTextByExt
      let canAnalyze = isTextByExt

      if (fileStat.size > input.maxFileBytesForFullAnalyze) {
        canAnalyze = false
        skipReason = 'too-large'
      }

      if (canAnalyze) {
        try {
          const buffer = await readFile(fullPath)
          const head = buffer.subarray(0, Math.min(4096, buffer.length))
          isBinary = head.includes(0)

          if (isBinary) {
            canAnalyze = false
            skipReason = 'binary'
          } else {
            const content = buffer.toString('utf-8')
            if (content.trim().length === 0) {
              canAnalyze = false
              skipReason = 'empty'
            } else {
              textFiles.push({
                relPath,
                content,
              })
            }
          }
        } catch {
          canAnalyze = false
          skipReason = 'unreadable'
        }
      } else if (!skipReason) {
        skipReason = isTextByExt ? 'filtered' : 'non-text'
      }

      manifest.push({
        relPath,
        size: fileStat.size,
        extension: extension || '(no-ext)',
        modifiedAt: fileStat.mtime.toISOString(),
        language: inferLanguageByExtension(extension),
        isBinary,
        canAnalyze,
        skipReason,
      })
    }
  }

  manifest.sort((a, b) => a.relPath.localeCompare(b.relPath))
  textFiles.sort((a, b) => a.relPath.localeCompare(b.relPath))

  return {
    manifest,
    textFiles,
  }
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
    const explicitModelId = explicitModel.includes(':')
      ? explicitModel.split(':').slice(1).join(':')
      : explicitModel

    if (!availableModels.includes(explicitModelId)) {
      const preview = availableModels.slice(0, 10).join(', ')
      throw new Error(`模型不可用: ${explicitModelId}。可用模型: ${preview || '无'}`)
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

function extractJsonObjectFromText<T>(raw: string): T | null {
  const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/i)
  const candidate = fencedMatch?.[1] ?? raw
  const trimmed = candidate.trim()
  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed) as T
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) {
      return null
    }

    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T
    } catch {
      return null
    }
  }
}

async function invokeModelToText(input: {
  model: string
  userMessage: string
}): Promise<string> {
  const { channel, modelId: actualModelId, apiKey } = resolveChannelAndModel(input.model)
  const adapter = getAdapter(channel.provider)
  const request = adapter.buildStreamRequest({
    baseUrl: channel.baseUrl,
    apiKey,
    modelId: actualModelId,
    history: [],
    userMessage: input.userMessage,
    readImageAttachments: () => [],
    thinkingEnabled: false,
  })

  const proxyUrl = await getEffectiveProxyUrl()
  const fetchFn = getFetchFn(proxyUrl)

  let output = ''
  await streamSSE({
    request,
    adapter,
    fetchFn,
    onEvent: (event) => {
      if (event.type === 'chunk') {
        output += event.delta
      }
    },
  })

  return output.trim()
}

function buildManifestDigest(manifest: RepositoryFileManifestItem[]): string {
  if (manifest.length === 0) {
    return '- (空仓库)'
  }

  return manifest
    .slice(0, 400)
    .map((file) => [
      `path=${file.relPath}`,
      `size=${file.size}`,
      `lang=${file.language}`,
      `analyzable=${file.canAnalyze ? 'yes' : 'no'}`,
      `skip=${file.skipReason ?? '-'}`,
    ].join(', '))
    .join('\n')
}

async function classifyRepositoryFiles(input: {
  model: string
  language: 'zh' | 'en' | string | undefined
  repositoryPath: string
  manifest: RepositoryFileManifestItem[]
  contentClues: FileContentClue[]
  dependencySignals: string[]
  commandSignals: string[]
}): Promise<CoreFileClassification> {
  const langInstruction = input.language === 'en'
    ? 'Respond in English.'
    : '请用中文输出。'

  const clueBlocks = input.contentClues.length > 0
    ? input.contentClues
      .slice(0, 24)
      .map((item) => {
        const symbolLine = item.symbols.length > 0 ? item.symbols.join(', ') : '-'
        return [
          `### ${item.filePath}`,
          `symbols: ${symbolLine}`,
          '```text',
          item.snippet,
          '```',
        ].join('\n')
      })
      .join('\n\n')
    : '- (无内容线索)'

  const dependencyLines = input.dependencySignals.length > 0
    ? input.dependencySignals.slice(0, 30).map((item) => `- ${item}`).join('\n')
    : '- (无依赖信号)'

  const commandLines = input.commandSignals.length > 0
    ? input.commandSignals.slice(0, 20).map((item) => `- ${item}`).join('\n')
    : '- (无命令信号)'

  const userMessage = [
    '你是代码库分析规划器。请从文件清单中识别核心文件并输出 JSON。',
    langInstruction,
    '输出 JSON schema:',
    '{ "core": string[], "supporting": string[], "peripheral": string[], "modules": [{"name": string, "files": string[]}] }',
    '规则：',
    '- core 只保留最关键实现（入口、运行链路、核心域模型、关键配置）；',
    '- supporting 是支撑实现；',
    '- peripheral 是边缘资产；',
    '- modules 请按语义模块分组，文件路径必须来自清单；',
    '- 优先结合文件内容线索、符号和依赖信号，禁止仅靠文件名分组；',
    '- 禁止输出解释文字，只输出 JSON。',
    '',
    `仓库路径：${input.repositoryPath}`,
    '文件清单：',
    buildManifestDigest(input.manifest),
    '',
    '依赖信号：',
    dependencyLines,
    '',
    '运行命令信号：',
    commandLines,
    '',
    '文件内容线索：',
    clueBlocks,
  ].join('\n')

  const output = await invokeModelToText({
    model: input.model,
    userMessage,
  })

  const parsed = extractJsonObjectFromText<CoreFileClassification>(output)
  if (!parsed) {
    throw new Error('核心文件分类失败：模型未返回合法 JSON')
  }

  const available = new Set(input.manifest.map((item) => item.relPath))
  const sanitizePaths = (list: string[] | undefined): string[] => {
    if (!Array.isArray(list)) {
      return []
    }

    return [...new Set(list.map((item) => item.trim()).filter((item) => item && available.has(item)))]
  }

  const core = sanitizePaths(parsed.core)
  const supporting = sanitizePaths(parsed.supporting)
  const peripheral = sanitizePaths(parsed.peripheral)
  const modules = Array.isArray(parsed.modules)
    ? parsed.modules
      .map((module) => ({
        name: typeof module?.name === 'string' && module.name.trim().length > 0
          ? module.name.trim()
          : '未命名模块',
        files: sanitizePaths(Array.isArray(module?.files) ? module.files : []),
      }))
      .filter((module) => module.files.length > 0)
    : []

  if (core.length === 0 && supporting.length === 0) {
    throw new Error('核心文件分类失败：未识别到可分析文件')
  }

  return {
    core,
    supporting,
    peripheral,
    modules,
  }
}

function buildSemanticTasks(input: {
  classification: CoreFileClassification
  analyzableFileSet: Set<string>
}): SemanticTask[] {
  const tasks: SemanticTask[] = []
  const assigned = new Set<string>()

  for (const module of input.classification.modules) {
    const files = module.files.filter((file) => input.analyzableFileSet.has(file))
    if (files.length === 0) {
      continue
    }
    files.forEach((file) => assigned.add(file))
    tasks.push({
      id: `module:${module.name}`,
      name: module.name,
      type: 'module',
      filePaths: files,
    })
  }

  const backlog = [...input.classification.core, ...input.classification.supporting]
    .filter((file) => input.analyzableFileSet.has(file) && !assigned.has(file))
  const batchSize = 8
  for (let i = 0; i < backlog.length; i += batchSize) {
    const chunk = backlog.slice(i, i + batchSize)
    tasks.push({
      id: `batch:${Math.floor(i / batchSize) + 1}`,
      name: `补位批次 ${Math.floor(i / batchSize) + 1}`,
      type: 'batch',
      filePaths: chunk,
    })
  }

  return tasks
}

async function runSemanticTask(input: {
  model: string
  language: 'zh' | 'en' | string | undefined
  analysisDepth: 'standard' | 'deep' | string | undefined
  repositoryPath: string
  task: SemanticTask
  textFileMap: Map<string, string>
}): Promise<SemanticTaskResult> {
  const evidenceBlocks = input.task.filePaths
    .map((path) => {
      const content = input.textFileMap.get(path) ?? ''
      return [
        `### ${path}`,
        '```text',
        extractSnippet(content, 900),
        '```',
      ].join('\n')
    })
    .join('\n\n')

  const langInstruction = input.language === 'en'
    ? 'Respond in English.'
    : '请用中文输出。'

  const depthInstruction = input.analysisDepth === 'deep'
    ? '请强调核心执行链路、模块边界、配置依赖和潜在风险。'
    : '请输出简洁但完整的模块职责与关键流程。'

  const userMessage = [
    '你是子分析 Agent，请分析给定文件集合并输出 JSON。',
    langInstruction,
    depthInstruction,
    '仅输出 JSON，schema:',
    '{ "summary": string, "keyFlows": string[], "risks": string[], "evidence": string[] }',
    'evidence 必须引用真实文件路径。',
    '',
    `仓库：${input.repositoryPath}`,
    `任务：${input.task.name} (${input.task.type})`,
    '文件证据：',
    evidenceBlocks,
  ].join('\n')

  const raw = await invokeModelToText({
    model: input.model,
    userMessage,
  })
  const parsed = extractJsonObjectFromText<{
    summary?: string
    keyFlows?: string[]
    risks?: string[]
    evidence?: string[]
  }>(raw)

  if (!parsed) {
    throw new Error(`任务 ${input.task.name} 未返回可解析 JSON`)
  }

  const normalizeList = (value: string[] | undefined): string[] => {
    if (!Array.isArray(value)) {
      return []
    }

    return value
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, 12)
  }

  return {
    taskId: input.task.id,
    name: input.task.name,
    type: input.task.type,
    summary: parsed.summary?.trim() || '未返回摘要',
    keyFlows: normalizeList(parsed.keyFlows),
    risks: normalizeList(parsed.risks),
    evidence: normalizeList(parsed.evidence),
  }
}

async function runSemanticWorkers(input: {
  model: string
  language: 'zh' | 'en' | string | undefined
  analysisDepth: 'standard' | 'deep' | string | undefined
  repositoryPath: string
  tasks: SemanticTask[]
  textFileMap: Map<string, string>
  workerCount: number
  checkpoint: () => Promise<void>
  reportProgress: (stage: string, percent: number, detail: string, processed?: number, total?: number) => void
}): Promise<SemanticTaskResult[]> {
  const queue = [...input.tasks]
  const output: SemanticTaskResult[] = []
  let processed = 0
  const total = queue.length

  if (total === 0) {
    return output
  }

  const runSingleWorker = async (workerId: number): Promise<void> => {
    while (queue.length > 0) {
      await input.checkpoint()
      const task = queue.shift()
      if (!task) {
        return
      }

      input.reportProgress(
        'semantic',
        55 + (processed / Math.max(1, total)) * 28,
        `worker-${workerId} 分析 ${task.name}`,
        processed,
        total,
      )

      let result: SemanticTaskResult | null = null
      let lastError: string | undefined
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await input.checkpoint()
        try {
          result = await runSemanticTask({
            model: input.model,
            language: input.language,
            analysisDepth: input.analysisDepth,
            repositoryPath: input.repositoryPath,
            task,
            textFileMap: input.textFileMap,
          })
          break
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)))
          }
        }
      }

      if (!result) {
        result = {
          taskId: task.id,
          name: task.name,
          type: task.type,
          summary: `任务失败，已降级为最小证据条目：${lastError ?? '未知错误'}`,
          keyFlows: [],
          risks: ['模型返回异常，建议重新运行分析任务'],
          evidence: task.filePaths.slice(0, 8),
        }
      }

      output.push(result)
      processed += 1
      input.reportProgress(
        'semantic',
        55 + (processed / Math.max(1, total)) * 28,
        `语义任务完成 ${processed}/${total}`,
        processed,
        total,
      )
    }
  }

  const workers = new Array(Math.min(input.workerCount, total))
    .fill(0)
    .map((_, index) => runSingleWorker(index + 1))

  await Promise.all(workers)
  return output
}

function dedupeStrings(list: string[]): string[] {
  return [...new Set(list.map((item) => item.trim()).filter((item) => item.length > 0))]
}

function buildFallbackArchitectureTopology(input: {
  language: 'zh' | 'en' | string | undefined
  modules: SemanticTaskResult[]
}): ArchitectureTopology {
  const isEn = input.language === 'en'
  const moduleNames = input.modules.map((item) => item.name).slice(0, 12)
  if (moduleNames.length === 0) {
    return {
      layers: [],
      dependencies: [],
      criticalFlows: [],
      entryModules: [],
    }
  }

  const entryCandidates = moduleNames.filter((name) => /entry|main|app|api|router|ui|command|cli/i.test(name))
  const infraCandidates = moduleNames.filter((name) => /infra|storage|adapter|provider|gateway|database|cache|utils|sdk/i.test(name))
  const domainCandidates = moduleNames.filter((name) => !entryCandidates.includes(name) && !infraCandidates.includes(name))

  const layers: ArchitectureTopologyLayer[] = []
  const appendLayer = (name: string, modules: string[]): void => {
    const sanitized = dedupeStrings(modules).filter((item) => moduleNames.includes(item))
    if (sanitized.length > 0) {
      layers.push({
        name,
        modules: sanitized,
      })
    }
  }

  appendLayer(isEn ? 'Entry Layer' : '入口层', entryCandidates)
  appendLayer(isEn ? 'Domain Layer' : '领域层', domainCandidates)
  appendLayer(isEn ? 'Infrastructure Layer' : '基础设施层', infraCandidates)

  if (layers.length === 0) {
    appendLayer(isEn ? 'Core Layer' : '核心层', moduleNames)
  }

  const orderedModules = layers.flatMap((item) => item.modules)
  const dependencies: ArchitectureTopologyDependency[] = []
  for (let index = 0; index < orderedModules.length - 1; index += 1) {
    const from = orderedModules[index]
    const to = orderedModules[index + 1]
    if (!from || !to || from === to) {
      continue
    }
    dependencies.push({
      from,
      to,
      reason: isEn ? 'Fallback inferred flow' : '基于模块顺序的回退链路',
    })
  }

  const criticalFlows = input.modules
    .flatMap((item) => item.keyFlows.map((flow) => ({
      name: flow.slice(0, 60),
      steps: [item.name, flow],
    })))
    .slice(0, 8)

  return {
    layers,
    dependencies,
    criticalFlows,
    entryModules: layers[0]?.modules ?? moduleNames.slice(0, 2),
  }
}

async function inferArchitectureTopology(input: {
  model: string
  language: 'zh' | 'en' | string | undefined
  repositoryPath: string
  modules: SemanticTaskResult[]
}): Promise<ArchitectureTopology> {
  const fallback = buildFallbackArchitectureTopology({
    language: input.language,
    modules: input.modules,
  })
  if (input.modules.length === 0) {
    return fallback
  }

  const moduleDigest = input.modules
    .slice(0, 20)
    .map((item) => ({
      name: item.name,
      summary: item.summary,
      keyFlows: item.keyFlows.slice(0, 6),
      risks: item.risks.slice(0, 4),
      evidence: item.evidence.slice(0, 6),
    }))

  const langInstruction = input.language === 'en'
    ? 'Respond in English.'
    : '请用中文输出。'

  const userMessage = [
    '你是系统架构师。请基于模块证据推导分层关系并输出 JSON。',
    langInstruction,
    '只输出 JSON，schema:',
    [
      '{',
      '  "layers": [{ "name": string, "modules": string[] }],',
      '  "dependencies": [{ "from": string, "to": string, "reason": string }],',
      '  "criticalFlows": [{ "name": string, "steps": string[] }],',
      '  "entryModules": string[]',
      '}',
    ].join('\n'),
    '规则：',
    '- modules/dependencies 中的模块名称必须来自输入模块列表；',
    '- dependencies 要体现真实调用/依赖关系，避免全是 Repo->Module 的扁平结构；',
    '- criticalFlows 每条至少 2 步，优先体现跨模块链路；',
    '- 如果证据不足请减少结论数量，不要编造。',
    '',
    `仓库路径：${input.repositoryPath}`,
    '模块证据：',
    '```json',
    JSON.stringify(moduleDigest, null, 2),
    '```',
  ].join('\n')

  const raw = await invokeModelToText({
    model: input.model,
    userMessage,
  })

  const parsed = extractJsonObjectFromText<{
    layers?: Array<{ name?: string; modules?: string[] }>
    dependencies?: Array<{ from?: string; to?: string; reason?: string }>
    criticalFlows?: Array<{ name?: string; steps?: string[] }>
    entryModules?: string[]
  }>(raw)

  if (!parsed) {
    return fallback
  }

  const availableNames = new Set(input.modules.map((item) => item.name))
  const sanitizeNameList = (list: string[] | undefined): string[] => {
    if (!Array.isArray(list)) {
      return []
    }
    return dedupeStrings(list).filter((item) => availableNames.has(item))
  }

  const layers = Array.isArray(parsed.layers)
    ? parsed.layers
      .map((item) => ({
        name: typeof item?.name === 'string' && item.name.trim().length > 0
          ? item.name.trim()
          : input.language === 'en'
            ? 'Uncategorized'
            : '未分类层',
        modules: sanitizeNameList(item?.modules),
      }))
      .filter((item) => item.modules.length > 0)
    : []

  const dependencies = Array.isArray(parsed.dependencies)
    ? parsed.dependencies
      .map((item) => ({
        from: typeof item?.from === 'string' ? item.from.trim() : '',
        to: typeof item?.to === 'string' ? item.to.trim() : '',
        reason: typeof item?.reason === 'string' && item.reason.trim().length > 0
          ? item.reason.trim()
          : input.language === 'en'
            ? 'Dependency inferred from semantic evidence'
            : '由语义证据推导的依赖关系',
      }))
      .filter((item) => item.from.length > 0 && item.to.length > 0 && item.from !== item.to)
      .filter((item) => availableNames.has(item.from) && availableNames.has(item.to))
      .slice(0, 30)
    : []

  const criticalFlows = Array.isArray(parsed.criticalFlows)
    ? parsed.criticalFlows
      .map((item) => ({
        name: typeof item?.name === 'string' && item.name.trim().length > 0
          ? item.name.trim()
          : input.language === 'en'
            ? 'Unnamed flow'
            : '未命名链路',
        steps: sanitizeNameList(item?.steps).slice(0, 8),
      }))
      .filter((item) => item.steps.length >= 2)
      .slice(0, 12)
    : []

  const entryModules = sanitizeNameList(parsed.entryModules)
  const topology: ArchitectureTopology = {
    layers: layers.length > 0 ? layers : fallback.layers,
    dependencies: dependencies.length > 0 ? dependencies : fallback.dependencies,
    criticalFlows: criticalFlows.length > 0 ? criticalFlows : fallback.criticalFlows,
    entryModules: entryModules.length > 0 ? entryModules : fallback.entryModules,
  }

  return topology
}

function renderWikiPages(input: {
  repositoryPath: string
  metadata: PluginAiIndexMetadata
  manifest: RepositoryFileManifestItem[]
  classification: CoreFileClassification
  semanticResults: SemanticTaskResult[]
  topLevelEntries: Array<{ name: string; type: 'dir' | 'file' }>
  topology: ArchitectureTopology
}): WikiPageArtifact[] {
  const isEn = input.metadata.language === 'en'
  const coreModules = input.semanticResults
    .filter((item) => item.type === 'module')
    .slice(0, 18)
  const keyFlows = input.semanticResults
    .flatMap((item) => item.keyFlows.map((flow) => `${item.name}: ${flow}`))
    .slice(0, 20)
  const risks = input.semanticResults
    .flatMap((item) => item.risks.map((risk) => `${item.name}: ${risk}`))
    .slice(0, 20)
  const evidence = input.semanticResults
    .flatMap((item) => item.evidence)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 80)
  const moduleNameToSummary = new Map(coreModules.map((item) => [item.name, item.summary]))
  const moduleNameToEvidence = new Map(coreModules.map((item) => [item.name, item.evidence]))

  const pageIndexContent = [
    `# ${isEn ? 'Repository Wiki' : '仓库 Wiki'}`,
    '',
    isEn ? '> AI-generated deep repository documentation' : '> AI 生成的深度仓库文档',
    '',
    `- ${isEn ? 'Repository' : '仓库'}: \`${input.repositoryPath}\``,
    `- ${isEn ? 'Knowledge Base' : '文档库'}: \`${input.metadata.knowledgeBaseId}\``,
    `- ${isEn ? 'Model' : '分析模型'}: \`${input.metadata.model}\``,
    `- ${isEn ? 'Generated At' : '生成时间'}: ${input.metadata.generatedAt}`,
    `- ${isEn ? 'Files In Scope' : '纳入文件数'}: ${input.metadata.totalFiles}`,
    `- ${isEn ? 'Analyzable Chunks' : '可分析分块'}: ${input.metadata.totalChunks}`,
    '',
    `## ${isEn ? 'Coverage' : '覆盖范围'}`,
    `- core: ${input.classification.core.length}`,
    `- supporting: ${input.classification.supporting.length}`,
    `- peripheral: ${input.classification.peripheral.length}`,
    '',
    `## ${isEn ? 'Top-level Structure' : '顶层结构'}`,
    ...(input.topLevelEntries.length > 0
      ? input.topLevelEntries.map((entry) => `- [${entry.type === 'dir' ? 'DIR' : 'FILE'}] ${entry.name}`)
      : ['- (empty)']),
  ].join('\n')

  const allLayerModules = input.topology.layers
    .flatMap((layer) => layer.modules)
    .filter((name, index, arr) => arr.indexOf(name) === index)
  const graphModules = allLayerModules.length > 0
    ? allLayerModules
    : coreModules.slice(0, 10).map((item) => item.name)
  const mermaidNodeIds = new Map(
    graphModules.map((moduleName, index) => [moduleName, `M${index}`]),
  )
  const architectureGraphLines: string[] = [
    '```mermaid',
    'graph LR',
    `Repo["${basename(input.repositoryPath)}"]`,
  ]

  input.topology.layers.forEach((layer, layerIndex) => {
    architectureGraphLines.push(`subgraph L${layerIndex}["${layer.name}"]`)
    for (const moduleName of layer.modules) {
      const nodeId = mermaidNodeIds.get(moduleName)
      if (!nodeId) {
        continue
      }
      architectureGraphLines.push(`${nodeId}["${moduleName}"]`)
    }
    architectureGraphLines.push('end')
  })

  for (const entryModule of input.topology.entryModules) {
    const nodeId = mermaidNodeIds.get(entryModule)
    if (!nodeId) {
      continue
    }
    architectureGraphLines.push(`Repo --> ${nodeId}`)
  }

  const addedDependencyKeys = new Set<string>()
  for (const dependency of input.topology.dependencies) {
    const fromNodeId = mermaidNodeIds.get(dependency.from)
    const toNodeId = mermaidNodeIds.get(dependency.to)
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) {
      continue
    }
    const key = `${fromNodeId}->${toNodeId}`
    if (addedDependencyKeys.has(key)) {
      continue
    }
    addedDependencyKeys.add(key)
    architectureGraphLines.push(`${fromNodeId} --> ${toNodeId}`)
  }

  if (addedDependencyKeys.size === 0) {
    const fallbackChain = graphModules.slice(0, 8)
    for (let index = 0; index < fallbackChain.length - 1; index += 1) {
      const fromNodeId = mermaidNodeIds.get(fallbackChain[index] ?? '')
      const toNodeId = mermaidNodeIds.get(fallbackChain[index + 1] ?? '')
      if (!fromNodeId || !toNodeId) {
        continue
      }
      architectureGraphLines.push(`${fromNodeId} --> ${toNodeId}`)
    }
  }

  architectureGraphLines.push('```')

  const moduleDetails = graphModules.length > 0
    ? graphModules.map((moduleName) => {
      const summary = moduleNameToSummary.get(moduleName) ?? (isEn ? 'No semantic summary.' : '暂无语义摘要。')
      const evidenceFiles = moduleNameToEvidence.get(moduleName) ?? []
      const upstream = input.topology.dependencies
        .filter((item) => item.to === moduleName)
        .map((item) => item.from)
      const downstream = input.topology.dependencies
        .filter((item) => item.from === moduleName)
        .map((item) => item.to)
      return [
        `### ${moduleName}`,
        `- ${summary}`,
        `- ${isEn ? 'Upstream' : '上游依赖'}: ${upstream.length > 0 ? upstream.join(' / ') : '-'}`,
        `- ${isEn ? 'Downstream' : '下游依赖'}: ${downstream.length > 0 ? downstream.join(' / ') : '-'}`,
        evidenceFiles.length > 0
          ? `- ${isEn ? 'Evidence' : '证据'}: ${evidenceFiles.join(' / ')}`
          : `- ${isEn ? 'Evidence' : '证据'}: -`,
      ].join('\n')
    })
    : ['- (none)']

  const architectureContent = [
    `# ${isEn ? 'Architecture' : '架构总览'}`,
    '',
    ...architectureGraphLines,
    '',
    `## ${isEn ? 'Layered Modules' : '分层模块说明'}`,
    ...(input.topology.layers.length > 0
      ? input.topology.layers.map((layer) => `- ${layer.name}: ${layer.modules.join(' / ')}`)
      : ['- (none)']),
    '',
    `## ${isEn ? 'Core Modules' : '核心模块'}`,
    ...moduleDetails,
    '',
    `## ${isEn ? 'Dependency Rationale' : '关键依赖关系说明'}`,
    ...(input.topology.dependencies.length > 0
      ? input.topology.dependencies.slice(0, 20).map((item) => `- ${item.from} -> ${item.to}: ${item.reason}`)
      : ['- (none)']),
  ].join('\n')

  const runtimeContent = [
    `# ${isEn ? 'Runtime Flows' : '运行链路'}`,
    '',
    `## ${isEn ? 'Key Execution Flows' : '关键执行流'}`,
    ...(keyFlows.length > 0 ? keyFlows.map((flow) => `- ${flow}`) : ['- (none)']),
    '',
    `## ${isEn ? 'Cross-module Semantic Flows' : '跨模块语义链路'}`,
    ...(input.topology.criticalFlows.length > 0
      ? input.topology.criticalFlows.map((flow) => `- ${flow.name}: ${flow.steps.join(' -> ')}`)
      : ['- (none)']),
    '',
    `## ${isEn ? 'Configuration Signals' : '配置与构建信号'}`,
    ...input.manifest
      .filter((file) => file.extension === '.json' || file.extension === '.toml' || file.extension === '.yaml' || file.extension === '.yml')
      .slice(0, 30)
      .map((file) => `- ${file.relPath} (${file.language})`),
  ].join('\n')

  const moduleRows = coreModules.length > 0
    ? coreModules
      .map((module) => `| ${module.name} | ${module.summary.replace(/\|/g, '/')} | ${module.evidence.slice(0, 3).join('<br/>') || '-'} |`)
      .join('\n')
    : '| - | - | - |'
  const modulesContent = [
    `# ${isEn ? 'Modules' : '模块明细'}`,
    '',
    '| 模块 | 职责摘要 | 关键证据 |',
    '| --- | --- | --- |',
    moduleRows,
    '',
    '## Supporting Files',
    ...input.classification.supporting.slice(0, 80).map((file) => `- ${file}`),
  ].join('\n')

  const riskContent = [
    `# ${isEn ? 'Data, Risks & Evidence' : '数据、风险与证据'}`,
    '',
    `## ${isEn ? 'Potential Risks' : '潜在风险'}`,
    ...(risks.length > 0 ? risks.map((item) => `- ${item}`) : ['- (none)']),
    '',
    `## ${isEn ? 'Evidence Index' : '证据索引'}`,
    ...(evidence.length > 0 ? evidence.map((item) => `- ${item}`) : ['- (none)']),
  ].join('\n')

  return [
    { id: 'index', title: isEn ? 'Index' : '首页', path: 'wiki/pages/index.md', content: pageIndexContent },
    { id: 'architecture', title: isEn ? 'Architecture' : '架构总览', path: 'wiki/pages/architecture.md', content: architectureContent },
    { id: 'runtime', title: isEn ? 'Runtime' : '运行链路', path: 'wiki/pages/runtime.md', content: runtimeContent },
    { id: 'modules', title: isEn ? 'Modules' : '模块明细', path: 'wiki/pages/modules.md', content: modulesContent },
    { id: 'data-risks', title: isEn ? 'Data & Risks' : '数据与风险', path: 'wiki/pages/data-risks.md', content: riskContent },
  ]
}

async function polishWikiPagesWithMainAgent(input: {
  model: string
  language: 'zh' | 'en' | string | undefined
  repositoryPath: string
  pages: WikiPageArtifact[]
}): Promise<WikiPageArtifact[]> {
  const pageDraft = input.pages
    .map((page) => [
      `## PAGE:${page.id}`,
      `TITLE:${page.title}`,
      '```markdown',
      page.content,
      '```',
    ].join('\n'))
    .join('\n\n')

  const langInstruction = input.language === 'en'
    ? 'Respond in English.'
    : '请用中文输出。'

  const userMessage = [
    '你是主文档 Agent，请润色多页仓库 Wiki 草稿，提升可读性但不杜撰事实。',
    langInstruction,
    '要求：',
    '- 保留每页主标题与章节结构，允许优化措辞；',
    '- 明确保留证据导向，不要添加无证据结论；',
    '- 不输出索引元数据 JSON；',
    '- 输出必须是 JSON，且仅包含 pages 字段。',
    'JSON schema:',
    '{ "pages": [{ "id": string, "content": string }] }',
    '',
    `仓库路径：${input.repositoryPath}`,
    '页面草稿：',
    pageDraft,
  ].join('\n')

  const output = await invokeModelToText({
    model: input.model,
    userMessage,
  })

  const parsed = extractJsonObjectFromText<{ pages?: Array<{ id?: string; content?: string }> }>(output)
  if (!parsed?.pages || !Array.isArray(parsed.pages)) {
    throw new Error('主 Agent 润色失败：返回结果不符合 JSON schema')
  }

  const contentById = new Map(
    parsed.pages
      .filter((item): item is { id: string; content: string } => (
        typeof item.id === 'string'
        && item.id.trim().length > 0
        && typeof item.content === 'string'
        && item.content.trim().length > 0
      ))
      .map((item) => [item.id.trim(), item.content.trim()]),
  )

  const polished = input.pages.map((page) => ({
    ...page,
    content: contentById.get(page.id) ?? page.content,
  }))

  return polished
}


async function computeScanResult(input: {
  pluginId: string
  workspacePath: string
  repositoryPath: string
  knowledgeBaseId: string
  model: string
  language: 'zh' | 'en' | string | undefined
  analysisDepth: 'standard' | 'deep' | string | undefined
  scanMode: PluginAiScanMode
  subagentCount: number
  maxFileBytesForFullAnalyze: number
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
  const { manifest, textFiles } = await collectRepositoryManifest({
    repositoryPath: input.repositoryPath,
    scanMode: input.scanMode,
    maxFileBytesForFullAnalyze: input.maxFileBytesForFullAnalyze,
    checkpoint: input.checkpoint,
    onProgress: (processedDirs) => {
      input.reportProgress('scan', 6, `已扫描目录: ${processedDirs}`, processedDirs)
    },
  })

  if (manifest.length === 0) {
    throw new Error('仓库没有可用文件，请检查仓库路径或扫描模式')
  }

  const textFileMap = new Map(textFiles.map((file) => [file.relPath, file.content]))
  input.reportProgress('scan', 12, `文件清单已建立：${manifest.length} 个文件，文本文件 ${textFiles.length} 个`, textFiles.length, manifest.length)

  const chunks: PluginAiIndexChunkRecord[] = []
  const fileFingerprints: Record<string, string> = {}
  const sampleFiles: string[] = []
  const extensionCounts: Record<string, number> = {}
  const topLevelFileCountMap: Record<string, number> = {}
  const topLevelChunkCountMap: Record<string, number> = {}
  const dependencySignals = new Set<string>()
  const commandSignals = new Set<string>()
  const keyFileInsights: KeyFileInsight[] = []
  const keyFilePathSet = new Set<string>()
  let reusedFiles = 0
  let rebuiltFiles = 0
  let reusedChunks = 0
  let rebuiltChunks = 0

  for (const file of manifest) {
    const [topLevelDirRaw] = file.relPath.split('/')
    const topLevelDir = topLevelDirRaw || '(root)'
    topLevelFileCountMap[topLevelDir] = (topLevelFileCountMap[topLevelDir] ?? 0) + 1

    const content = textFileMap.get(file.relPath)
    if (content) {
      fileFingerprints[file.relPath] = stableHash(`${file.relPath}|${content}`)
    } else {
      fileFingerprints[file.relPath] = stableHash(`${file.relPath}|${file.size}|${file.modifiedAt}|${file.skipReason ?? ''}`)
    }
  }

  for (let index = 0; index < textFiles.length; index += 1) {
    await input.checkpoint()

    const file = textFiles[index]!
    const relPath = file.relPath
    const content = file.content

    if (sampleFiles.length < 28) {
      sampleFiles.push(relPath)
    }

    const extension = extname(relPath).toLowerCase() || '(no-ext)'
    extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1

    const [topLevelDirRaw] = relPath.split('/')
    const topLevelDir = topLevelDirRaw || '(root)'

    const lowerRelPath = relPath.toLowerCase()
    if (lowerRelPath === 'package.json' || lowerRelPath.endsWith('/package.json')) {
      const packageSignals = extractPackageJsonSignals(content)
      appendUniqueSignals(dependencySignals, packageSignals.dependencies)
      appendUniqueSignals(commandSignals, packageSignals.scripts)
    } else if (lowerRelPath === 'requirements.txt' || lowerRelPath.endsWith('/requirements.txt')) {
      appendUniqueSignals(dependencySignals, extractRequirementsSignals(content))
    } else if (lowerRelPath === 'cargo.toml' || lowerRelPath.endsWith('/cargo.toml')) {
      appendUniqueSignals(dependencySignals, extractCargoSignals(content))
    }

    const keyReason = getKeyFileReason(relPath)
    if (keyReason && !keyFilePathSet.has(relPath) && keyFileInsights.length < 24) {
      keyFilePathSet.add(relPath)
      keyFileInsights.push({
        filePath: relPath,
        reason: keyReason,
        excerpt: extractSnippet(content),
      })
    }

    const fileFingerprint = fileFingerprints[relPath]
    const progressBase = 14 + (index / Math.max(1, textFiles.length)) * 32
    input.reportProgress('chunk', progressBase, `处理文件: ${relPath}`, index + 1, textFiles.length)

    const reusableChunks = fileFingerprint ? previousChunkMap.get(fileFingerprint) : undefined
    if (reusableChunks && reusableChunks.length > 0) {
      reusedFiles += 1
      reusedChunks += reusableChunks.length
      topLevelChunkCountMap[topLevelDir] = (topLevelChunkCountMap[topLevelDir] ?? 0) + reusableChunks.length
      chunks.push(...reusableChunks)
      continue
    }

    rebuiltFiles += 1
    const fileChunks = chunkText(content, input.strategy)
    topLevelChunkCountMap[topLevelDir] = (topLevelChunkCountMap[topLevelDir] ?? 0) + fileChunks.length
    for (let chunkIndex = 0; chunkIndex < fileChunks.length; chunkIndex += 1) {
      await input.checkpoint()
      const chunkContent = fileChunks[chunkIndex]!
      rebuiltChunks += 1

      chunks.push({
        id: `${relPath}:${chunkIndex}:${(fileFingerprint ?? '').slice(0, 10)}`,
        filePath: relPath,
        fileFingerprint: fileFingerprint ?? stableHash(relPath),
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
    totalFiles: manifest.length,
    totalChunks: chunks.length,
    reusedChunks,
    rebuiltChunks,
    fileFingerprints,
  }

  const topLevelEntries = extractTopLevelEntries(
    input.repositoryPath,
    manifest.map((file) => join(input.repositoryPath, file.relPath)),
  )
  const topLanguages = selectTopLanguages(extensionCounts)
  const directoryInsights = buildDirectoryInsights(topLevelFileCountMap, topLevelChunkCountMap)

  if (topLanguages.length > 0) {
    input.reportProgress('scan', 42, `语言信号：${topLanguages.map((item) => item.ext).join(', ')}`)
  }
  if (directoryInsights.length > 0) {
    input.reportProgress('scan', 44, `目录信号：${directoryInsights[0]?.name ?? '(none)'}`)
  }

  input.reportProgress('classify', 48, '正在识别核心文件与模块...')
  const contentClues = buildFileContentClues({
    textFiles,
    keyFiles: keyFileInsights,
  })
  const classification = await classifyRepositoryFiles({
    model: input.model,
    language: input.language,
    repositoryPath: input.repositoryPath,
    manifest,
    contentClues,
    dependencySignals: [...dependencySignals],
    commandSignals: [...commandSignals],
  })

  const semanticTasks = buildSemanticTasks({
    classification,
    analyzableFileSet: new Set(textFiles.map((file) => file.relPath)),
  })

  if (semanticTasks.length === 0) {
    throw new Error('语义任务为空：未识别到可分析的核心文件')
  }

  input.reportProgress('semantic', 55, `准备并行分析任务：${semanticTasks.length} 个`)
  const semanticResults = await runSemanticWorkers({
    model: input.model,
    language: input.language,
    analysisDepth: input.analysisDepth,
    repositoryPath: input.repositoryPath,
    tasks: semanticTasks,
    textFileMap,
    workerCount: input.subagentCount,
    checkpoint: input.checkpoint,
    reportProgress: input.reportProgress,
  })

  if (semanticResults.length === 0) {
    throw new Error('语义分析失败：未产出有效结果')
  }

  input.reportProgress('semantic', 83, '正在推导模块分层与依赖拓扑...')
  let topology: ArchitectureTopology
  try {
    topology = await inferArchitectureTopology({
      model: input.model,
      language: input.language,
      repositoryPath: input.repositoryPath,
      modules: semanticResults.filter((item) => item.type === 'module'),
    })
  } catch (error) {
    console.warn('[插件索引] 模块拓扑推导失败，回退到启发式结构:', error)
    topology = buildFallbackArchitectureTopology({
      language: input.language,
      modules: semanticResults.filter((item) => item.type === 'module'),
    })
  }

  input.reportProgress('synthesize', 86, '正在合成多页 Wiki...')
  let pages = renderWikiPages({
    repositoryPath: input.repositoryPath,
    metadata,
    manifest,
    classification,
    semanticResults,
    topLevelEntries,
    topology,
  })

  input.reportProgress('synthesize', 92, '主 Agent 正在润色文档...')
  try {
    pages = await polishWikiPagesWithMainAgent({
      model: input.model,
      language: input.language,
      repositoryPath: input.repositoryPath,
      pages,
    })
  } catch (error) {
    console.warn('[插件索引] 主 Agent 润色失败，保留结构化草稿:', error)
  }

  const markdown = pages[0]?.content ?? '# Wiki'

  return {
    metadata,
    chunks,
    markdown,
    pages,
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
  pages: WikiPageArtifact[]
  reusedFiles: number
  rebuiltFiles: number
}): Promise<PluginAiIndexSummary> {
  const kbRoot = getKnowledgeBaseRoot(input.workspacePath, input.knowledgeBaseId)
  const metadataPath = getKnowledgeBaseMetadataPath(input.workspacePath, input.knowledgeBaseId)
  const chunksPath = getKnowledgeBaseChunksPath(input.workspacePath, input.knowledgeBaseId)
  const kbMarkdownPath = getKnowledgeBaseMarkdownPath(input.workspacePath, input.knowledgeBaseId)
  const kbPagesRoot = getKnowledgeBasePagesRoot(input.workspacePath, input.knowledgeBaseId)
  const latestMarkdownPath = getLatestMarkdownPath(input.workspacePath)
  const latestJsonPath = getLatestJsonPath(input.workspacePath)
  const latestSummaryPath = getLatestIndexSummaryPath(input.workspacePath)
  const latestPointerPath = getLatestKnowledgeBasePointerPath(input.workspacePath)
  const wikiPagesRoot = getWikiPagesRoot(input.workspacePath)

  await mkdir(kbRoot, { recursive: true })
  await writeJsonFile(metadataPath, input.metadata)
  await writeJsonFile(chunksPath, input.chunks)
  await mkdir(dirname(kbMarkdownPath), { recursive: true })
  await writeFile(kbMarkdownPath, `${input.markdown}\n`, 'utf-8')
  await mkdir(kbPagesRoot, { recursive: true })

  await mkdir(dirname(latestMarkdownPath), { recursive: true })
  await writeFile(latestMarkdownPath, `${input.markdown}\n`, 'utf-8')
  await mkdir(wikiPagesRoot, { recursive: true })

  for (const page of input.pages) {
    const knowledgeBasePagePath = getKnowledgeBasePagePath(
      input.workspacePath,
      input.knowledgeBaseId,
      page.id,
    )
    await writeFile(knowledgeBasePagePath, `${page.content}\n`, 'utf-8')

    const pagePath = getWikiPagePath(input.workspacePath, page.id)
    await writeFile(pagePath, `${page.content}\n`, 'utf-8')
  }

  const summary: PluginAiIndexSummary = {
    knowledgeBaseId: input.knowledgeBaseId,
    metadata: input.metadata,
    indexPath: chunksPath,
    markdownPath: normalizeRelPath(relative(input.workspacePath, kbMarkdownPath)),
    generationMode: 'multi-page',
    pages: input.pages.map((page) => ({
      id: page.id,
      title: page.title,
      path: normalizeRelPath(relative(
        input.workspacePath,
        getKnowledgeBasePagePath(input.workspacePath, input.knowledgeBaseId, page.id),
      )),
    })),
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
    activePageId: input.pages[0]?.id ?? 'index',
    pages: input.pages.map((page) => ({
      id: page.id,
      title: page.title,
      path: normalizeRelPath(relative(
        input.workspacePath,
        getKnowledgeBasePagePath(input.workspacePath, input.knowledgeBaseId, page.id),
      )),
    })),
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
    const latestSummary = await readJsonFile<PluginAiIndexSummary>(getLatestIndexSummaryPath(workspacePath))
    if (latestSummary?.knowledgeBaseId === sanitizeKnowledgeBaseId(knowledgeBaseId) && latestSummary.metadata.pluginId === pluginId) {
      return latestSummary
    }

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
      markdownPath: normalizeRelPath(relative(workspacePath, getKnowledgeBaseMarkdownPath(workspacePath, kbId))),
      generationMode: 'multi-page',
      pages: [
        {
          id: 'index',
          title: metadata.language === 'en' ? 'Index' : '首页',
          path: normalizeRelPath(relative(workspacePath, getKnowledgeBasePagePath(workspacePath, kbId, 'index'))),
        },
        {
          id: 'architecture',
          title: metadata.language === 'en' ? 'Architecture' : '架构总览',
          path: normalizeRelPath(relative(workspacePath, getKnowledgeBasePagePath(workspacePath, kbId, 'architecture'))),
        },
        {
          id: 'runtime',
          title: metadata.language === 'en' ? 'Runtime' : '运行链路',
          path: normalizeRelPath(relative(workspacePath, getKnowledgeBasePagePath(workspacePath, kbId, 'runtime'))),
        },
        {
          id: 'modules',
          title: metadata.language === 'en' ? 'Modules' : '模块明细',
          path: normalizeRelPath(relative(workspacePath, getKnowledgeBasePagePath(workspacePath, kbId, 'modules'))),
        },
        {
          id: 'data-risks',
          title: metadata.language === 'en' ? 'Data & Risks' : '数据与风险',
          path: normalizeRelPath(relative(workspacePath, getKnowledgeBasePagePath(workspacePath, kbId, 'data-risks'))),
        },
      ],
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
  taskId?: string
}): Promise<PluginTaskOperationResult> {
  bindTaskPersistenceListener()

  const repositoryPath = resolve(input.payload.repositoryPath)
  const knowledgeBaseId = sanitizeKnowledgeBaseId(
    input.payload.knowledgeBaseId?.trim() || basename(repositoryPath),
  )
  const model = await resolvePluginModelOrThrow(input.payload.model)
  const strategy = normalizeChunkStrategy(input.payload.chunkStrategy)
  const scanMode = normalizeScanMode(input.payload.scanMode)
  const subagentCount = normalizeSubagentCount(input.payload.subagentCount)
  const maxFileBytesForFullAnalyze = normalizeMaxFileBytes(input.payload.maxFileBytesForFullAnalyze)
  const taskId = input.taskId?.trim() || randomUUID()

  await createWikiTaskRecord({
    taskId,
    pluginId: input.pluginId,
    taskType: 'ai-indexing-scan',
    repositoryPath,
    knowledgeBaseId,
    workspacePath: input.workspacePath,
    model,
    language: input.payload.language,
    analysisDepth: input.payload.analysisDepth,
    scanMode,
    subagentCount,
    maxFileBytesForFullAnalyze,
  })

  const startResult = pluginTaskRuntime.startTask(
    {
      taskId,
      pluginId: input.pluginId,
      taskType: 'ai-indexing-scan',
      metadata: {
        repositoryPath,
        knowledgeBaseId,
        model,
        language: input.payload.language,
        analysisDepth: input.payload.analysisDepth,
        scanMode,
        subagentCount,
        maxFileBytesForFullAnalyze,
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
        scanMode,
        subagentCount,
        maxFileBytesForFullAnalyze,
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
        pages: result.pages,
        reusedFiles: result.reusedFiles,
        rebuiltFiles: result.rebuiltFiles,
      })

      await persistWikiTaskArtifacts({
        taskId: taskContext.taskId,
        markdown: result.markdown,
        pages: result.pages,
        summary,
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

  if (!startResult.success) {
    await updateWikiTaskRecord(taskId, {
      state: 'failed',
      error: startResult.error ?? '任务启动失败',
      completedAt: nowIso(),
    })
    return startResult
  }

  return startResult
}

export async function recoverAiIndexingTasks(input: {
  pluginId: string
  workspacePath: string
}): Promise<void> {
  if (input.pluginId !== WIKI_LOCAL_REPOSITORY_PLUGIN_ID) {
    return
  }

  bindTaskPersistenceListener()

  const recoverableTasks = await listRecoverableWikiTasks(input.pluginId)
  if (recoverableTasks.length === 0) {
    return
  }

  for (const task of recoverableTasks) {
    const existed = pluginTaskRuntime.getTaskForPlugin(input.pluginId, task.taskId)
    if (existed) {
      continue
    }

    console.log(`[插件索引] 检测到可恢复任务，开始续跑: taskId=${task.taskId}`)
    await updateWikiTaskRecord(task.taskId, {
      state: 'running',
      error: undefined,
    })

    const recovered = await startAiIndexingTask({
      pluginId: input.pluginId,
      workspacePath: input.workspacePath,
      taskId: task.taskId,
      payload: {
        repositoryPath: task.repositoryPath,
        knowledgeBaseId: task.knowledgeBaseId,
        model: task.model,
        language: task.language,
        analysisDepth: task.analysisDepth,
        scanMode: task.scanMode,
        subagentCount: task.subagentCount,
        maxFileBytesForFullAnalyze: task.maxFileBytesForFullAnalyze,
      },
    })

    if (!recovered.success) {
      await updateWikiTaskRecord(task.taskId, {
        state: 'failed',
        error: recovered.error ?? '任务恢复失败',
        completedAt: nowIso(),
      })
      console.warn(`[插件索引] 任务恢复失败: taskId=${task.taskId}, error=${recovered.error ?? 'unknown'}`)
    }
  }
}

export async function getPersistedTaskSnapshot(
  pluginId: string,
  taskId: string,
): Promise<PluginTaskSnapshot | null> {
  const records = await listRecoverableWikiTasks(pluginId)
  const record = records.find((item) => item.taskId === taskId)
  if (!record) {
    return null
  }

  return {
    taskId: record.taskId,
    pluginId: record.pluginId,
    taskType: record.taskType,
    state: record.state,
    progress: record.progress,
    metadata: {
      repositoryPath: record.repositoryPath,
      knowledgeBaseId: record.knowledgeBaseId,
      model: record.model,
      language: record.language,
      analysisDepth: record.analysisDepth,
      scanMode: record.scanMode,
      subagentCount: record.subagentCount,
      maxFileBytesForFullAnalyze: record.maxFileBytesForFullAnalyze,
    },
    result: record.result,
    error: record.error,
    startedAt: record.startedAt ?? record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  }
}

export async function markPersistedTaskState(input: {
  taskId: string
  state: PluginTaskSnapshot['state']
  error?: string
}): Promise<void> {
  await updateWikiTaskRecord(input.taskId, {
    state: input.state,
    error: input.error,
    completedAt: input.state === 'failed' || input.state === 'stopped' ? nowIso() : undefined,
  })
}
