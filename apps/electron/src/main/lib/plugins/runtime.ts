/**
 * 插件运行时
 *
 * 提供插件扫描、安装、启用、禁用、卸载等核心流程。
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  PluginGetWorkbenchCanvasInput,
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
  PluginWorkbenchActionInvokeResult,
  PluginWorkbenchActionTrigger,
  PluginWorkbenchCanvas,
  PluginWorkbenchCanvasResult,
  PluginWorkbenchErrorCode,
  PluginWorkbenchListInput,
  PluginWorkbenchListItem,
  PluginWorkbenchListResult,
  PluginWorkbenchResponse,
} from '@proma/shared'
import {
  getConfigDir,
  getPluginInstallPath,
  getPluginWorkspacePath,
  getPluginsDir,
  getPluginWorkspacesDir,
} from '../config-paths'
import { createPluginRuntimeContext } from './api-facade'
import { loadPluginModule } from './loader'
import {
  addPluginRecord,
  getPluginRecord,
  listPluginRecords,
  removePluginRecord,
  updatePluginManifest,
  updatePluginState,
} from './registry'

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
])

const WORKBENCH_NODE_TYPES: ReadonlySet<string> = new Set([
  'page',
  'panel',
  'split',
  'card',
  'toolbar',
  'markdown',
])

const PLUGIN_WORKBENCH_DEBUG_LOG_NAME_PREFIX = 'plugin-workbench-debug'

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
    })

    if (module.activate) {
      await module.activate(context)
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

            if (typeof input.type !== 'string' || !['text', 'textarea', 'number', 'boolean', 'select', 'path'].includes(input.type)) {
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
