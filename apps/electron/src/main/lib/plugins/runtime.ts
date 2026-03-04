/**
 * 插件运行时
 *
 * 提供插件扫描、安装、启用、禁用、卸载等核心流程。
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  PluginChannelModel,
  PluginDocumentChatEndInput,
  PluginDocumentChatEvent,
  PluginDocumentChatHistoryInput,
  PluginDocumentChatHistoryResult,
  PluginDocumentChatSendInput,
  PluginDocumentChatSendResult,
  PluginGetWorkbenchCanvasInput,
  PluginStartAiIndexingTaskInput,
  PluginInstallInput,
  PluginInvokeCapabilityInput,
  PluginInvokeCapabilityResult,
  PluginInvokeWorkbenchActionInput,
  PluginLifecycleInput,
  PluginManifest,
  PluginModule,
  PluginOperationResult,
  PluginPermission,
  PluginRecord,
  PluginStatusInput,
  PluginStatusResult,
  PluginTaskControlInput,
  PluginTaskEvent,
  PluginTaskOperationResult,
  PluginTaskStatusInput,
  PluginWorkbenchActionInvokeResult,
  PluginWorkbenchActionTrigger,
  PluginWorkbenchCanvas,
  PluginWorkbenchCanvasResult,
  PluginWorkbenchErrorCode,
  PluginWorkbenchListInput,
  PluginWorkbenchListItem,
  PluginWorkbenchListResult,
  PluginWorkbenchResponse,
  PluginForceSyncBundledInput,
  PluginForceSyncBundledResult,
} from '@proma/shared'
import {
  getConfigDir,
  getPluginInstallPath,
  getPluginWorkspacePath,
  getPluginsDir,
  getPluginWorkspacesDir,
} from '../config-paths'
import { createPluginRuntimeContext } from './api-facade'
import {
  getLatestIndexSummary,
  getPersistedTaskSnapshot,
  markPersistedTaskState,
  recoverAiIndexingTasks,
  startAiIndexingTask,
} from './ai-indexing-service'
import { pluginDocumentChatBridge } from './document-chat-bridge'
import { loadPluginModule } from './loader'
import {
  addPluginRecord,
  getPluginRecord,
  listPluginRecords,
  removePluginRecord,
  updatePluginManifest,
  updatePluginState,
} from './registry'
import { pluginTaskRuntime } from './task-runtime'

interface ActivePluginRuntime {
  record: PluginRecord
  module: PluginModule
  controller: AbortController
  cleanups: Array<() => void | Promise<void>>
}

const activePluginRuntimeMap = new Map<string, ActivePluginRuntime>()

// 防止插件在动作钩子内通过宿主 API 递归触发自身，导致无限递归。
const activeWorkbenchActionPlugins = new Set<string>()

const ALLOWED_PLUGIN_PERMISSIONS: ReadonlySet<PluginPermission> = new Set([
  'filesystem:read',
  'filesystem:write',
  'llm:invoke',
  'mcp:access',
  'events:emit',
  'channels:read',
])

const WORKBENCH_NODE_TYPES: ReadonlySet<string> = new Set([
  'page',
  'panel',
  'split',
  'card',
  'toolbar',
  'markdown',
  'task-status',
  'document-chat',
])

const PLUGIN_WORKBENCH_DEBUG_LOG_NAME_PREFIX = 'plugin-workbench-debug'

/**
 * 获取可用的模型列表
 */
async function getAvailableModels(): Promise<PluginChannelModel[]> {
  const { listChannels } = await import('../channel-manager')
  const channels = listChannels().filter((channel) => channel.enabled)

  const models: PluginChannelModel[] = []

  for (const channel of channels) {
    for (const model of channel.models) {
      if (model.enabled) {
        models.push({
          id: model.id,
          name: model.name || model.id,
          channelName: channel.name,
        })
      }
    }
  }

  return models.sort((a, b) => a.name.localeCompare(b.name))
}

function getPluginWorkbenchDebugLogPath(): string {
  const logsDir = join(getConfigDir(), 'logs')
  mkdirSync(logsDir, { recursive: true })

  const now = new Date()
  const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`

  return join(logsDir, `${PLUGIN_WORKBENCH_DEBUG_LOG_NAME_PREFIX}-${datePart}-${timePart}.log`)
}

let pluginWorkbenchDebugLogPath: string | null = null

function getCurrentPluginWorkbenchDebugLogPath(): string {
  if (pluginWorkbenchDebugLogPath) {
    return pluginWorkbenchDebugLogPath
  }

  pluginWorkbenchDebugLogPath = getPluginWorkbenchDebugLogPath()
  return pluginWorkbenchDebugLogPath
}

export function initializePluginWorkbenchDebugLogSession(): string {
  const logPath = getPluginWorkbenchDebugLogPath()
  pluginWorkbenchDebugLogPath = logPath

  try {
    const line = `${new Date().toISOString()} SESSION_START ${JSON.stringify({ pid: process.pid })}\n`
    appendFileSync(logPath, line, { encoding: 'utf-8', flag: 'a' })

    // 清理旧日志（仅保留最近 10 份）
    const logsDir = join(getConfigDir(), 'logs')
    if (existsSync(logsDir)) {
      const logFiles = readdirSync(logsDir)
        .filter((f) => f.startsWith(PLUGIN_WORKBENCH_DEBUG_LOG_NAME_PREFIX) && f.endsWith('.log'))
        .sort((a, b) => b.localeCompare(a)) // 按名称倒序，时间戳新的在前

      if (logFiles.length > 10) {
        for (const file of logFiles.slice(10)) {
          rmSync(join(logsDir, file), { force: true })
        }
      }
    }
  } catch (error) {
    console.warn('[插件工作台调试] 初始化日志失败:', error)
  }

  return logPath
}

function writePluginWorkbenchDebugLog(event: string, detail: Record<string, unknown>): void {
  try {
    const logPath = getCurrentPluginWorkbenchDebugLogPath()
    const line = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`

    appendFileSync(logPath, line, { encoding: 'utf-8', flag: 'a' })
  } catch (error) {
    console.warn('[插件工作台调试] 写入日志失败:', error)
  }
}

/** 确保插件目录存在 */
export function ensurePluginRuntimeDirs(): void {
  getPluginsDir()
  getPluginWorkspacesDir()
  mkdirSync(join(getConfigDir(), 'logs'), { recursive: true })
}

function getBundledPluginsRoot(): string | null {
  const candidates = [
    resolve(__dirname, 'resources/plugins'),
    resolve(__dirname, '../../resources/plugins'),
    resolve(__dirname, '../../../../resources/plugins'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
      return candidate
    }
  }

  return null
}

async function runPluginCleanup(runtime: ActivePluginRuntime): Promise<void> {
  if (!runtime.controller.signal.aborted) {
    runtime.controller.abort()
  }

  const cleanupErrors: string[] = []
  const cleanups = [...runtime.cleanups].reverse()
  runtime.cleanups.length = 0

  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (cleanupErrors.length > 0) {
    throw new Error(`插件资源回收失败: ${cleanupErrors.join(' | ')}`)
  }
}

function shouldSyncBundledPlugin(
  existing: PluginRecord | null,
  installPath: string,
  bundledManifest: PluginManifest,
): boolean {
  if (!existing) {
    return true
  }

  const installedManifestPath = join(installPath, 'manifest.json')
  if (!existsSync(installedManifestPath)) {
    return true
  }

  // 仅在版本升级时同步内置插件，避免每次启动覆盖安装目录导致插件不可预测。
  return existing.manifest.version !== bundledManifest.version
}

function installBundledPluginIfMissing(pluginSourcePath: string): void {
  const manifestPath = join(pluginSourcePath, 'manifest.json')
  if (!existsSync(manifestPath)) {
    return
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
  validatePluginManifest(manifest)

  const existing = getPluginRecord(manifest.id)
  const installPath = getPluginInstallPath(manifest.id)
  const workspacePath = getPluginWorkspacePath(manifest.id)
  const needSync = shouldSyncBundledPlugin(existing ?? null, installPath, manifest)

  if (needSync) {
    rmSync(installPath, { recursive: true, force: true })
    mkdirSync(installPath, { recursive: true })
    cpSync(pluginSourcePath, installPath, { recursive: true })
  }

  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true })
  }

  if (existing) {
    if (needSync) {
      updatePluginManifest(manifest.id, manifest)
      if (existing.state === 'uninstalled') {
        updatePluginState(manifest.id, 'inactive')
      }
      console.log(`[插件] 已同步内置插件: ${manifest.id} v${manifest.version}`)
    }
    return
  }

  const now = Date.now()
  addPluginRecord({
    id: manifest.id,
    manifest,
    installPath,
    workspacePath,
    state: 'installed',
    installedAt: now,
    updatedAt: now,
  })

  console.log(`[插件] 已安装内置插件: ${manifest.id}`)
}

function syncBundledPlugins(): void {
  const bundledRoot = getBundledPluginsRoot()
  if (!bundledRoot) {
    return
  }

  const entries = readdirSync(bundledRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const pluginSourcePath = join(bundledRoot, entry.name)
    try {
      installBundledPluginIfMissing(pluginSourcePath)
    } catch (error) {
      console.warn(`[插件] 安装内置插件失败: ${entry.name}`, error)
    }
  }
}

/** 扫描并恢复已安装插件（仅修正 manifest 与状态，不自动启用） */
export function scanInstalledPlugins(): PluginRecord[] {
  ensurePluginRuntimeDirs()
  syncBundledPlugins()

  const records = listPluginRecords()
  for (const record of records) {
    try {
      const manifestPath = join(record.installPath, 'manifest.json')
      if (!existsSync(manifestPath)) {
        updatePluginState(record.id, 'error', { lastError: '缺少 manifest.json' })
        continue
      }

      const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
      validatePluginManifest(parsed)
      updatePluginManifest(record.id, parsed)

      if (record.state === 'uninstalled') {
        updatePluginState(record.id, 'inactive')
      }
    } catch (error) {
      updatePluginState(record.id, 'error', {
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return listPluginRecords()
}

/**
 * 启动时恢复处于 active 状态的插件运行时。
 *
 * 说明：插件索引会持久化 state，但进程重启后内存态 runtime 会丢失，
 * 若不恢复会出现“状态为 active 但无工作台钩子”的不一致。
 */
export async function restoreActivePlugins(): Promise<void> {
  const records = listPluginRecords()

  for (const record of records) {
    if (record.state !== 'active') {
      continue
    }

    const runtimeExists = activePluginRuntimeMap.has(record.id)
    if (runtimeExists) {
      continue
    }

    const result = await enablePlugin({ pluginId: record.id })
    if (!result.success) {
      console.error(`[插件] 恢复激活失败: ${record.id}`, result.error ?? '未知错误')
    }
  }
}

/** 获取插件列表 */
export function listPlugins(): PluginRecord[] {
  return listPluginRecords()
}

/** 从本地路径安装插件 */
export async function installPluginFromLocal(input: PluginInstallInput): Promise<PluginOperationResult> {
  ensurePluginRuntimeDirs()

  if (!input.sourcePath || typeof input.sourcePath !== 'string') {
    throw new Error('无效的插件来源路径')
  }

  if (/^https?:\/\//i.test(input.sourcePath)) {
    throw new Error('仅支持本地路径安装插件，不支持远程 URL')
  }

  const resolvedSourcePath = resolve(input.sourcePath)
  const sourceStats = statSync(resolvedSourcePath, { throwIfNoEntry: false })
  if (!sourceStats || !sourceStats.isDirectory()) {
    throw new Error('插件来源路径不存在或不是目录')
  }

  const sourceManifestPath = join(resolvedSourcePath, 'manifest.json')
  if (!existsSync(sourceManifestPath)) {
    throw new Error('插件来源目录缺少 manifest.json')
  }

  const manifest = JSON.parse(readFileSync(sourceManifestPath, 'utf-8')) as PluginManifest
  validatePluginManifest(manifest)

  const installPath = getPluginInstallPath(manifest.id)
  const workspacePath = getPluginWorkspacePath(manifest.id)

  rmSync(installPath, { recursive: true, force: true })
  mkdirSync(installPath, { recursive: true })
  cpSync(resolvedSourcePath, installPath, { recursive: true })

  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true })
  }

  const now = Date.now()
  const record: PluginRecord = {
    id: manifest.id,
    manifest,
    installPath,
    workspacePath,
    state: 'installed',
    installedAt: now,
    updatedAt: now,
  }

  const existing = getPluginRecord(manifest.id)
  if (existing) {
    updatePluginManifest(manifest.id, manifest)
    updatePluginState(manifest.id, 'installed')
  } else {
    addPluginRecord(record)
  }

  if (input.enableAfterInstall) {
    return enablePlugin({ pluginId: manifest.id })
  }

  const latest = getPluginRecord(manifest.id)
  return {
    success: true,
    pluginId: manifest.id,
    state: latest?.state ?? 'installed',
    plugin: latest ?? record,
    message: '插件安装完成',
  }
}

/** 启用插件 */
export async function enablePlugin(input: PluginLifecycleInput): Promise<PluginOperationResult> {
  const record = getPluginRecord(input.pluginId)
  if (!record) {
    throw new Error(`插件不存在: ${input.pluginId}`)
  }

  if (record.state === 'active') {
    const existingRuntime = activePluginRuntimeMap.get(record.id)
    if (existingRuntime) {
      return {
        success: true,
        pluginId: record.id,
        state: 'active',
        plugin: record,
        message: '插件已处于启用状态',
      }
    }

    console.warn(`[插件] 检测到 active 状态但运行时缺失，正在恢复: ${record.id}`)
  }

  let runtimeToCleanup: ActivePluginRuntime | null = null

  try {
    const module = await loadPluginModule(record.installPath, record.manifest)
    const controller = new AbortController()
    const cleanups: Array<() => void | Promise<void>> = []
    runtimeToCleanup = {
      record,
      module,
      controller,
      cleanups,
    }

    const context = createPluginRuntimeContext(record.manifest, record.installPath, record.workspacePath, {
      abortSignal: controller.signal,
      registerCleanup: (cleanup): void => {
        cleanups.push(cleanup)
      },
      invokePluginCapability: async (capabilityKey, payload): Promise<unknown> => {
        const result = await invokePluginCapability({
          pluginId: record.id,
          capabilityKey,
          payload,
        })

        if (!result.success) {
          throw new Error(result.error ?? `插件能力调用失败: ${capabilityKey}`)
        }

        return result.data
      },
      invokeWorkbenchAction: async (actionInput): Promise<PluginWorkbenchActionInvokeResult> => {
        return invokePluginWorkbenchAction(actionInput)
      },
      startAiIndexingTask: async (taskInput): Promise<PluginTaskOperationResult> => {
        return startPluginAiIndexingTask(taskInput)
      },
      pausePluginTask: async (taskInput): Promise<PluginTaskOperationResult> => {
        return pausePluginTask(taskInput)
      },
      resumePluginTask: async (taskInput): Promise<PluginTaskOperationResult> => {
        return resumePluginTask(taskInput)
      },
      stopPluginTask: async (taskInput): Promise<PluginTaskOperationResult> => {
        return stopPluginTask(taskInput)
      },
      getPluginTaskStatus: async (taskInput): Promise<PluginTaskOperationResult> => {
        return getPluginTaskStatus(taskInput)
      },
      getLatestIndexSummary: async (pluginId, knowledgeBaseId) => {
        return getLatestIndexSummary(pluginId, record.workspacePath, knowledgeBaseId)
      },
      sendDocumentChat: async (chatInput): Promise<PluginDocumentChatSendResult> => {
        return sendPluginDocumentChat(chatInput)
      },
      endDocumentChat: async (chatInput): Promise<{ success: boolean; error?: string }> => {
        return endPluginDocumentChat(chatInput)
      },
      getDocumentChatHistory: async (chatInput): Promise<PluginDocumentChatHistoryResult> => {
        return getPluginDocumentChatHistory(chatInput)
      },
      getAvailableModels,
    })

    if (module.activate) {
      await module.activate(context)
    }

    if (record.id === 'wiki-local-repository-plugin') {
      await recoverAiIndexingTasks({
        pluginId: record.id,
        workspacePath: record.workspacePath,
      })
    }

    const updated = updatePluginState(record.id, 'active')
    activePluginRuntimeMap.set(record.id, {
      record: updated,
      module,
      controller,
      cleanups,
    })

    writePluginWorkbenchDebugLog('ENABLE_PLUGIN_SUCCESS', {
      pluginId: updated.id,
      state: updated.state,
      hasCanvasHook: typeof module.getWorkbenchCanvas === 'function',
      hasActionHook: typeof module.invokeWorkbenchAction === 'function',
    })

    return {
      success: true,
      pluginId: updated.id,
      state: updated.state,
      plugin: updated,
      message: '插件已启用',
    }
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)

    if (runtimeToCleanup) {
      try {
        await runPluginCleanup(runtimeToCleanup)
      } catch (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        message = `${message} | ${cleanupMessage}`
      }
    }

    activePluginRuntimeMap.delete(record.id)
    const updated = updatePluginState(record.id, 'error', { lastError: message })

    writePluginWorkbenchDebugLog('ENABLE_PLUGIN_FAILED', {
      pluginId: updated.id,
      state: updated.state,
      error: message,
    })

    return {
      success: false,
      pluginId: updated.id,
      state: updated.state,
      plugin: updated,
      error: message,
    }
  }
}

/** 禁用插件 */
export async function disablePlugin(input: PluginLifecycleInput): Promise<PluginOperationResult> {
  const record = getPluginRecord(input.pluginId)
  if (!record) {
    throw new Error(`插件不存在: ${input.pluginId}`)
  }

  const activeRuntime = activePluginRuntimeMap.get(record.id)

  // 插件未处于 active 且没有运行态资源时，不做状态覆盖。
  if (!activeRuntime && record.state !== 'active') {
    return {
      success: true,
      pluginId: record.id,
      state: record.state,
      plugin: record,
      message: '插件当前无需禁用',
    }
  }

  const errors: string[] = []

  if (activeRuntime?.module.deactivate) {
    try {
      await activeRuntime.module.deactivate()
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (activeRuntime) {
    try {
      await runPluginCleanup(activeRuntime)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }

    activePluginRuntimeMap.delete(record.id)
  }

  try {
    pluginTaskRuntime.stopTasksForPlugin(record.id)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  try {
    pluginDocumentChatBridge.clearPluginSessions(record.id)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  if (errors.length > 0) {
    const message = errors.join(' | ')
    const updated = updatePluginState(record.id, 'error', { lastError: message })

    return {
      success: false,
      pluginId: updated.id,
      state: updated.state,
      plugin: updated,
      error: message,
    }
  }

  const updated = updatePluginState(record.id, 'inactive')

  return {
    success: true,
    pluginId: updated.id,
    state: updated.state,
    plugin: updated,
    message: '插件已禁用',
  }
}

/** 强制同步内置插件（开发者专用） */
export async function forceSyncBundledPlugin(input: PluginForceSyncBundledInput): Promise<PluginForceSyncBundledResult> {
  const { pluginId } = input

  // 1. 校验目标必须是内置插件
  const bundledRoot = getBundledPluginsRoot()
  if (!bundledRoot) {
    return {
      success: false,
      pluginId,
      stage: 'validate',
      reloaded: false,
      error: '未找到内置插件目录',
    }
  }

  const pluginSourcePath = join(bundledRoot, pluginId)
  const manifestPath = join(pluginSourcePath, 'manifest.json')
  if (!existsSync(manifestPath)) {
    return {
      success: false,
      pluginId,
      stage: 'validate',
      reloaded: false,
      error: `内置插件不存在: ${pluginId}`,
    }
  }

  let bundledManifest: PluginManifest
  try {
    bundledManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
    validatePluginManifest(bundledManifest)
  } catch (error) {
    return {
      success: false,
      pluginId,
      stage: 'validate',
      reloaded: false,
      error: `内置插件 manifest 无效: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (bundledManifest.id !== pluginId) {
    return {
      success: false,
      pluginId,
      stage: 'validate',
      reloaded: false,
      error: `插件 ID 不匹配: manifest.id=${bundledManifest.id}, 期望=${pluginId}`,
    }
  }

  // 2. 记录当前插件状态
  const existing = getPluginRecord(pluginId)
  const wasActive = existing?.state === 'active'
  let reloaded = false

  try {
    // 3. 若 active：先 disable，释放运行态模块实例
    if (wasActive) {
      const disableResult = await disablePlugin({ pluginId })
      if (!disableResult.success) {
        return {
          success: false,
          pluginId,
          stage: 'disable',
          reloaded: false,
          error: `禁用插件失败: ${disableResult.error}`,
        }
      }
    }

    // 4. 忽略版本判定，直接覆盖安装目录
    const installPath = getPluginInstallPath(pluginId)
    const workspacePath = getPluginWorkspacePath(pluginId)

    rmSync(installPath, { recursive: true, force: true })
    mkdirSync(installPath, { recursive: true })
    cpSync(pluginSourcePath, installPath, { recursive: true })

    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true })
    }

    // 5. 更新插件索引中的 manifest/updatedAt
    const now = Date.now()
    if (existing) {
      updatePluginManifest(pluginId, bundledManifest)
      if (existing.state === 'uninstalled') {
        updatePluginState(pluginId, 'inactive')
      }
    } else {
      addPluginRecord({
        id: pluginId,
        manifest: bundledManifest,
        installPath,
        workspacePath,
        state: 'installed',
        installedAt: now,
        updatedAt: now,
      })
    }

    // 6. 若之前 active：执行 enable 重新加载
    if (wasActive) {
      const enableResult = await enablePlugin({ pluginId })
      if (!enableResult.success) {
        return {
          success: false,
          pluginId,
          stage: 'enable',
          reloaded: false,
          error: `重新启用插件失败: ${enableResult.error}`,
          plugin: enableResult.plugin,
        }
      }
      reloaded = true
    }

    const latest = getPluginRecord(pluginId)
    return {
      success: true,
      pluginId,
      stage: 'done',
      reloaded,
      message: `强制同步完成，插件版本: ${bundledManifest.version}`,
      plugin: latest,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      pluginId,
      stage: 'copy',
      reloaded: false,
      error: `强制同步失败: ${message}`,
    }
  }
}

/** 卸载插件（先禁用再删除目录与索引） */
export async function uninstallPlugin(input: PluginLifecycleInput): Promise<PluginOperationResult> {
  const record = getPluginRecord(input.pluginId)
  if (!record) {
    throw new Error(`插件不存在: ${input.pluginId}`)
  }

  await disablePlugin({ pluginId: record.id })

  rmSync(record.installPath, { recursive: true, force: true })
  rmSync(record.workspacePath, { recursive: true, force: true })

  const removed = removePluginRecord(record.id)

  return {
    success: true,
    pluginId: record.id,
    state: 'uninstalled',
    plugin: removed ?? undefined,
    message: '插件已卸载',
  }
}

/** 获取插件状态 */
export function getPluginStatus(input: PluginStatusInput): PluginStatusResult {
  const record = getPluginRecord(input.pluginId)
  if (!record) {
    throw new Error(`插件不存在: ${input.pluginId}`)
  }

  return {
    pluginId: record.id,
    state: record.state,
    lastError: record.lastError,
  }
}

/** 调用插件能力 */
export async function invokePluginCapability(
  input: PluginInvokeCapabilityInput,
): Promise<PluginInvokeCapabilityResult> {
  const record = getPluginRecord(input.pluginId)
  if (!record) {
    return {
      success: false,
      pluginId: input.pluginId,
      capabilityKey: input.capabilityKey,
      error: `插件不存在: ${input.pluginId}`,
    }
  }

  if (record.state !== 'active') {
    return {
      success: false,
      pluginId: record.id,
      capabilityKey: input.capabilityKey,
      error: `插件未启用，当前状态: ${record.state}`,
    }
  }

  const capabilityDeclared = record.manifest.capabilities.some(
    (item) => item.key === input.capabilityKey,
  )
  if (!capabilityDeclared) {
    return {
      success: false,
      pluginId: record.id,
      capabilityKey: input.capabilityKey,
      error: `插件未声明能力: ${input.capabilityKey}`,
    }
  }

  const runtime = activePluginRuntimeMap.get(record.id)
  if (!runtime?.module.invokeCapability) {
    return {
      success: false,
      pluginId: record.id,
      capabilityKey: input.capabilityKey,
      error: '插件未实现 invokeCapability',
    }
  }

  try {
    const data = await runtime.module.invokeCapability(input.capabilityKey, input.payload)
    return {
      success: true,
      pluginId: record.id,
      capabilityKey: input.capabilityKey,
      data,
    }
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)

    if (runtime) {
      try {
        await runPluginCleanup(runtime)
      } catch (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        message = `${message} | ${cleanupMessage}`
      }
    }

    updatePluginState(record.id, 'error', { lastError: message })
    activePluginRuntimeMap.delete(record.id)

    return {
      success: false,
      pluginId: record.id,
      capabilityKey: input.capabilityKey,
      error: message,
    }
  }
}

/** 启动插件 AI 扫描任务 */
export async function startPluginAiIndexingTask(
  input: PluginStartAiIndexingTaskInput,
): Promise<PluginTaskOperationResult> {
  const record = getPluginRecord(input.pluginId)
  if (!record) {
    return {
      success: false,
      error: `插件不存在: ${input.pluginId}`,
    }
  }

  if (record.state !== 'active') {
    return {
      success: false,
      error: `插件未启用，当前状态: ${record.state}`,
    }
  }

  return startAiIndexingTask({
    pluginId: input.pluginId,
    workspacePath: record.workspacePath,
    payload: {
      repositoryPath: input.repositoryPath,
      knowledgeBaseId: input.knowledgeBaseId,
      model: input.model,
      language: input.language,
      analysisDepth: input.analysisDepth,
      scanMode: input.scanMode,
      subagentCount: input.subagentCount,
      maxFileBytesForFullAnalyze: input.maxFileBytesForFullAnalyze,
      chunkStrategy: input.chunkStrategy,
    },
  })
}

/** 暂停插件任务 */
export async function pausePluginTask(input: PluginTaskControlInput): Promise<PluginTaskOperationResult> {
  const runtimeResult = pluginTaskRuntime.pauseTask(input.pluginId, input.taskId)
  if (runtimeResult.success) {
    return runtimeResult
  }

  const persisted = await getPersistedTaskSnapshot(input.pluginId, input.taskId)
  if (!persisted) {
    return runtimeResult
  }

  await markPersistedTaskState({
    taskId: input.taskId,
    state: 'paused',
  })

  return {
    success: true,
    task: {
      ...persisted,
      state: 'paused',
      updatedAt: new Date().toISOString(),
    },
  }
}

/** 继续插件任务 */
export async function resumePluginTask(input: PluginTaskControlInput): Promise<PluginTaskOperationResult> {
  const runtimeResult = pluginTaskRuntime.resumeTask(input.pluginId, input.taskId)
  if (runtimeResult.success) {
    return runtimeResult
  }

  const persisted = await getPersistedTaskSnapshot(input.pluginId, input.taskId)
  if (!persisted) {
    return runtimeResult
  }

  const record = getPluginRecord(input.pluginId)
  if (!record) {
    return {
      success: false,
      error: `插件不存在: ${input.pluginId}`,
    }
  }

  const metadata = persisted.metadata ?? {}
  const repositoryPath = typeof metadata.repositoryPath === 'string' ? metadata.repositoryPath : ''
  if (!repositoryPath) {
    return {
      success: false,
      error: `任务缺少 repositoryPath，无法恢复: ${input.taskId}`,
    }
  }

  return startAiIndexingTask({
    pluginId: input.pluginId,
    workspacePath: record.workspacePath,
    taskId: input.taskId,
    payload: {
      repositoryPath,
      knowledgeBaseId: typeof metadata.knowledgeBaseId === 'string' ? metadata.knowledgeBaseId : undefined,
      model: typeof metadata.model === 'string' ? metadata.model : undefined,
      language: metadata.language === 'en' ? 'en' : 'zh',
      analysisDepth: metadata.analysisDepth === 'deep' ? 'deep' : 'standard',
      scanMode: metadata.scanMode === 'full' ? 'full' : 'smart',
      subagentCount: typeof metadata.subagentCount === 'number' ? metadata.subagentCount : undefined,
      maxFileBytesForFullAnalyze: typeof metadata.maxFileBytesForFullAnalyze === 'number'
        ? metadata.maxFileBytesForFullAnalyze
        : undefined,
    },
  })
}

/** 停止插件任务 */
export async function stopPluginTask(input: PluginTaskControlInput): Promise<PluginTaskOperationResult> {
  const runtimeResult = pluginTaskRuntime.stopTask(input.pluginId, input.taskId)
  if (runtimeResult.success) {
    return runtimeResult
  }

  const persisted = await getPersistedTaskSnapshot(input.pluginId, input.taskId)
  if (!persisted) {
    return runtimeResult
  }

  await markPersistedTaskState({
    taskId: input.taskId,
    state: 'stopped',
  })

  return {
    success: true,
    task: {
      ...persisted,
      state: 'stopped',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }
}

/** 查询插件任务状态 */
export async function getPluginTaskStatus(input: PluginTaskStatusInput): Promise<PluginTaskOperationResult> {
  const task = pluginTaskRuntime.getTaskForPlugin(input.pluginId, input.taskId)
  if (task) {
    return {
      success: true,
      task,
    }
  }

  const persisted = await getPersistedTaskSnapshot(input.pluginId, input.taskId)
  if (persisted) {
    return {
      success: true,
      task: persisted,
    }
  }

  return {
    success: false,
    error: `任务不存在: ${input.taskId}`,
  }
}

/** 发送插件文档会话消息 */
export async function sendPluginDocumentChat(
  input: PluginDocumentChatSendInput,
): Promise<PluginDocumentChatSendResult> {
  const record = getPluginRecord(input.pluginId)
  if (!record) {
    return {
      success: false,
      pluginId: input.pluginId,
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId: input.sessionId ?? '',
      error: `插件不存在: ${input.pluginId}`,
    }
  }

  if (record.state !== 'active') {
    return {
      success: false,
      pluginId: input.pluginId,
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId: input.sessionId ?? '',
      error: `插件未启用，当前状态: ${record.state}`,
    }
  }

  return pluginDocumentChatBridge.sendMessage({
    pluginId: input.pluginId,
    workspacePath: record.workspacePath,
    payload: {
      knowledgeBaseId: input.knowledgeBaseId,
      sessionId: input.sessionId,
      model: input.model,
      messages: input.messages,
      topK: input.topK,
    },
  })
}

/** 结束插件文档会话 */
export function endPluginDocumentChat(input: PluginDocumentChatEndInput): { success: boolean; error?: string } {
  return pluginDocumentChatBridge.endSession({
    pluginId: input.pluginId,
    knowledgeBaseId: input.knowledgeBaseId,
    sessionId: input.sessionId,
  })
}

/** 查询插件文档会话历史 */
export function getPluginDocumentChatHistory(
  input: PluginDocumentChatHistoryInput,
): PluginDocumentChatHistoryResult {
  return pluginDocumentChatBridge.getHistory(input)
}

/** 订阅插件任务事件 */
export function onPluginTaskEvent(listener: (event: PluginTaskEvent) => void): () => void {
  return pluginTaskRuntime.onEvent(listener)
}

/** 订阅插件文档会话事件 */
export function onPluginDocumentChatEvent(listener: (event: PluginDocumentChatEvent) => void): () => void {
  return pluginDocumentChatBridge.onEvent(listener)
}

/** 获取插件工作台列表 */
export function listPluginWorkbenches(input?: PluginWorkbenchListInput): PluginWorkbenchListResult {
  const includeInactive = input?.includeInactive ?? true

  const items: PluginWorkbenchListItem[] = listPluginRecords()
    .filter((record) => includeInactive || record.state === 'active')
    .map((record) => {
      const runtime = activePluginRuntimeMap.get(record.id)
      const hasCanvasHook = typeof runtime?.module.getWorkbenchCanvas === 'function'
      return {
        pluginId: record.id,
        name: record.manifest.name,
        description: record.manifest.description,
        state: record.state,
        hasCanvasHook,
      }
    })

  writePluginWorkbenchDebugLog('WORKBENCH_LIST', {
    includeInactive,
    total: items.length,
    items: items.map((item) => ({
      pluginId: item.pluginId,
      state: item.state,
      hasCanvasHook: item.hasCanvasHook,
      runtimeLoaded: activePluginRuntimeMap.has(item.pluginId),
    })),
  })

  return createWorkbenchSuccess(items)
}

/** 获取插件工作台画布 */
export async function getPluginWorkbenchCanvas(
  input: PluginGetWorkbenchCanvasInput,
): Promise<PluginWorkbenchCanvasResult> {
  writePluginWorkbenchDebugLog('GET_CANVAS_REQUEST', {
    pluginId: input.pluginId,
    reason: input.request?.reason ?? 'initial',
  })

  const record = getPluginRecord(input.pluginId)
  if (!record) {
    writePluginWorkbenchDebugLog('GET_CANVAS_REJECTED', {
      pluginId: input.pluginId,
      code: 'PLUGIN_NOT_FOUND',
      message: `插件不存在: ${input.pluginId}`,
    })
    return createWorkbenchError('PLUGIN_NOT_FOUND', `插件不存在: ${input.pluginId}`)
  }

  if (record.state !== 'active') {
    writePluginWorkbenchDebugLog('GET_CANVAS_REJECTED', {
      pluginId: input.pluginId,
      code: 'PLUGIN_NOT_ACTIVE',
      state: record.state,
      message: `插件未启用，当前状态: ${record.state}`,
    })
    return createWorkbenchError('PLUGIN_NOT_ACTIVE', `插件未启用，当前状态: ${record.state}`)
  }

  const runtime = activePluginRuntimeMap.get(record.id)
  if (!runtime?.module.getWorkbenchCanvas) {
    writePluginWorkbenchDebugLog('GET_CANVAS_REJECTED', {
      pluginId: input.pluginId,
      code: 'WORKBENCH_HOOK_NOT_IMPLEMENTED',
      runtimeLoaded: !!runtime,
      state: record.state,
    })
    return createWorkbenchError('WORKBENCH_HOOK_NOT_IMPLEMENTED', '插件未实现 getWorkbenchCanvas')
  }

  try {
    const result = await runtime.module.getWorkbenchCanvas(input.request)
    const normalized = normalizeWorkbenchCanvasResult(result)

    writePluginWorkbenchDebugLog('GET_CANVAS_RESULT', {
      pluginId: input.pluginId,
      success: normalized.success,
      code: normalized.error?.code ?? null,
      message: normalized.error?.message ?? null,
      hasRoot: !!normalized.data?.root,
    })

    return normalized
  } catch (error) {
    const normalizedError = normalizeWorkbenchHookError('WORKBENCH_HOOK_FAILED', error)
    writePluginWorkbenchDebugLog('GET_CANVAS_EXCEPTION', {
      pluginId: input.pluginId,
      code: normalizedError.error?.code ?? 'WORKBENCH_HOOK_FAILED',
      message: normalizedError.error?.message ?? '插件工作台画布钩子执行失败',
    })
    return normalizedError
  }
}

/** 调用插件工作台动作 */
export async function invokePluginWorkbenchAction(
  input: PluginInvokeWorkbenchActionInput,
): Promise<PluginWorkbenchActionInvokeResult> {
  const record = getPluginRecord(input.pluginId)
  if (!record) {
    return createWorkbenchError('PLUGIN_NOT_FOUND', `插件不存在: ${input.pluginId}`)
  }

  if (record.state !== 'active') {
    return createWorkbenchError('PLUGIN_NOT_ACTIVE', `插件未启用，当前状态: ${record.state}`)
  }

  if (!isWorkbenchActionTrigger(input.action)) {
    return createWorkbenchError('WORKBENCH_ACTION_INVALID', '工作台动作参数不合法')
  }

  const runtime = activePluginRuntimeMap.get(record.id)
  if (!runtime?.module.invokeWorkbenchAction) {
    return createWorkbenchError('WORKBENCH_HOOK_NOT_IMPLEMENTED', '插件未实现 invokeWorkbenchAction')
  }

  if (activeWorkbenchActionPlugins.has(record.id)) {
    return createWorkbenchError('WORKBENCH_ACTION_INVALID', '检测到插件工作台动作递归调用，已拒绝执行')
  }

  activeWorkbenchActionPlugins.add(record.id)
  try {
    const result = await runtime.module.invokeWorkbenchAction(input.action)
    return normalizeWorkbenchActionResult(result)
  } catch (error) {
    return normalizeWorkbenchHookError('WORKBENCH_ACTION_FAILED', error)
  } finally {
    activeWorkbenchActionPlugins.delete(record.id)
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function createWorkbenchSuccess<T>(data: T): PluginWorkbenchResponse<T> {
  return {
    success: true,
    data,
  }
}

function createWorkbenchError(
  code: PluginWorkbenchErrorCode,
  message: string,
): PluginWorkbenchResponse<never> {
  return {
    success: false,
    error: {
      code,
      message,
    },
  }
}

function normalizeWorkbenchHookError(
  code: PluginWorkbenchErrorCode,
  error: unknown,
): PluginWorkbenchResponse<never> {
  const message = error instanceof Error ? error.message : String(error)
  return createWorkbenchError(code, message)
}

function isWorkbenchResponseLike(value: unknown): value is PluginWorkbenchResponse<unknown> {
  if (!isObjectRecord(value)) {
    return false
  }

  return typeof value.success === 'boolean'
}

function isWorkbenchActionTrigger(value: unknown): value is PluginWorkbenchActionTrigger {
  if (!isObjectRecord(value)) {
    return false
  }

  if (typeof value.actionId !== 'string' || value.actionId.trim().length === 0) {
    return false
  }

  if (value.payload !== undefined && !isObjectRecord(value.payload)) {
    return false
  }

  if (value.sourceNodeId !== undefined && typeof value.sourceNodeId !== 'string') {
    return false
  }

  return true
}

function isWorkbenchNode(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false
  }

  if (typeof value.type !== 'string' || !WORKBENCH_NODE_TYPES.has(value.type)) {
    return false
  }

  if (value.id !== undefined && typeof value.id !== 'string') {
    return false
  }

  if (value.title !== undefined && typeof value.title !== 'string') {
    return false
  }

  if (value.description !== undefined && typeof value.description !== 'string') {
    return false
  }

  switch (value.type) {
    case 'page':
    case 'panel': {
      return Array.isArray(value.children) && value.children.every((child) => isWorkbenchNode(child))
    }
    case 'split': {
      const hasDirection = value.direction === 'horizontal' || value.direction === 'vertical'
      const hasChildren = Array.isArray(value.children) && value.children.every((child) => isWorkbenchNode(child))
      const hasValidRatios =
        value.ratios === undefined
        || (Array.isArray(value.ratios)
          && value.ratios.every((ratio) => typeof ratio === 'number' && Number.isFinite(ratio)))
      return hasDirection && hasChildren && hasValidRatios
    }
    case 'card': {
      if (value.children === undefined) {
        return true
      }
      return Array.isArray(value.children) && value.children.every((child) => isWorkbenchNode(child))
    }
    case 'toolbar': {
      if (!Array.isArray(value.actions)) {
        return false
      }
      return value.actions.every((action) => {
        if (!isObjectRecord(action)) {
          return false
        }

        if (typeof action.id !== 'string' || action.id.trim().length === 0) {
          return false
        }

        if (typeof action.label !== 'string' || action.label.trim().length === 0) {
          return false
        }

        if (action.description !== undefined && typeof action.description !== 'string') {
          return false
        }

        if (
          action.variant !== undefined
          && (typeof action.variant !== 'string'
            || !['primary', 'secondary', 'ghost', 'danger'].includes(action.variant))
        ) {
          return false
        }

        if (action.disabled !== undefined && typeof action.disabled !== 'boolean') {
          return false
        }

        if (action.payload !== undefined && !isObjectRecord(action.payload)) {
          return false
        }

        if (action.inputs !== undefined) {
          if (!Array.isArray(action.inputs)) {
            return false
          }

          const allInputsValid = action.inputs.every((input) => {
            if (!isObjectRecord(input)) {
              return false
            }

            if (typeof input.key !== 'string' || input.key.trim().length === 0) {
              return false
            }

            if (typeof input.label !== 'string' || input.label.trim().length === 0) {
              return false
            }

            if (typeof input.type !== 'string' || !['text', 'textarea', 'number', 'boolean', 'select', 'path', 'model-select'].includes(input.type)) {
              return false
            }

            if (input.description !== undefined && typeof input.description !== 'string') {
              return false
            }

            if (input.placeholder !== undefined && typeof input.placeholder !== 'string') {
              return false
            }

            if (input.required !== undefined && typeof input.required !== 'boolean') {
              return false
            }

            if (
              input.defaultValue !== undefined
              && typeof input.defaultValue !== 'string'
              && typeof input.defaultValue !== 'number'
              && typeof input.defaultValue !== 'boolean'
            ) {
              return false
            }

            if (input.options !== undefined) {
              if (!Array.isArray(input.options)) {
                return false
              }

              const optionsValid = input.options.every((option) => {
                if (!isObjectRecord(option)) {
                  return false
                }
                return typeof option.label === 'string' && option.label.length > 0
                  && typeof option.value === 'string'
              })

              if (!optionsValid) {
                return false
              }
            }

            if (input.min !== undefined && (typeof input.min !== 'number' || !Number.isFinite(input.min))) {
              return false
            }

            if (input.max !== undefined && (typeof input.max !== 'number' || !Number.isFinite(input.max))) {
              return false
            }

            if (input.step !== undefined && (typeof input.step !== 'number' || !Number.isFinite(input.step))) {
              return false
            }

            if (input.type === 'select') {
              return Array.isArray(input.options) && input.options.length > 0
            }

            return true
          })

          if (!allInputsValid) {
            return false
          }
        }

        return true
      })
    }
    case 'markdown': {
      if (value.content !== undefined && typeof value.content !== 'string') {
        return false
      }

      if (value.sourcePath !== undefined && typeof value.sourcePath !== 'string') {
        return false
      }

      if (value.emptyText !== undefined && typeof value.emptyText !== 'string') {
        return false
      }

      if (value.activePageId !== undefined && typeof value.activePageId !== 'string') {
        return false
      }

      if (value.tocScope !== undefined && value.tocScope !== 'global' && value.tocScope !== 'current') {
        return false
      }

      if (value.pages !== undefined) {
        if (!Array.isArray(value.pages)) {
          return false
        }
        const pagesValid = value.pages.every((page) => {
          if (!isObjectRecord(page)) {
            return false
          }
          if (typeof page.id !== 'string' || page.id.trim().length === 0) {
            return false
          }
          if (typeof page.title !== 'string' || page.title.trim().length === 0) {
            return false
          }
          if (page.content !== undefined && typeof page.content !== 'string') {
            return false
          }
          if (page.sourcePath !== undefined && typeof page.sourcePath !== 'string') {
            return false
          }
          return true
        })
        if (!pagesValid) {
          return false
        }
      }

      if (value.activeRepositoryId !== undefined && typeof value.activeRepositoryId !== 'string') {
        return false
      }

      if (value.repositoryList !== undefined) {
        if (!Array.isArray(value.repositoryList)) {
          return false
        }
        const repositoryListValid = value.repositoryList.every((item) => {
          if (!isObjectRecord(item)) {
            return false
          }
          if (typeof item.id !== 'string' || item.id.trim().length === 0) {
            return false
          }
          if (typeof item.repoPath !== 'string' || item.repoPath.trim().length === 0) {
            return false
          }
          if (typeof item.knowledgeBaseId !== 'string' || item.knowledgeBaseId.trim().length === 0) {
            return false
          }
          if (item.updatedAt !== undefined && typeof item.updatedAt !== 'string') {
            return false
          }
          if (item.lastScannedAt !== undefined && typeof item.lastScannedAt !== 'string') {
            return false
          }
          return true
        })
        if (!repositoryListValid) {
          return false
        }
      }

      return true
    }
    case 'task-status': {
      if (value.taskId !== undefined && typeof value.taskId !== 'string') {
        return false
      }

      if (value.taskType !== undefined && typeof value.taskType !== 'string') {
        return false
      }

      if (value.emptyText !== undefined && typeof value.emptyText !== 'string') {
        return false
      }

      if (value.controlActions !== undefined) {
        if (!Array.isArray(value.controlActions)) {
          return false
        }

        const valid = value.controlActions.every(
          (action) => typeof action === 'string' && ['pause', 'resume', 'stop'].includes(action),
        )
        if (!valid) {
          return false
        }
      }

      return true
    }
    case 'document-chat': {
      if (typeof value.knowledgeBaseId !== 'string' || value.knowledgeBaseId.trim().length === 0) {
        return false
      }

      if (value.sessionId !== undefined && typeof value.sessionId !== 'string') {
        return false
      }

      if (value.model !== undefined && typeof value.model !== 'string') {
        return false
      }

      if (value.placeholder !== undefined && typeof value.placeholder !== 'string') {
        return false
      }

      if (value.emptyText !== undefined && typeof value.emptyText !== 'string') {
        return false
      }

      if (value.topK !== undefined && (typeof value.topK !== 'number' || !Number.isFinite(value.topK))) {
        return false
      }

      return true
    }
    default: {
      return false
    }
  }
}

function isWorkbenchCanvas(value: unknown): value is PluginWorkbenchCanvas {
  if (!isObjectRecord(value)) {
    return false
  }

  if (value.version !== 1) {
    return false
  }

  if (value.title !== undefined && typeof value.title !== 'string') {
    return false
  }

  if (value.description !== undefined && typeof value.description !== 'string') {
    return false
  }

  return isWorkbenchNode(value.root)
}

function normalizeWorkbenchCanvasResult(
  value: unknown,
): PluginWorkbenchCanvasResult {
  if (isWorkbenchResponseLike(value)) {
    if (!value.success) {
      return {
        success: false,
        error: {
          code: value.error?.code ?? 'WORKBENCH_HOOK_FAILED',
          message: value.error?.message ?? '插件工作台画布钩子执行失败',
        },
      }
    }

    if (!isWorkbenchCanvas(value.data)) {
      return createWorkbenchError('WORKBENCH_CANVAS_INVALID', '插件返回的工作台画布结构无效')
    }

    return createWorkbenchSuccess(value.data)
  }

  if (!isWorkbenchCanvas(value)) {
    return createWorkbenchError('WORKBENCH_CANVAS_INVALID', '插件返回的工作台画布结构无效')
  }

  return createWorkbenchSuccess(value)
}

function normalizeWorkbenchActionResult(
  value: unknown,
): PluginWorkbenchActionInvokeResult {
  if (isWorkbenchResponseLike(value)) {
    if (!value.success) {
      return {
        success: false,
        error: {
          code: value.error?.code ?? 'WORKBENCH_ACTION_FAILED',
          message: value.error?.message ?? '插件工作台动作执行失败',
        },
      }
    }

    return createWorkbenchSuccess(value.data)
  }

  return createWorkbenchSuccess(value)
}

function validatePluginManifest(manifest: PluginManifest): void {
  if (manifest.manifestVersion !== 1) {
    throw new Error('manifestVersion 必须为 1')
  }
  if (!manifest.id || !/^[a-zA-Z0-9._-]+$/.test(manifest.id)) {
    throw new Error('manifest.id 缺失或包含非法字符')
  }
  if (!manifest.name) {
    throw new Error('manifest 缺少 name')
  }
  if (!manifest.version) {
    throw new Error('manifest 缺少 version')
  }
  if (!manifest.entry?.main) {
    throw new Error('manifest 缺少 entry.main')
  }
  if (!Array.isArray(manifest.permissions)) {
    throw new Error('manifest.permissions 必须为数组')
  }
  const invalidPermission = manifest.permissions.find((permission) => !ALLOWED_PLUGIN_PERMISSIONS.has(permission))
  if (invalidPermission) {
    throw new Error(`manifest.permissions 包含非法权限: ${invalidPermission}`)
  }
  if (!Array.isArray(manifest.capabilities)) {
    throw new Error('manifest.capabilities 必须为数组')
  }
}
