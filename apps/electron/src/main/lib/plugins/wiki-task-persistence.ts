import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  PluginAiAnalysisDepth,
  PluginAiIndexSummary,
  PluginAiScanMode,
  PluginTaskEventType,
  PluginTaskProgress,
  PluginTaskSnapshot,
  PluginWikiLanguage,
} from '@proma/shared'
import { getPluginWikiRootDir } from '../config-paths'

const INDEX_VERSION = 1
const TASK_INDEX_FILE_NAME = 'task-index.json'
const TASK_RECORD_FILE_NAME = 'task.json'
const TASK_EVENTS_FILE_NAME = 'events.jsonl'

interface WikiTaskPersistedIndex {
  version: number
  tasks: WikiTaskPersistedRecord[]
}

export interface WikiTaskPersistedRecord {
  taskId: string
  pluginId: string
  taskType: string
  folderName: string
  repositoryPath: string
  knowledgeBaseId: string
  workspacePath: string
  model: string
  language?: PluginWikiLanguage
  analysisDepth?: PluginAiAnalysisDepth
  scanMode: PluginAiScanMode
  subagentCount: number
  maxFileBytesForFullAnalyze: number
  state: PluginTaskSnapshot['state']
  progress?: PluginTaskProgress
  result?: Record<string, unknown>
  error?: string
  startedAt?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

interface CreateWikiTaskRecordInput {
  taskId: string
  pluginId: string
  taskType: string
  repositoryPath: string
  knowledgeBaseId: string
  workspacePath: string
  model: string
  language?: PluginWikiLanguage
  analysisDepth?: PluginAiAnalysisDepth
  scanMode: PluginAiScanMode
  subagentCount: number
  maxFileBytesForFullAnalyze: number
}

interface UpdateWikiTaskRecordInput {
  state?: PluginTaskSnapshot['state']
  progress?: PluginTaskProgress
  result?: Record<string, unknown>
  error?: string
  startedAt?: string
  completedAt?: string
}

interface AppendWikiTaskEventInput {
  taskId: string
  type: PluginTaskEventType
  timestamp: string
  task: PluginTaskSnapshot
}

interface PersistWikiTaskArtifactsInput {
  taskId: string
  markdown: string
  pages: Array<{ id: string; title: string; content: string }>
  summary: PluginAiIndexSummary
}

let writeQueue: Promise<void> = Promise.resolve()

function nowIso(): string {
  return new Date().toISOString()
}

function toTimestampSegment(iso: string): string {
  return iso.replace(/[:.]/g, '-')
}

function sanitizePathSegment(raw: string, fallback: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

function getIndexPath(): string {
  return join(getPluginWikiRootDir(), TASK_INDEX_FILE_NAME)
}

function getTaskFolderPath(folderName: string): string {
  return join(getPluginWikiRootDir(), folderName)
}

function getTaskRecordPath(folderName: string): string {
  return join(getTaskFolderPath(folderName), TASK_RECORD_FILE_NAME)
}

function getTaskEventsPath(folderName: string): string {
  return join(getTaskFolderPath(folderName), TASK_EVENTS_FILE_NAME)
}

function buildTaskFolderName(taskId: string, repositoryPath: string, createdAt: string): string {
  const repoName = sanitizePathSegment(basename(repositoryPath), 'repo')
  return `${taskId}_${repoName}_${toTimestampSegment(createdAt)}`
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) {
    return null
  }

  try {
    const content = await readFile(filePath, 'utf-8')
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

async function writeJsonAtomic(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp`
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  await rename(tempPath, path)
}

async function withWriteLock<T>(handler: () => Promise<T>): Promise<T> {
  const prev = writeQueue
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  writeQueue = prev.then(() => gate)
  await prev

  try {
    return await handler()
  } finally {
    release()
  }
}

async function readTaskIndex(): Promise<WikiTaskPersistedIndex> {
  const index = await readJsonIfExists<WikiTaskPersistedIndex>(getIndexPath())
  if (!index || !Array.isArray(index.tasks)) {
    return {
      version: INDEX_VERSION,
      tasks: [],
    }
  }

  return {
    version: index.version ?? INDEX_VERSION,
    tasks: index.tasks,
  }
}

async function writeTaskIndex(index: WikiTaskPersistedIndex): Promise<void> {
  await writeJsonAtomic(getIndexPath(), {
    version: INDEX_VERSION,
    tasks: index.tasks,
  })
}

function sortTasks(tasks: WikiTaskPersistedRecord[]): WikiTaskPersistedRecord[] {
  return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function normalizeTaskState(state: PluginTaskSnapshot['state'] | undefined): PluginTaskSnapshot['state'] {
  if (!state) {
    return 'running'
  }
  return state
}

export async function createWikiTaskRecord(input: CreateWikiTaskRecordInput): Promise<WikiTaskPersistedRecord> {
  return withWriteLock(async () => {
    const index = await readTaskIndex()
    const existed = index.tasks.find((task) => task.taskId === input.taskId)
    if (existed) {
      return existed
    }

    const createdAt = nowIso()
    const folderName = buildTaskFolderName(input.taskId, input.repositoryPath, createdAt)
    const record: WikiTaskPersistedRecord = {
      taskId: input.taskId,
      pluginId: input.pluginId,
      taskType: input.taskType,
      folderName,
      repositoryPath: input.repositoryPath,
      knowledgeBaseId: input.knowledgeBaseId,
      workspacePath: input.workspacePath,
      model: input.model,
      language: input.language,
      analysisDepth: input.analysisDepth,
      scanMode: input.scanMode,
      subagentCount: input.subagentCount,
      maxFileBytesForFullAnalyze: input.maxFileBytesForFullAnalyze,
      state: 'running',
      createdAt,
      updatedAt: createdAt,
    }

    const folderPath = getTaskFolderPath(folderName)
    await mkdir(folderPath, { recursive: true })
    await writeJsonAtomic(getTaskRecordPath(folderName), record)
    await writeTaskIndex({
      version: INDEX_VERSION,
      tasks: sortTasks([record, ...index.tasks]),
    })

    return record
  })
}

export async function listWikiTaskRecords(pluginId?: string): Promise<WikiTaskPersistedRecord[]> {
  const index = await readTaskIndex()
  const tasks = pluginId
    ? index.tasks.filter((task) => task.pluginId === pluginId)
    : index.tasks
  return sortTasks(tasks)
}

export async function getWikiTaskRecord(taskId: string): Promise<WikiTaskPersistedRecord | null> {
  const index = await readTaskIndex()
  return index.tasks.find((task) => task.taskId === taskId) ?? null
}

export async function updateWikiTaskRecord(
  taskId: string,
  patch: UpdateWikiTaskRecordInput,
): Promise<WikiTaskPersistedRecord | null> {
  return withWriteLock(async () => {
    const index = await readTaskIndex()
    const target = index.tasks.find((task) => task.taskId === taskId)
    if (!target) {
      return null
    }

    const next: WikiTaskPersistedRecord = {
      ...target,
      ...patch,
      state: normalizeTaskState(patch.state ?? target.state),
      updatedAt: nowIso(),
    }

    if (patch.startedAt) {
      next.startedAt = patch.startedAt
    }
    if (patch.completedAt) {
      next.completedAt = patch.completedAt
    }
    if (patch.error !== undefined) {
      next.error = patch.error
    }
    if (patch.progress !== undefined) {
      next.progress = patch.progress
    }
    if (patch.result !== undefined) {
      next.result = patch.result
    }

    const tasks = index.tasks.map((task) => (task.taskId === taskId ? next : task))
    await writeJsonAtomic(getTaskRecordPath(next.folderName), next)
    await writeTaskIndex({
      version: INDEX_VERSION,
      tasks: sortTasks(tasks),
    })

    return next
  })
}

export async function appendWikiTaskEvent(input: AppendWikiTaskEventInput): Promise<void> {
  await withWriteLock(async () => {
    const record = await getWikiTaskRecord(input.taskId)
    if (!record) {
      return
    }

    const eventPath = getTaskEventsPath(record.folderName)
    const line = `${JSON.stringify({
      type: input.type,
      timestamp: input.timestamp,
      taskId: input.taskId,
      state: input.task.state,
      progress: input.task.progress,
      error: input.task.error,
    })}\n`
    await appendFile(eventPath, line, 'utf-8')
  })
}

export async function persistWikiTaskArtifacts(input: PersistWikiTaskArtifactsInput): Promise<void> {
  await withWriteLock(async () => {
    const record = await getWikiTaskRecord(input.taskId)
    if (!record) {
      return
    }

    const folderPath = getTaskFolderPath(record.folderName)
    const wikiRoot = join(folderPath, 'wiki')
    const pagesRoot = join(wikiRoot, 'pages')
    await mkdir(pagesRoot, { recursive: true })

    await writeFile(join(wikiRoot, 'latest.md'), `${input.markdown}\n`, 'utf-8')
    for (const page of input.pages) {
      await writeFile(join(pagesRoot, `${page.id}.md`), `${page.content}\n`, 'utf-8')
    }

    const summaryForTaskDir: PluginAiIndexSummary = {
      ...input.summary,
      markdownPath: 'wiki/latest.md',
      pages: (input.summary.pages ?? []).map((page) => ({
        ...page,
        path: `wiki/pages/${page.id}.md`,
      })),
    }
    await writeJsonAtomic(join(wikiRoot, 'latest-index-summary.json'), summaryForTaskDir)
  })
}

export async function applyWikiTaskSnapshot(task: PluginTaskSnapshot): Promise<void> {
  await updateWikiTaskRecord(task.taskId, {
    state: task.state,
    progress: task.progress,
    result: task.result,
    error: task.error,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  })
}

export async function listRecoverableWikiTasks(pluginId: string): Promise<WikiTaskPersistedRecord[]> {
  const tasks = await listWikiTaskRecords(pluginId)
  return tasks.filter((task) => task.state === 'running' || task.state === 'paused')
}

