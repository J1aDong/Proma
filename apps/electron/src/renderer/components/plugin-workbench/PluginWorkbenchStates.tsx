import * as React from 'react'
import { AlertTriangle, LayoutGrid, Plug } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingIndicator } from '@/components/ui/loading-indicator'

interface PluginWorkbenchLoadingStateProps {
  label?: string
}

export function PluginWorkbenchLoadingState({
  label = '正在加载插件工作台...',
}: PluginWorkbenchLoadingStateProps): React.ReactElement {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <LoadingIndicator label={label} showElapsed size="sm" />
    </div>
  )
}

interface PluginWorkbenchEmptyStateProps {
  title?: string
  description?: string
}

export function PluginWorkbenchEmptyState({
  title = '暂无可用插件',
  description = '请先在设置中安装并启用插件。',
}: PluginWorkbenchEmptyStateProps): React.ReactElement {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <div className="max-w-md text-center space-y-3 px-4">
        <div className="mx-auto size-10 rounded-full bg-muted flex items-center justify-center">
          <Plug className="size-5 text-muted-foreground" />
        </div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

interface PluginWorkbenchErrorStateProps {
  title?: string
  message: string
  onRetry?: () => void
}

export function PluginWorkbenchErrorState({
  title = '插件工作台加载失败',
  message,
  onRetry,
}: PluginWorkbenchErrorStateProps): React.ReactElement {
  return (
    <div className="h-full w-full flex items-center justify-center px-4">
      <div className="w-full max-w-xl space-y-3">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
        {onRetry && (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onRetry}>
              重试
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

interface PluginWorkbenchNoHookStateProps {
  pluginName: string
  state: string
  capabilityKeys: string[]
}

export function PluginWorkbenchNoHookState({
  pluginName,
  state,
  capabilityKeys,
}: PluginWorkbenchNoHookStateProps): React.ReactElement {
  return (
    <div className="h-full w-full flex items-center justify-center px-4">
      <div className="w-full max-w-2xl rounded-xl border border-border/60 bg-muted/20 p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-lg bg-muted flex items-center justify-center">
            <LayoutGrid className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground truncate">{pluginName}</h3>
            <p className="text-xs text-muted-foreground">该插件未声明工作台画布钩子，已使用宿主默认占位画布。</p>
          </div>
          <Badge variant="outline" className="ml-auto">
            状态：{state}
          </Badge>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">已声明能力</p>
          {capabilityKeys.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {capabilityKeys.map((key) => (
                <Badge key={key} variant="secondary" className="font-mono text-[11px]">
                  {key}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">暂无 capability 声明</p>
          )}
        </div>
      </div>
    </div>
  )
}
