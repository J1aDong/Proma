/**
 * 插件注册表
 *
 * 负责插件索引持久化与基础 CRUD 操作。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  PluginLifecycleState,
  PluginManifest,
  PluginRecord,
  PluginsIndex,
} from '@proma/shared'
import { getPluginsIndexPath } from '../config-paths'

const PLUGINS_INDEX_VERSION = 1

function createEmptyIndex(): PluginsIndex {
  return {
    version: PLUGINS_INDEX_VERSION,
    plugins: [],
  }
}

/** 读取插件索引 */
export function readPluginsIndex(): PluginsIndex {
  const indexPath = getPluginsIndexPath()

  if (!existsSync(indexPath)) {
    return createEmptyIndex()
  }

  try {
    const raw = readFileSync(indexPath, 'utf-8')
    return JSON.parse(raw) as PluginsIndex
  } catch (error) {
    console.error('[插件] 读取插件索引失败:', error)
    return createEmptyIndex()
  }
}

/** 写入插件索引 */
export function writePluginsIndex(index: PluginsIndex): void {
  try {
    writeFileSync(getPluginsIndexPath(), JSON.stringify(index, null, 2), 'utf-8')
  } catch (error) {
    console.error('[插件] 写入插件索引失败:', error)
    throw new Error('写入插件索引失败')
  }
}

/** 获取全部插件记录 */
export function listPluginRecords(): PluginRecord[] {
  const index = readPluginsIndex()
  return [...index.plugins].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 获取单个插件记录 */
export function getPluginRecord(pluginId: string): PluginRecord | undefined {
  const index = readPluginsIndex()
  return index.plugins.find((item) => item.id === pluginId)
}

/** 新增插件记录 */
export function addPluginRecord(record: PluginRecord): void {
  const index = readPluginsIndex()
  const exists = index.plugins.some((item) => item.id === record.id)
  if (exists) {
    throw new Error(`插件已存在: ${record.id}`)
  }

  index.plugins.push(record)
  writePluginsIndex(index)
}

/** 更新插件状态 */
export function updatePluginState(
  pluginId: string,
  state: PluginLifecycleState,
  options?: { lastError?: string },
): PluginRecord {
  const index = readPluginsIndex()
  const target = index.plugins.find((item) => item.id === pluginId)
  if (!target) {
    throw new Error(`插件不存在: ${pluginId}`)
  }

  target.state = state
  target.updatedAt = Date.now()
  target.lastError = options?.lastError

  writePluginsIndex(index)
  return target
}

/** 更新插件 manifest */
export function updatePluginManifest(pluginId: string, manifest: PluginManifest): PluginRecord {
  const index = readPluginsIndex()
  const target = index.plugins.find((item) => item.id === pluginId)
  if (!target) {
    throw new Error(`插件不存在: ${pluginId}`)
  }

  target.manifest = manifest
  target.updatedAt = Date.now()

  writePluginsIndex(index)
  return target
}

/** 删除插件记录 */
export function removePluginRecord(pluginId: string): PluginRecord | null {
  const index = readPluginsIndex()
  const indexToRemove = index.plugins.findIndex((item) => item.id === pluginId)
  if (indexToRemove === -1) {
    return null
  }

  const removed = index.plugins.splice(indexToRemove, 1)[0] || null
  writePluginsIndex(index)
  return removed
}
