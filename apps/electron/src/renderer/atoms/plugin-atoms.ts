/**
 * 插件管理状态
 *
 * 管理插件列表、加载状态、操作中状态与错误提示。
 */

import { atom } from 'jotai'
import type {
  PluginInstallInput,
  PluginInvokeCapabilityInput,
  PluginInvokeCapabilityResult,
  PluginLifecycleInput,
  PluginRecord,
  PluginStatusResult,
} from '@proma/shared'

/** 插件列表 */
export const pluginListAtom = atom<PluginRecord[]>([])

/** 是否正在加载插件列表 */
export const pluginLoadingAtom = atom(false)

/** 插件管理错误信息 */
export const pluginErrorAtom = atom<string | null>(null)

/** 插件操作中状态（key=pluginId） */
export const pluginPendingMapAtom = atom<Record<string, boolean>>({})

/** 加载插件列表 */
export const loadPluginsAtom = atom(null, async (_get, set) => {
  set(pluginLoadingAtom, true)
  set(pluginErrorAtom, null)

  try {
    const list = await window.electronAPI.listPlugins()
    set(pluginListAtom, list)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    set(pluginErrorAtom, message)
  } finally {
    set(pluginLoadingAtom, false)
  }
})

/** 本地安装插件 */
export const installPluginFromLocalAtom = atom(
  null,
  async (_get, set, input: PluginInstallInput) => {
    set(pluginLoadingAtom, true)
    set(pluginErrorAtom, null)

    try {
      const result = await window.electronAPI.installPluginFromLocal(input)
      const latest = await window.electronAPI.listPlugins()
      set(pluginListAtom, latest)

      if (!result.success && result.error) {
        set(pluginErrorAtom, result.error)
      }

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(pluginErrorAtom, message)
      throw error
    } finally {
      set(pluginLoadingAtom, false)
    }
  },
)

/** 启用插件 */
export const enablePluginAtom = atom(
  null,
  async (_get, set, input: PluginLifecycleInput) => {
    set(pluginErrorAtom, null)
    set(pluginPendingMapAtom, (prev) => ({ ...prev, [input.pluginId]: true }))

    try {
      const result = await window.electronAPI.enablePlugin(input)
      const latest = await window.electronAPI.listPlugins()
      set(pluginListAtom, latest)

      if (!result.success && result.error) {
        set(pluginErrorAtom, result.error)
      }

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(pluginErrorAtom, message)
      throw error
    } finally {
      set(pluginPendingMapAtom, (prev) => ({ ...prev, [input.pluginId]: false }))
    }
  },
)

/** 禁用插件 */
export const disablePluginAtom = atom(
  null,
  async (_get, set, input: PluginLifecycleInput) => {
    set(pluginErrorAtom, null)
    set(pluginPendingMapAtom, (prev) => ({ ...prev, [input.pluginId]: true }))

    try {
      const result = await window.electronAPI.disablePlugin(input)
      const latest = await window.electronAPI.listPlugins()
      set(pluginListAtom, latest)

      if (!result.success && result.error) {
        set(pluginErrorAtom, result.error)
      }

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(pluginErrorAtom, message)
      throw error
    } finally {
      set(pluginPendingMapAtom, (prev) => ({ ...prev, [input.pluginId]: false }))
    }
  },
)

/** 卸载插件 */
export const uninstallPluginAtom = atom(
  null,
  async (_get, set, input: PluginLifecycleInput) => {
    set(pluginErrorAtom, null)
    set(pluginPendingMapAtom, (prev) => ({ ...prev, [input.pluginId]: true }))

    try {
      const result = await window.electronAPI.uninstallPlugin(input)
      const latest = await window.electronAPI.listPlugins()
      set(pluginListAtom, latest)

      if (!result.success && result.error) {
        set(pluginErrorAtom, result.error)
      }

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(pluginErrorAtom, message)
      throw error
    } finally {
      set(pluginPendingMapAtom, (prev) => ({ ...prev, [input.pluginId]: false }))
    }
  },
)

/** 获取插件状态 */
export const getPluginStatusAtom = atom(
  null,
  async (_get, _set, pluginId: string): Promise<PluginStatusResult> => {
    return window.electronAPI.getPluginStatus({ pluginId })
  },
)

/** 调用插件能力 */
export const invokePluginCapabilityAtom = atom(
  null,
  async (_get, set, input: PluginInvokeCapabilityInput): Promise<PluginInvokeCapabilityResult> => {
    set(pluginErrorAtom, null)

    try {
      const result = await window.electronAPI.invokePluginCapability(input)
      if (!result.success && result.error) {
        set(pluginErrorAtom, result.error)
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(pluginErrorAtom, message)
      throw error
    }
  },
)
