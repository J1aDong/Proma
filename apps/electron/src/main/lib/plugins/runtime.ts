/**
 * 插件运行时
 *
 * 提供插件扫描、安装、启用、禁用、卸载等核心流程。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  PluginInstallInput,
  PluginInvokeCapabilityInput,
  PluginInvokeCapabilityResult,
  PluginLifecycleInput,
  PluginManifest,
  PluginOperationResult,
  PluginPermission,
  PluginRecord,
  PluginStatusInput,
  PluginStatusResult,
} from '@proma/shared'
import {
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
  module: import('@proma/shared').PluginModule
  controller: AbortController
  cleanups: Array<() => void | Promise<void>>
}

const activePluginRuntimeMap = new Map<string, ActivePluginRuntime>()

const ALLOWED_PLUGIN_PERMISSIONS: ReadonlySet<PluginPermission> = new Set([
  'filesystem:read',
  'filesystem:write',
  'llm:invoke',
  'mcp:access',
  'events:emit',
])

/** 确保插件目录存在 */
export function ensurePluginRuntimeDirs(): void {
  getPluginsDir()
  getPluginWorkspacesDir()
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

function installBundledPluginIfMissing(pluginSourcePath: string): void {
  const manifestPath = join(pluginSourcePath, 'manifest.json')
  if (!existsSync(manifestPath)) {
    return
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
  validatePluginManifest(manifest)

  if (getPluginRecord(manifest.id)) {
    return
  }

  const installPath = getPluginInstallPath(manifest.id)
  const workspacePath = getPluginWorkspacePath(manifest.id)

  rmSync(installPath, { recursive: true, force: true })
  mkdirSync(installPath, { recursive: true })
  cpSync(pluginSourcePath, installPath, { recursive: true })

  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true })
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
    return {
      success: true,
      pluginId: record.id,
      state: 'active',
      plugin: record,
      message: '插件已处于启用状态',
    }
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
