import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/** @type {import('@proma/shared').PluginRuntimeContext | null} */
let runtimeContext = null

/** @type {(() => void) | null} */
let abortListener = null

const CAPABILITY_KEY = 'wiki:local-repository'
const LATEST_JSON_PATH = 'wiki/latest.json'
const LATEST_MD_PATH = 'wiki/latest.md'
const LATEST_TASK_PATH = 'wiki/latest-task.json'
const LATEST_INDEX_SUMMARY_PATH = 'wiki/latest-index-summary.json'
const WIKI_CONFIG_PATH = 'wiki/config.json'

const WORKBENCH_ERROR_CODE = {
  pluginNotActive: 'PLUGIN_NOT_ACTIVE',
  hookFailed: 'WORKBENCH_HOOK_FAILED',
  actionInvalid: 'WORKBENCH_ACTION_INVALID',
}

const WORKBENCH_ACTION_ID = {
  analyze: 'analyze',
  getLatest: 'get-latest',
  pauseTask: 'pause-task',
  resumeTask: 'resume-task',
  stopTask: 'stop-task',
}

const DEFAULT_WIKI_LANGUAGE = 'zh'
const DEFAULT_ANALYSIS_DEPTH = 'deep'
const DEFAULT_SCAN_MODE = 'smart'
const DEFAULT_SUBAGENT_COUNT = 4
const MAX_SUBAGENT_COUNT = 8
const DEFAULT_MAX_FILE_BYTES_FOR_FULL_ANALYZE = 700 * 1024

/**
 * @typedef {{
 *   defaultSubagentCount: number
 *   scanMode: 'smart' | 'full'
 *   maxFileBytesForFullAnalyze: number
 * }} WikiPluginConfig
 */

/**
 * @param {string} code
 * @param {string} message
 */
function createWorkbenchError(code, message) {
  return {
    success: false,
    error: {
      code,
      message,
    },
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function readWorkspaceFileIfExists(filePath) {
  if (!runtimeContext) {
    return null
  }

  try {
    return await runtimeContext.api.workbench.readFile(filePath)
  } catch {
    return null
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readWorkspaceJsonIfExists(filePath) {
  const raw = await readWorkspaceFileIfExists(filePath)
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * @param {unknown} raw
 * @returns {Array<{ id: string; title: string; path: string }>}
 */
function normalizePageSummaries(raw) {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }
      const page = /** @type {{ id?: unknown; title?: unknown; path?: unknown }} */ (item)
      const id = typeof page.id === 'string' ? page.id.trim() : ''
      const title = typeof page.title === 'string' ? page.title.trim() : ''
      const path = typeof page.path === 'string' ? page.path.trim() : ''
      if (!id || !title || !path) {
        return null
      }
      return { id, title, path }
    })
    .filter((item) => item !== null)
}

/**
 * @param {Array<{ id: string; title: string; path: string }>} pages
 * @returns {Promise<Array<{ id: string; title: string; sourcePath: string; content: string }>>}
 */
async function loadMarkdownPages(pages) {
  const result = []

  for (const page of pages) {
    const content = await readWorkspaceFileIfExists(page.path)
    result.push({
      id: page.id,
      title: page.title,
      sourcePath: page.path,
      content: content ?? '',
    })
  }

  return result
}

/**
 * @param {Record<string, unknown>} payload
 */
function normalizeModel(payload) {
  const model = typeof payload.model === 'string' ? payload.model.trim() : ''
  if (!model || model === '__auto__') {
    return undefined
  }

  return model
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {'zh' | 'en'}
 */
function normalizeLanguage(payload) {
  const language = typeof payload.language === 'string' ? payload.language.trim().toLowerCase() : ''
  if (language === 'en') {
    return 'en'
  }

  return DEFAULT_WIKI_LANGUAGE
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {'standard' | 'deep'}
 */
function normalizeAnalysisDepth(payload) {
  const analysisDepth = typeof payload.analysisDepth === 'string' ? payload.analysisDepth.trim().toLowerCase() : ''
  if (analysisDepth === 'standard') {
    return 'standard'
  }

  return DEFAULT_ANALYSIS_DEPTH
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {'smart' | 'full'}
 */
function normalizeScanMode(payload) {
  const scanMode = typeof payload.scanMode === 'string' ? payload.scanMode.trim().toLowerCase() : ''
  if (scanMode === 'full') {
    return 'full'
  }

  return DEFAULT_SCAN_MODE
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
function clampSubagentCount(raw) {
  const numeric = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SUBAGENT_COUNT
  }

  return Math.max(1, Math.min(MAX_SUBAGENT_COUNT, Math.floor(numeric)))
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {number}
 */
function normalizeSubagentCount(payload) {
  return clampSubagentCount(payload.subagentCount)
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {number}
 */
function normalizeMaxFileBytes(payload) {
  const numeric = typeof payload.maxFileBytesForFullAnalyze === 'number'
    ? payload.maxFileBytesForFullAnalyze
    : Number(payload.maxFileBytesForFullAnalyze)
  if (!Number.isFinite(numeric)) {
    return DEFAULT_MAX_FILE_BYTES_FOR_FULL_ANALYZE
  }

  return Math.max(128 * 1024, Math.min(8 * 1024 * 1024, Math.floor(numeric)))
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function normalizeSaveAsDefault(raw) {
  if (typeof raw === 'boolean') {
    return raw
  }
  if (typeof raw === 'string') {
    return raw.trim().toLowerCase() === 'true'
  }
  return false
}

/**
 * @param {Record<string, unknown> | null} raw
 * @returns {WikiPluginConfig}
 */
function toWikiPluginConfig(raw) {
  return {
    defaultSubagentCount: clampSubagentCount(raw?.defaultSubagentCount),
    scanMode: raw?.scanMode === 'full' ? 'full' : DEFAULT_SCAN_MODE,
    maxFileBytesForFullAnalyze: normalizeMaxFileBytes({
      maxFileBytesForFullAnalyze: raw?.maxFileBytesForFullAnalyze,
    }),
  }
}

/**
 * @returns {Promise<WikiPluginConfig>}
 */
async function readPluginConfig() {
  const raw = await readWorkspaceJsonIfExists(WIKI_CONFIG_PATH)
  return toWikiPluginConfig(raw)
}

/**
 * @param {WikiPluginConfig} config
 */
async function writePluginConfig(config) {
  if (!runtimeContext) {
    return
  }

  await runtimeContext.api.fs.writeText(WIKI_CONFIG_PATH, JSON.stringify(config, null, 2))
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
function normalizeRepoPath(payload) {
  const repoPath = typeof payload.repoPath === 'string' ? payload.repoPath.trim() : ''
  if (!repoPath) {
    throw new Error('缺少 repoPath 参数')
  }

  const resolved = resolve(repoPath)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error('repoPath 不存在或不是目录')
  }

  return resolved
}

/**
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown> | null} latestTask
 */
function resolveTaskId(payload, latestTask) {
  const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : ''
  if (taskId) {
    return taskId
  }

  const fallback = latestTask && typeof latestTask.taskId === 'string' ? latestTask.taskId : ''
  if (!fallback) {
    throw new Error('缺少 taskId，且没有可用的最近任务')
  }

  return fallback
}

/**
 * @param {Record<string, unknown>} latestTask
 */
async function writeLatestTask(latestTask) {
  if (!runtimeContext) {
    return
  }

  await runtimeContext.api.fs.writeText(LATEST_TASK_PATH, JSON.stringify(latestTask, null, 2))
}

/**
 * @param {import('@proma/shared').PluginTaskSnapshot | undefined} task
 */
function getControlActions(task) {
  if (!task) {
    return ['pause', 'resume', 'stop']
  }

  if (task.state === 'running') {
    return ['pause', 'stop']
  }

  if (task.state === 'paused') {
    return ['resume', 'stop']
  }

  return ['pause', 'resume', 'stop']
}

/**
 * 插件激活
 * @param {import('@proma/shared').PluginRuntimeContext} context
 */
export async function activate(context) {
  runtimeContext = context

  abortListener = () => {}
  context.lifecycle.signal.addEventListener('abort', abortListener)

  context.lifecycle.onCleanup(() => {
    if (abortListener) {
      context.lifecycle.signal.removeEventListener('abort', abortListener)
      abortListener = null
    }
  })
}

/**
 * 插件禁用
 */
export async function deactivate() {
  if (runtimeContext && abortListener) {
    runtimeContext.lifecycle.signal.removeEventListener('abort', abortListener)
    abortListener = null
  }

  runtimeContext = null
}

/**
 * 插件能力调用入口
 * @param {Record<string, unknown> | undefined} payload
 * @returns {Promise<unknown>}
 */
async function runCapabilityAction(payload) {
  if (!runtimeContext) {
    throw new Error('插件尚未激活')
  }

  const normalizedPayload = payload ?? {}
  const action = typeof normalizedPayload.action === 'string'
    ? normalizedPayload.action
    : WORKBENCH_ACTION_ID.analyze

  if (action === 'ping') {
    return {
      success: true,
      action: 'ping',
      pluginId: runtimeContext.pluginId,
      message: 'wiki 插件可用',
    }
  }

  if (action === WORKBENCH_ACTION_ID.analyze) {
    runtimeContext.lifecycle.throwIfAborted()

    const repoPath = normalizeRepoPath(normalizedPayload)
    const model = normalizeModel(normalizedPayload)
    const language = normalizeLanguage(normalizedPayload)
    const analysisDepth = normalizeAnalysisDepth(normalizedPayload)
    const scanMode = normalizeScanMode(normalizedPayload)
    const subagentCount = normalizeSubagentCount(normalizedPayload)
    const maxFileBytesForFullAnalyze = normalizeMaxFileBytes(normalizedPayload)
    const saveAsDefault = normalizeSaveAsDefault(normalizedPayload.saveAsDefault)
    const knowledgeBaseId = typeof normalizedPayload.knowledgeBaseId === 'string' && normalizedPayload.knowledgeBaseId.trim()
      ? normalizedPayload.knowledgeBaseId.trim()
      : undefined

    if (saveAsDefault) {
      await writePluginConfig({
        defaultSubagentCount: subagentCount,
        scanMode,
        maxFileBytesForFullAnalyze,
      })
    }

    const startResult = await runtimeContext.api.aiIndexing.startScan({
      repositoryPath: repoPath,
      knowledgeBaseId,
      model,
      language,
      analysisDepth,
      scanMode,
      subagentCount,
      maxFileBytesForFullAnalyze,
    })

    if (!startResult.success || !startResult.task) {
      throw new Error(startResult.error ?? '启动扫描任务失败')
    }

    await writeLatestTask({
      taskId: startResult.task.taskId,
      taskType: startResult.task.taskType,
      state: startResult.task.state,
      repositoryPath: repoPath,
      knowledgeBaseId: startResult.task.metadata?.knowledgeBaseId,
      model: startResult.task.metadata?.model,
      language: startResult.task.metadata?.language,
      analysisDepth: startResult.task.metadata?.analysisDepth,
      scanMode: startResult.task.metadata?.scanMode,
      subagentCount: startResult.task.metadata?.subagentCount,
      maxFileBytesForFullAnalyze,
      updatedAt: startResult.task.updatedAt,
    })

    return {
      success: true,
      action: WORKBENCH_ACTION_ID.analyze,
      task: startResult.task,
    }
  }

  if (
    action === WORKBENCH_ACTION_ID.pauseTask
    || action === WORKBENCH_ACTION_ID.resumeTask
    || action === WORKBENCH_ACTION_ID.stopTask
  ) {
    const latestTask = await readWorkspaceJsonIfExists(LATEST_TASK_PATH)
    const taskId = resolveTaskId(normalizedPayload, latestTask)

    const result = action === WORKBENCH_ACTION_ID.pauseTask
      ? await runtimeContext.api.aiIndexing.pauseTask({ taskId })
      : action === WORKBENCH_ACTION_ID.resumeTask
        ? await runtimeContext.api.aiIndexing.resumeTask({ taskId })
        : await runtimeContext.api.aiIndexing.stopTask({ taskId })

    if (!result.success || !result.task) {
      throw new Error(result.error ?? `任务控制失败: ${action}`)
    }

    await writeLatestTask({
      ...(latestTask ?? {}),
      taskId: result.task.taskId,
      taskType: result.task.taskType,
      state: result.task.state,
      knowledgeBaseId: result.task.metadata?.knowledgeBaseId,
      model: result.task.metadata?.model,
      language: result.task.metadata?.language,
      analysisDepth: result.task.metadata?.analysisDepth,
      updatedAt: result.task.updatedAt,
    })

    return {
      success: true,
      action,
      task: result.task,
    }
  }

  if (action === WORKBENCH_ACTION_ID.getLatest) {
    runtimeContext.lifecycle.throwIfAborted()

    const summary = await runtimeContext.api.aiIndexing.getLatestIndexSummary()
    const markdown = await readWorkspaceFileIfExists(LATEST_MD_PATH)
    const latest = await readWorkspaceJsonIfExists(LATEST_JSON_PATH)

    return {
      success: true,
      action: WORKBENCH_ACTION_ID.getLatest,
      markdown: markdown ?? '',
      latest,
      indexSummary: summary,
      pages: summary?.pages ?? [],
    }
  }

  throw new Error(`不支持的 action: ${action}`)
}

/**
 * 插件能力调用入口
 * @param {string} capabilityKey
 * @param {Record<string, unknown> | undefined} payload
 * @returns {Promise<unknown>}
 */
export async function invokeCapability(capabilityKey, payload) {
  if (!runtimeContext) {
    throw new Error('插件尚未激活')
  }

  if (capabilityKey !== CAPABILITY_KEY) {
    throw new Error(`不支持的 capability: ${capabilityKey}`)
  }

  return runCapabilityAction(payload)
}

/**
 * 插件工作台画布入口
 * @returns {Promise<import('@proma/shared').PluginWorkbenchResponse<import('@proma/shared').PluginWorkbenchCanvas>>}
 */
export async function getWorkbenchCanvas() {
  if (!runtimeContext) {
    return createWorkbenchError(WORKBENCH_ERROR_CODE.pluginNotActive, '插件尚未激活')
  }

  try {
    const latestMarkdown = await readWorkspaceFileIfExists(LATEST_MD_PATH)
    const latestJson = await readWorkspaceJsonIfExists(LATEST_JSON_PATH)
    const latestTask = await readWorkspaceJsonIfExists(LATEST_TASK_PATH)
    const latestIndexSummary = await readWorkspaceJsonIfExists(LATEST_INDEX_SUMMARY_PATH)
    const pluginConfig = await readPluginConfig()

    const summaryPages = normalizePageSummaries(latestIndexSummary?.pages ?? latestJson?.pages)
    const markdownPages = await loadMarkdownPages(summaryPages)
    const hasMultiPages = markdownPages.length > 0
    const activePageId = typeof latestJson?.activePageId === 'string' && latestJson.activePageId.trim().length > 0
      ? latestJson.activePageId.trim()
      : hasMultiPages
        ? markdownPages[0]?.id
        : undefined
    const effectiveMarkdown = hasMultiPages
      ? ''
      : (latestMarkdown ?? '')

    const taskId = latestTask && typeof latestTask.taskId === 'string' ? latestTask.taskId : undefined
    const taskStatus = taskId
      ? await runtimeContext.api.aiIndexing.getTaskStatus({ taskId })
      : null

    const taskSnapshot = taskStatus?.success ? taskStatus.task : undefined
    const knowledgeBaseId = latestIndexSummary && typeof latestIndexSummary.knowledgeBaseId === 'string'
      ? latestIndexSummary.knowledgeBaseId
      : taskSnapshot?.metadata && typeof taskSnapshot.metadata.knowledgeBaseId === 'string'
        ? taskSnapshot.metadata.knowledgeBaseId
        : 'default-kb'

    return {
      success: true,
      data: {
        version: 1,
        root: {
          id: 'wiki-root',
          type: 'page',
          title: '本地仓库 Wiki 工作台（DeepWiki 能力）',
          description: '扫描仓库构建索引后，可在同一画布继续聊天。',
          children: [
            {
              id: 'wiki-controls-panel',
              type: 'panel',
              title: '控制与会话',
              children: [
                {
                  id: 'wiki-toolbar',
                  type: 'toolbar',
                  title: '操作',
                  actions: [
                    {
                      id: WORKBENCH_ACTION_ID.analyze,
                      label: '开始分析',
                      description: '启动 AI 扫描任务（分块 -> 向量化 -> 索引）',
                      variant: 'primary',
                      payload: {
                        action: WORKBENCH_ACTION_ID.analyze,
                        repoPath: '',
                        model: '__auto__',
                        language: DEFAULT_WIKI_LANGUAGE,
                        analysisDepth: DEFAULT_ANALYSIS_DEPTH,
                        scanMode: pluginConfig.scanMode,
                        subagentCount: pluginConfig.defaultSubagentCount,
                        maxFileBytesForFullAnalyze: pluginConfig.maxFileBytesForFullAnalyze,
                        saveAsDefault: false,
                        knowledgeBaseId,
                      },
                      inputs: [
                        {
                          key: 'repoPath',
                          label: '仓库路径',
                          type: 'path',
                          required: true,
                          placeholder: '请输入本地仓库绝对路径，例如 /Users/me/project',
                        },
                        {
                          key: 'model',
                          label: '扫描模型',
                          type: 'model-select',
                          required: true,
                          defaultValue: '__auto__',
                        },
                        {
                          key: 'language',
                          label: '输出语言',
                          type: 'select',
                          required: true,
                          defaultValue: DEFAULT_WIKI_LANGUAGE,
                          options: [
                            {
                              label: '中文',
                              value: 'zh',
                            },
                            {
                              label: 'English',
                              value: 'en',
                            },
                          ],
                        },
                        {
                          key: 'analysisDepth',
                          label: '分析深度',
                          type: 'select',
                          required: true,
                          defaultValue: DEFAULT_ANALYSIS_DEPTH,
                          options: [
                            {
                              label: '深度',
                              value: 'deep',
                            },
                            {
                              label: '标准',
                              value: 'standard',
                            },
                          ],
                        },
                        {
                          key: 'scanMode',
                          label: '扫描模式',
                          type: 'select',
                          required: true,
                          defaultValue: pluginConfig.scanMode,
                          options: [
                            {
                              label: '智能模式（遵循 .gitignore）',
                              value: 'smart',
                            },
                            {
                              label: '全量模式（尽量全扫）',
                              value: 'full',
                            },
                          ],
                        },
                        {
                          key: 'subagentCount',
                          label: '并行 Subagent 数',
                          type: 'number',
                          required: true,
                          min: 1,
                          max: MAX_SUBAGENT_COUNT,
                          step: 1,
                          defaultValue: pluginConfig.defaultSubagentCount,
                        },
                        {
                          key: 'maxFileBytesForFullAnalyze',
                          label: '全文分析大小上限（字节）',
                          type: 'number',
                          required: false,
                          min: 131072,
                          max: 8388608,
                          step: 65536,
                          defaultValue: pluginConfig.maxFileBytesForFullAnalyze,
                        },
                        {
                          key: 'knowledgeBaseId',
                          label: '文档库 ID',
                          type: 'text',
                          placeholder: '可选，默认根据仓库名称推导',
                        },
                        {
                          key: 'saveAsDefault',
                          label: '保存为默认配置',
                          description: '将本次并行数、扫描模式和大小上限写入 wiki/config.json',
                          type: 'boolean',
                          defaultValue: false,
                        },
                      ],
                    },
                    {
                      id: WORKBENCH_ACTION_ID.getLatest,
                      label: '读取最新结果',
                      variant: 'secondary',
                      payload: {
                        action: WORKBENCH_ACTION_ID.getLatest,
                      },
                    },
                  ],
                },
                {
                  id: 'wiki-task-status',
                  type: 'task-status',
                  title: '扫描任务状态',
                  taskId,
                  taskType: 'ai-indexing-scan',
                  controlActions: getControlActions(taskSnapshot),
                  emptyText: '尚未启动扫描任务。请先执行”开始分析”。',
                },
                {
                  id: 'wiki-doc-chat',
                  type: 'document-chat',
                  title: '继续聊天（基于文档库）',
                  knowledgeBaseId,
                  placeholder: '请输入问题，基于最近扫描结果继续提问...',
                  emptyText: '完成扫描后即可继续聊天。',
                  model: latestTask && typeof latestTask.model === 'string' ? latestTask.model : undefined,
                  topK: 6,
                },
              ],
            },
            {
              id: 'wiki-main-panel',
              type: 'panel',
              title: 'Wiki 阅读区',
              children: [
                {
                  id: 'wiki-markdown',
                  type: 'markdown',
                  title: '最新 Wiki 文档',
                  sourcePath: LATEST_MD_PATH,
                  content: effectiveMarkdown,
                  pages: markdownPages,
                  activePageId,
                  tocScope: 'global',
                  emptyText: '还没有分析结果，请先执行”开始分析”。',
                },
              ],
            },
          ],
        },
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return createWorkbenchError(WORKBENCH_ERROR_CODE.hookFailed, message)
  }
}

/**
 * 插件工作台动作入口
 * @param {import('@proma/shared').PluginWorkbenchActionTrigger} action
 * @returns {Promise<import('@proma/shared').PluginWorkbenchResponse<import('@proma/shared').PluginWorkbenchActionResult>>}
 */
export async function invokeWorkbenchAction(action) {
  if (!runtimeContext) {
    return createWorkbenchError(WORKBENCH_ERROR_CODE.pluginNotActive, '插件尚未激活')
  }

  const actionId = action?.actionId
  if (
    actionId !== WORKBENCH_ACTION_ID.analyze
    && actionId !== WORKBENCH_ACTION_ID.getLatest
    && actionId !== WORKBENCH_ACTION_ID.pauseTask
    && actionId !== WORKBENCH_ACTION_ID.resumeTask
    && actionId !== WORKBENCH_ACTION_ID.stopTask
  ) {
    return createWorkbenchError(WORKBENCH_ERROR_CODE.actionInvalid, `不支持的工作台动作: ${String(actionId)}`)
  }

  try {
    const payload = {
      ...(action?.payload ?? {}),
      action: actionId,
    }

    const result = await runCapabilityAction(payload)

    const message = actionId === WORKBENCH_ACTION_ID.analyze
      ? '扫描任务已启动，可在状态区查看进度。'
      : actionId === WORKBENCH_ACTION_ID.getLatest
        ? '已读取最新结果。'
        : `任务控制命令已发送：${actionId}`

    return {
      success: true,
      data: {
        type: 'toast',
        level: 'success',
        message,
        data: result,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return createWorkbenchError(WORKBENCH_ERROR_CODE.hookFailed, message)
  }
}
