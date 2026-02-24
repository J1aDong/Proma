/**
 * PluginSettings - 插件管理页
 *
 * 支持本地路径安装、启用/禁用、卸载与能力调用测试。
 * 插件实际功能统一在主界面 Plugin 模式中使用。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FolderOpen, Loader2, Plug, Power, Trash2, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { PluginRecord } from '@proma/shared'
import {
  pluginListAtom,
  pluginLoadingAtom,
  pluginErrorAtom,
  pluginPendingMapAtom,
  loadPluginsAtom,
  installPluginFromLocalAtom,
  enablePluginAtom,
  disablePluginAtom,
  uninstallPluginAtom,
  invokePluginCapabilityAtom,
} from '@/atoms/plugin-atoms'
import { SettingsCard, SettingsRow, SettingsSection } from './primitives'

export function PluginSettings(): React.ReactElement {
  const plugins = useAtomValue(pluginListAtom)
  const loading = useAtomValue(pluginLoadingAtom)
  const error = useAtomValue(pluginErrorAtom)
  const pendingMap = useAtomValue(pluginPendingMapAtom)

  const loadPlugins = useSetAtom(loadPluginsAtom)
  const installFromLocal = useSetAtom(installPluginFromLocalAtom)
  const enablePlugin = useSetAtom(enablePluginAtom)
  const disablePlugin = useSetAtom(disablePluginAtom)
  const uninstallPlugin = useSetAtom(uninstallPluginAtom)
  const invokeCapability = useSetAtom(invokePluginCapabilityAtom)

  const [installPath, setInstallPath] = React.useState('')
  const [invokingPluginId, setInvokingPluginId] = React.useState<string | null>(null)
  const [forceSyncLoading, setForceSyncLoading] = React.useState(false)
  const [forceSyncMessage, setForceSyncMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null)

  React.useEffect(() => {
    void loadPlugins()
  }, [loadPlugins])

  const handlePickFolder = async (): Promise<void> => {
    const folder = await window.electronAPI.openFolderDialog()
    if (!folder) return
    setInstallPath(folder.path)
  }

  const handleInstall = async (): Promise<void> => {
    if (!installPath.trim()) return
    await installFromLocal({ sourcePath: installPath.trim(), enableAfterInstall: false })
    setInstallPath('')
  }

  const handleTogglePlugin = async (plugin: PluginRecord): Promise<void> => {
    if (plugin.state === 'active') {
      await disablePlugin({ pluginId: plugin.id })
      return
    }

    await enablePlugin({ pluginId: plugin.id })
  }

  const handleUninstallPlugin = async (plugin: PluginRecord): Promise<void> => {
    if (!confirm(`确定卸载插件「${plugin.manifest.name}」？此操作不可恢复。`)) return
    await uninstallPlugin({ pluginId: plugin.id })
  }

  const handleInvokeTest = async (plugin: PluginRecord): Promise<void> => {
    const capability = plugin.manifest.capabilities[0]?.key
    if (!capability) return

    setInvokingPluginId(plugin.id)
    try {
      await invokeCapability({
        pluginId: plugin.id,
        capabilityKey: capability,
        payload: { action: 'ping' },
      })
    } finally {
      setInvokingPluginId(null)
    }
  }

  const handleForceSyncBundled = async (): Promise<void> => {
    setForceSyncLoading(true)
    setForceSyncMessage(null)

    try {
      await window.electronAPI.forceSyncBundledPlugin({ pluginId: 'wiki-local-repository-plugin' })
      await loadPlugins() // 重新加载插件列表
      setForceSyncMessage({ type: 'success', text: '内置插件同步成功' })
    } catch (error) {
      console.error('强制同步内置插件失败:', error)
      setForceSyncMessage({
        type: 'error',
        text: `同步失败: ${error instanceof Error ? error.message : '未知错误'}`
      })
    } finally {
      setForceSyncLoading(false)
      // 3秒后清除消息
      setTimeout(() => setForceSyncMessage(null), 3000)
    }
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title="本地插件安装"
        description="V1 仅支持本地目录安装，安装目录需包含 manifest.json"
      >
        <SettingsCard divided={false}>
          <div className="p-4 space-y-3">
            <div className="flex gap-2">
              <Input
                value={installPath}
                onChange={(event) => setInstallPath(event.target.value)}
                placeholder="输入或选择本地插件目录路径"
              />
              <Button variant="outline" onClick={() => void handlePickFolder()}>
                <FolderOpen size={14} />
                <span>选择目录</span>
              </Button>
              <Button onClick={() => void handleInstall()} disabled={!installPath.trim() || loading}>
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                <span>安装</span>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              内置 Wiki 插件目录：`apps/electron/resources/plugins/wiki-local-repository-plugin`
            </p>
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="已安装插件"
        description="支持启用、禁用、卸载，操作立即生效"
      >
        {plugins.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="text-sm text-muted-foreground py-10 text-center">
              暂无已安装插件
            </div>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {plugins.map((plugin) => {
              const pending = pendingMap[plugin.id] === true
              const isInvoking = invokingPluginId === plugin.id
              const capabilityCount = plugin.manifest.capabilities.length

              return (
                <SettingsRow
                  key={plugin.id}
                  label={plugin.manifest.name}
                  icon={<Wrench size={18} className="text-blue-500" />}
                  description={`${plugin.id} · ${plugin.state} · ${capabilityCount} 个 capability`}
                  className="group"
                >
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || plugin.state === 'error' || capabilityCount === 0 || isInvoking}
                      onClick={() => void handleInvokeTest(plugin)}
                    >
                      {isInvoking ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
                      <span>测试</span>
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => void handleTogglePlugin(plugin)}
                    >
                      {pending ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
                      <span>{plugin.state === 'active' ? '禁用' : '启用'}</span>
                    </Button>

                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={pending}
                      onClick={() => void handleUninstallPlugin(plugin)}
                    >
                      <Trash2 size={14} />
                      <span>卸载</span>
                    </Button>
                  </div>
                </SettingsRow>
              )
            })}
          </SettingsCard>
        )}
      </SettingsSection>

      <SettingsSection
        title="内置插件管理"
        description="强制同步内置插件到最新版本"
      >
        <SettingsCard divided={false}>
          <div className="p-4 space-y-3">
            <Button
              variant="outline"
              onClick={() => void handleForceSyncBundled()}
              disabled={loading || forceSyncLoading}
            >
              {forceSyncLoading ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
              <span>强制同步内置插件</span>
            </Button>
            <p className="text-xs text-muted-foreground">
              将内置插件强制更新到应用程序包含的最新版本
            </p>
            {forceSyncMessage && (
              <p className={`text-sm ${
                forceSyncMessage.type === 'success'
                  ? 'text-green-600'
                  : 'text-destructive'
              }`}>
                {forceSyncMessage.text}
              </p>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="功能使用入口"
        description="插件实际功能统一在主界面 Plugin 模式中使用"
      >
        <SettingsCard divided={false}>
          <div className="p-4 space-y-2 text-sm text-muted-foreground">
            <p>1. 切换到主界面 Plugin 模式。</p>
            <p>2. 在左侧插件列表选择目标插件。</p>
            <p>3. 在右侧工作台执行插件动作并查看结果。</p>
            <p>若插件不可用，请先在本页完成启用。</p>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
