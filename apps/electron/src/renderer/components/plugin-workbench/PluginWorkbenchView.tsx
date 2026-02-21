import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  loadPluginWorkbenchCanvasAtom,
  pluginWorkbenchActionPendingMapAtom,
  pluginWorkbenchCanvasAtom,
  pluginWorkbenchCanvasErrorAtom,
  pluginWorkbenchCanvasErrorCodeAtom,
  pluginWorkbenchCanvasLoadingAtom,
  pluginWorkbenchListAtom,
  pluginWorkbenchListErrorAtom,
  pluginWorkbenchListLoadingAtom,
  selectedPluginWorkbenchItemAtom,
  invokePluginWorkbenchActionAtom,
} from '@/atoms'
import { PluginWorkbenchRenderer } from './PluginWorkbenchRenderer'
import {
  PluginWorkbenchEmptyState,
  PluginWorkbenchErrorState,
  PluginWorkbenchLoadingState,
  PluginWorkbenchNoHookState,
} from './PluginWorkbenchStates'

export function PluginWorkbenchView(): React.ReactElement {
  const list = useAtomValue(pluginWorkbenchListAtom)
  const listLoading = useAtomValue(pluginWorkbenchListLoadingAtom)
  const listError = useAtomValue(pluginWorkbenchListErrorAtom)
  const selectedItem = useAtomValue(selectedPluginWorkbenchItemAtom)

  const canvas = useAtomValue(pluginWorkbenchCanvasAtom)
  const canvasLoading = useAtomValue(pluginWorkbenchCanvasLoadingAtom)
  const canvasError = useAtomValue(pluginWorkbenchCanvasErrorAtom)
  const canvasErrorCode = useAtomValue(pluginWorkbenchCanvasErrorCodeAtom)
  const actionPendingMap = useAtomValue(pluginWorkbenchActionPendingMapAtom)

  const loadCanvas = useSetAtom(loadPluginWorkbenchCanvasAtom)
  const invokeAction = useSetAtom(invokePluginWorkbenchActionAtom)

  const [capabilityKeyMap, setCapabilityKeyMap] = React.useState<Record<string, string[]>>({})

  const loadPluginCapabilities = React.useCallback(async () => {
    try {
      const plugins = await window.electronAPI.listPlugins()
      const nextMap: Record<string, string[]> = {}
      for (const plugin of plugins) {
        nextMap[plugin.id] = plugin.manifest.capabilities.map((capability) => capability.key)
      }
      setCapabilityKeyMap(nextMap)
    } catch {
      setCapabilityKeyMap({})
    }
  }, [])

  React.useEffect(() => {
    void loadPluginCapabilities()
  }, [loadPluginCapabilities, list.length])

  React.useEffect(() => {
    if (!selectedItem || selectedItem.state !== 'active' || !selectedItem.hasCanvasHook) {
      return
    }

    // 如果当前没有画布且没有在加载、没有报错，主动发起请求
    // 覆盖从其他模式切回来时，由于 selectedItem 没变导致不加载的问题
    if (!canvas && !canvasLoading && !canvasError) {
      void loadCanvas({
        pluginId: selectedItem.pluginId,
        reason: 'initial',
      })
    }
  }, [loadCanvas, selectedItem, canvas, canvasLoading, canvasError])

  const handleReloadCanvas = React.useCallback(() => {
    if (!selectedItem) return
    void loadCanvas({ pluginId: selectedItem.pluginId, reason: 'refresh' })
  }, [loadCanvas, selectedItem])

  if (listLoading && list.length === 0) {
    return <PluginWorkbenchLoadingState label="正在加载插件工作台列表..." />
  }

  if (listError && list.length === 0) {
    return <PluginWorkbenchErrorState message={listError} />
  }

  if (list.length === 0) {
    return <PluginWorkbenchEmptyState />
  }

  return (
    <section className="h-full min-h-0 p-4 overflow-hidden">
      {selectedItem ? (
        selectedItem.state !== 'active' ? (
          <PluginWorkbenchErrorState
            title="插件当前不可用"
            message="该插件未启用。请先前往设置页启用该插件，然后回到 Plugin 模式在此处使用插件工作台功能。"
          />
        ) : !selectedItem.hasCanvasHook && canvasErrorCode === 'WORKBENCH_HOOK_NOT_IMPLEMENTED' ? (
          <PluginWorkbenchNoHookState
            pluginName={selectedItem.name}
            state={selectedItem.state}
            capabilityKeys={capabilityKeyMap[selectedItem.pluginId] ?? []}
          />
        ) : canvasLoading && !canvas ? (
          <PluginWorkbenchLoadingState label="正在加载插件画布..." />
        ) : canvasError ? (
          <PluginWorkbenchErrorState message={canvasError} onRetry={handleReloadCanvas} />
        ) : canvas ? (
          <PluginWorkbenchRenderer
            pluginId={selectedItem.pluginId}
            canvas={canvas}
            actionPendingMap={actionPendingMap}
            onInvokeAction={(action) => {
              void invokeAction({
                pluginId: selectedItem.pluginId,
                action,
              })
            }}
          />
        ) : (
          <PluginWorkbenchEmptyState
            title="暂无画布内容"
            description="插件未返回可展示画布，请尝试刷新。"
          />
        )
      ) : (
        <PluginWorkbenchEmptyState
          title="请选择一个插件"
          description="请在左侧栏 Plugin 区域中选择插件，并在此处使用插件实际功能；若插件不可用，请先到设置页启用。"
        />
      )}
    </section>
  )
}
