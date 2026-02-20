/**
 * PluginSettings - 插件管理页
 *
 * 支持本地路径安装、启用/禁用、卸载与能力调用测试。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FolderOpen, Loader2, Plug, Power, Trash2, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
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

const WIKI_PLUGIN_ID = 'wiki-local-repository-plugin'
const WIKI_CAPABILITY_KEY = 'wiki:local-repository'

interface WikiReport {
  rootPath: string
  generatedAt: string
  stats: {
    directories: number
    files: number
    codeFiles: number
  }
  topLevelEntries: Array<{ name: string; type: 'dir' | 'file' }>
  sampleCodeFiles: string[]
  keyFiles: Array<{ path: string; preview: string }>
  markdown: string
}

interface WikiCapabilityResponse {
  success?: boolean
  action?: string
  report?: WikiReport
}

function parseWikiReport(data: unknown): WikiReport | null {
  if (!data || typeof data !== 'object') return null

  const payload = data as WikiCapabilityResponse
  if (!payload.report || typeof payload.report !== 'object') return null

  const report = payload.report
  if (typeof report.rootPath !== 'string') return null
  if (typeof report.generatedAt !== 'string') return null
  if (!report.stats || typeof report.stats !== 'object') return null
  if (typeof report.markdown !== 'string') return null

  return report
}

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

  const [wikiRepoPath, setWikiRepoPath] = React.useState('')
  const [wikiBusy, setWikiBusy] = React.useState(false)
  const [wikiError, setWikiError] = React.useState<string | null>(null)
  const [wikiReport, setWikiReport] = React.useState<WikiReport | null>(null)

  const wikiPlugin = React.useMemo(
    () => plugins.find((plugin) => plugin.id === WIKI_PLUGIN_ID) ?? null,
    [plugins],
  )
  const wikiPluginActive = wikiPlugin?.state === 'active'
  const wikiPluginPending = wikiPlugin ? pendingMap[wikiPlugin.id] === true : false

  React.useEffect(() => {
    void loadPlugins()
  }, [loadPlugins])

  const handlePickFolder = async (): Promise<void> => {
    const folder = await window.electronAPI.openFolderDialog()
    if (!folder) return
    setInstallPath(folder.path)
  }

  const handlePickWikiRepo = async (): Promise<void> => {
    const folder = await window.electronAPI.openFolderDialog()
    if (!folder) return
    setWikiRepoPath(folder.path)
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

  const handleGenerateWiki = async (): Promise<void> => {
    if (!wikiPlugin || !wikiPluginActive || !wikiRepoPath.trim()) return

    setWikiBusy(true)
    setWikiError(null)

    try {
      const result = await invokeCapability({
        pluginId: wikiPlugin.id,
        capabilityKey: WIKI_CAPABILITY_KEY,
        payload: {
          action: 'analyze',
          repoPath: wikiRepoPath.trim(),
        },
      })

      if (!result.success) {
        setWikiError(result.error ?? 'Wiki 生成失败')
        return
      }

      const report = parseWikiReport(result.data)
      if (!report) {
        setWikiError('Wiki 结果格式无效')
        return
      }

      setWikiReport(report)
    } finally {
      setWikiBusy(false)
    }
  }

  const handleLoadLatestWiki = async (): Promise<void> => {
    if (!wikiPlugin || !wikiPluginActive) return

    setWikiBusy(true)
    setWikiError(null)

    try {
      const result = await invokeCapability({
        pluginId: wikiPlugin.id,
        capabilityKey: WIKI_CAPABILITY_KEY,
        payload: { action: 'get-latest' },
      })

      if (!result.success) {
        const normalizedError = (result.error ?? '').toLowerCase()
        if (normalizedError.includes('enoent') || normalizedError.includes('no such file')) {
          setWikiError('尚未生成 Wiki，请先执行“分析并生成”')
          return
        }
        setWikiError(result.error ?? '读取 Wiki 失败')
        return
      }

      const report = parseWikiReport(result.data)
      if (!report) {
        setWikiError('Wiki 结果格式无效')
        return
      }

      setWikiReport(report)
    } finally {
      setWikiBusy(false)
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
        title="Wiki 插件（本地仓库）"
        description="通过插件能力分析本地代码仓库并生成可浏览的 Wiki 内容"
      >
        <SettingsCard divided={false}>
          <div className="p-4 space-y-4">
            {!wikiPlugin && (
              <p className="text-sm text-muted-foreground">
                未检测到 Wiki 插件，请先在上方安装内置目录插件。
              </p>
            )}

            {wikiPlugin && (
              <>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">状态：</span>
                  <span className={wikiPluginActive ? 'text-emerald-600' : 'text-muted-foreground'}>
                    {wikiPlugin.state}
                  </span>
                  {!wikiPluginActive && (
                    <span className="text-muted-foreground">（插件未启用，Wiki 入口已禁用）</span>
                  )}
                </div>

                <div className="flex gap-2">
                  <Input
                    value={wikiRepoPath}
                    onChange={(event) => setWikiRepoPath(event.target.value)}
                    placeholder="选择本地代码仓库路径"
                    disabled={!wikiPluginActive || wikiBusy || wikiPluginPending}
                  />
                  <Button
                    variant="outline"
                    onClick={() => void handlePickWikiRepo()}
                    disabled={!wikiPluginActive || wikiBusy || wikiPluginPending}
                  >
                    <FolderOpen size={14} />
                    <span>选择仓库</span>
                  </Button>
                  <Button
                    onClick={() => void handleGenerateWiki()}
                    disabled={!wikiPluginActive || !wikiRepoPath.trim() || wikiBusy || wikiPluginPending}
                  >
                    {wikiBusy ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                    <span>分析并生成</span>
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void handleLoadLatestWiki()}
                    disabled={!wikiPluginActive || wikiBusy || wikiPluginPending}
                  >
                    <span>读取最新</span>
                  </Button>
                </div>

                {wikiError && (
                  <p className="text-sm text-destructive">{wikiError}</p>
                )}

                {wikiReport && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-3 text-sm">
                      <div className="rounded-md bg-muted/40 px-3 py-2">
                        <div className="text-xs text-muted-foreground">目录</div>
                        <div className="font-medium">{wikiReport.stats.directories}</div>
                      </div>
                      <div className="rounded-md bg-muted/40 px-3 py-2">
                        <div className="text-xs text-muted-foreground">文件</div>
                        <div className="font-medium">{wikiReport.stats.files}</div>
                      </div>
                      <div className="rounded-md bg-muted/40 px-3 py-2">
                        <div className="text-xs text-muted-foreground">代码文件</div>
                        <div className="font-medium">{wikiReport.stats.codeFiles}</div>
                      </div>
                    </div>

                    <p className="text-xs text-muted-foreground">
                      仓库：{wikiReport.rootPath}
                    </p>

                    <ScrollArea className="h-[260px] rounded-md border border-border/60 bg-muted/15">
                      <pre className="p-3 text-xs leading-relaxed whitespace-pre-wrap break-words">
                        {wikiReport.markdown}
                      </pre>
                    </ScrollArea>
                  </div>
                )}
              </>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
