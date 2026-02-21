/**
 * 插件工作台状态
 *
 * 与插件管理状态解耦，专门用于 Plugin 模式下的列表/画布/动作交互。
 */

import { atom } from 'jotai'
import type {
  PluginGetWorkbenchCanvasInput,
  PluginInvokeWorkbenchActionInput,
  PluginWorkbenchCanvas,
  PluginWorkbenchListItem,
} from '@proma/shared'

/** 工作台插件列表 */
export const pluginWorkbenchListAtom = atom<PluginWorkbenchListItem[]>([])

/** 工作台列表加载状态 */
export const pluginWorkbenchListLoadingAtom = atom(false)

/** 工作台列表错误信息 */
export const pluginWorkbenchListErrorAtom = atom<string | null>(null)

/** 当前选中的工作台插件 ID */
export const selectedPluginWorkbenchIdAtom = atom<string | null>(null)

/** 当前工作台画布 */
export const pluginWorkbenchCanvasAtom = atom<PluginWorkbenchCanvas | null>(null)

/** 画布加载状态 */
export const pluginWorkbenchCanvasLoadingAtom = atom(false)

/** 画布错误信息 */
export const pluginWorkbenchCanvasErrorAtom = atom<string | null>(null)

/** 画布错误码（用于区分无钩子等可识别场景） */
export const pluginWorkbenchCanvasErrorCodeAtom = atom<string | null>(null)

/** 动作执行中状态（key = pluginId:actionId） */
export const pluginWorkbenchActionPendingMapAtom = atom<Record<string, boolean>>({})

/** 当前选中的工作台插件项 */
export const selectedPluginWorkbenchItemAtom = atom((get) => {
  const selectedId = get(selectedPluginWorkbenchIdAtom)
  if (!selectedId) return null
  return get(pluginWorkbenchListAtom).find((item) => item.pluginId === selectedId) ?? null
})

/** 加载工作台插件列表 */
export const loadPluginWorkbenchListAtom = atom(null, async (get, set) => {
  set(pluginWorkbenchListLoadingAtom, true)
  set(pluginWorkbenchListErrorAtom, null)

  try {
    const result = await window.electronAPI.listPluginWorkbenches({ includeInactive: true })

    if (!result.success) {
      set(pluginWorkbenchListAtom, [])
      set(selectedPluginWorkbenchIdAtom, null)
      set(pluginWorkbenchCanvasAtom, null)
      set(pluginWorkbenchCanvasErrorCodeAtom, null)
      set(pluginWorkbenchListErrorAtom, result.error?.message ?? '加载插件工作台失败')
      return result
    }

    const list = result.data ?? []
    set(pluginWorkbenchListAtom, list)

    const previousSelectedId = get(selectedPluginWorkbenchIdAtom)
    const hasPrevious = previousSelectedId
      ? list.some((item) => item.pluginId === previousSelectedId)
      : false

    if (hasPrevious) {
      return result
    }

    const nextSelectedId =
      list.find((item) => item.state === 'active')?.pluginId
      ?? list[0]?.pluginId
      ?? null

    set(selectedPluginWorkbenchIdAtom, nextSelectedId)

    if (!nextSelectedId) {
      set(pluginWorkbenchCanvasAtom, null)
      set(pluginWorkbenchCanvasErrorAtom, null)
      set(pluginWorkbenchCanvasErrorCodeAtom, null)
    }

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    set(pluginWorkbenchListAtom, [])
    set(selectedPluginWorkbenchIdAtom, null)
    set(pluginWorkbenchCanvasAtom, null)
    set(pluginWorkbenchCanvasErrorCodeAtom, null)
    set(pluginWorkbenchListErrorAtom, message)
    throw error
  } finally {
    set(pluginWorkbenchListLoadingAtom, false)
  }
})

/** 选择工作台插件 */
export const selectPluginWorkbenchAtom = atom(
  null,
  (get, set, pluginId: string | null) => {
    const currentPluginId = get(selectedPluginWorkbenchIdAtom)

    if (pluginId === currentPluginId) {
      return
    }

    set(selectedPluginWorkbenchIdAtom, pluginId)
    set(pluginWorkbenchCanvasAtom, null)
    set(pluginWorkbenchCanvasErrorAtom, null)
    set(pluginWorkbenchCanvasErrorCodeAtom, null)
  },
)

/** 加载工作台画布 */
export const loadPluginWorkbenchCanvasAtom = atom(
  null,
  async (get, set, input?: Partial<PluginGetWorkbenchCanvasInput> & { reason?: 'initial' | 'refresh' }) => {
    const pluginId = input?.pluginId ?? get(selectedPluginWorkbenchIdAtom)
    if (!pluginId) return null

    set(pluginWorkbenchCanvasLoadingAtom, true)
    set(pluginWorkbenchCanvasErrorAtom, null)
    set(pluginWorkbenchCanvasErrorCodeAtom, null)

    try {
      const requestReason = input?.reason ?? 'initial'
      const fetchCanvas = async () => {
        return window.electronAPI.getPluginWorkbenchCanvas({
          pluginId,
          request: {
            reason: requestReason,
          },
        })
      }

      let result = await fetchCanvas()

      // 规避首次点击时 runtime 恢复中的短暂竞争窗口：
      // 若首帧返回“未实现 hook”，做一次极短延迟重试，避免用户必须手动刷新。
      if (!result.success && result.error?.code === 'WORKBENCH_HOOK_NOT_IMPLEMENTED') {
        await new Promise((resolve) => setTimeout(resolve, 120))
        result = await fetchCanvas()
      }

      if (!result.success) {
        set(pluginWorkbenchCanvasAtom, null)
        set(pluginWorkbenchCanvasErrorAtom, result.error?.message ?? '加载插件画布失败')
        set(pluginWorkbenchCanvasErrorCodeAtom, result.error?.code ?? null)
        return result
      }

      set(pluginWorkbenchCanvasAtom, result.data ?? null)
      set(pluginWorkbenchCanvasErrorCodeAtom, null)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(pluginWorkbenchCanvasAtom, null)
      set(pluginWorkbenchCanvasErrorAtom, message)
      set(pluginWorkbenchCanvasErrorCodeAtom, null)
      throw error
    } finally {
      set(pluginWorkbenchCanvasLoadingAtom, false)
    }
  },
)

/** 调用工作台动作 */
export const invokePluginWorkbenchActionAtom = atom(
  null,
  async (get, set, input: PluginInvokeWorkbenchActionInput) => {
    const pendingKey = `${input.pluginId}:${input.action.actionId}`

    set(pluginWorkbenchCanvasErrorAtom, null)
    set(pluginWorkbenchCanvasErrorCodeAtom, null)
    set(pluginWorkbenchActionPendingMapAtom, (prev) => ({
      ...prev,
      [pendingKey]: true,
    }))

    try {
      const result = await window.electronAPI.invokePluginWorkbenchAction(input)

      if (!result.success) {
        set(pluginWorkbenchCanvasErrorAtom, result.error?.message ?? '执行插件动作失败')
        return result
      }

      await set(loadPluginWorkbenchCanvasAtom, {
        pluginId: input.pluginId,
        reason: 'refresh',
      })

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(pluginWorkbenchCanvasErrorAtom, message)
      throw error
    } finally {
      set(pluginWorkbenchActionPendingMapAtom, (prev) => ({
        ...prev,
        [pendingKey]: false,
      }))
    }
  },
)
