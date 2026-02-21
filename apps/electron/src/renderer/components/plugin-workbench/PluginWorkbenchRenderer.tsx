import * as React from 'react'
import { MessageResponse } from '@/components/ai-elements/message'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type {
  PluginWorkbenchActionDefinition,
  PluginWorkbenchActionInputDefinition,
  PluginWorkbenchActionTrigger,
  PluginWorkbenchCanvas,
  PluginWorkbenchNode,
} from '@proma/shared'

interface PluginWorkbenchRendererProps {
  pluginId: string
  canvas: PluginWorkbenchCanvas
  actionPendingMap: Record<string, boolean>
  onInvokeAction: (action: PluginWorkbenchActionTrigger) => void
}

type ActionButtonVariant = 'default' | 'secondary' | 'ghost' | 'destructive'
type ToolbarInputsByNode = Record<string, Record<string, unknown>>

const ACTION_VARIANT_MAP: Record<NonNullable<PluginWorkbenchActionDefinition['variant']>, ActionButtonVariant> = {
  primary: 'default',
  secondary: 'secondary',
  ghost: 'ghost',
  danger: 'destructive',
}

function normalizeSplitRatios(ratios: number[] | undefined, count: number): number[] {
  if (!ratios || ratios.length !== count) {
    return new Array(count).fill(1)
  }

  const normalized = ratios.map((ratio) => (Number.isFinite(ratio) && ratio > 0 ? ratio : 1))
  const sum = normalized.reduce((acc, value) => acc + value, 0)
  if (sum <= 0) {
    return new Array(count).fill(1)
  }

  return normalized.map((value) => value / sum)
}

function getDefaultInputValue(
  action: PluginWorkbenchActionDefinition,
  input: PluginWorkbenchActionInputDefinition,
): unknown {
  const fromPayload = action.payload?.[input.key]
  if (
    typeof fromPayload === 'string'
    || typeof fromPayload === 'number'
    || typeof fromPayload === 'boolean'
  ) {
    return fromPayload
  }

  if (input.defaultValue !== undefined) {
    return input.defaultValue
  }

  if (input.type === 'boolean') {
    return false
  }

  return ''
}

function toTextValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  return ''
}

function toBooleanValue(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return value === 'true'
  }
  return false
}

function buildActionPayload(
  action: PluginWorkbenchActionDefinition,
  values: Record<string, unknown>,
): { payload: Record<string, unknown>; invalid: boolean } {
  const payload: Record<string, unknown> = {
    ...(action.payload ?? {}),
  }

  if (!action.inputs || action.inputs.length === 0) {
    return { payload, invalid: false }
  }

  for (const input of action.inputs) {
    const raw = values[input.key]

    if (input.type === 'boolean') {
      payload[input.key] = toBooleanValue(raw)
      continue
    }

    if (input.type === 'number') {
      const text = typeof raw === 'number' ? String(raw) : toTextValue(raw).trim()
      if (text.length === 0) {
        if (input.required) {
          return { payload, invalid: true }
        }
        delete payload[input.key]
        continue
      }

      const parsed = Number(text)
      if (!Number.isFinite(parsed)) {
        return { payload, invalid: true }
      }

      payload[input.key] = parsed
      continue
    }

    const text = toTextValue(raw).trim()
    if (text.length === 0) {
      if (input.required) {
        return { payload, invalid: true }
      }
      delete payload[input.key]
      continue
    }

    payload[input.key] = text
  }

  return { payload, invalid: false }
}

export function PluginWorkbenchRenderer({
  pluginId,
  canvas,
  actionPendingMap,
  onInvokeAction,
}: PluginWorkbenchRendererProps): React.ReactElement {
  const [toolbarInputValuesMap, setToolbarInputValuesMap] = React.useState<ToolbarInputsByNode>({})

  const updateToolbarInput = React.useCallback((nodeKey: string, inputKey: string, value: unknown): void => {
    setToolbarInputValuesMap((prev) => {
      const nodeValues = prev[nodeKey] ?? {}
      return {
        ...prev,
        [nodeKey]: {
          ...nodeValues,
          [inputKey]: value,
        },
      }
    })
  }, [])

  const renderToolbarInput = (
    nodeKey: string,
    action: PluginWorkbenchActionDefinition,
    input: PluginWorkbenchActionInputDefinition,
  ): React.ReactElement => {
    const nodeValues = toolbarInputValuesMap[nodeKey] ?? {}
    const currentValue = nodeValues[input.key] ?? getDefaultInputValue(action, input)
    const inputId = `${nodeKey}-${action.id}-${input.key}`

    const commonHeader = (
      <div className="space-y-1">
        <Label htmlFor={inputId} className="text-xs">
          {input.label}
          {input.required ? <span className="text-destructive ml-1">*</span> : null}
        </Label>
        {input.description && <p className="text-[11px] text-muted-foreground">{input.description}</p>}
      </div>
    )

    if (input.type === 'boolean') {
      return (
        <div key={inputId} className="min-w-[160px] rounded-md border border-border/60 bg-background/80 px-3 py-2 space-y-2">
          {commonHeader}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{toBooleanValue(currentValue) ? '已启用' : '未启用'}</span>
            <Switch
              checked={toBooleanValue(currentValue)}
              onCheckedChange={(checked) => updateToolbarInput(nodeKey, input.key, checked)}
            />
          </div>
        </div>
      )
    }

    if (input.type === 'select') {
      const options = input.options ?? []
      const fallbackValue = options[0]?.value ?? ''
      const selectValue = toTextValue(currentValue) || fallbackValue

      return (
        <div key={inputId} className="min-w-[220px] space-y-1.5">
          {commonHeader}
          <Select
            value={selectValue}
            onValueChange={(value) => updateToolbarInput(nodeKey, input.key, value)}
          >
            <SelectTrigger id={inputId}>
              <SelectValue placeholder={input.placeholder ?? '请选择'} />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={`${inputId}-${option.value}`} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )
    }

    return (
      <div key={inputId} className="min-w-[280px] space-y-1.5">
        {commonHeader}
        <Input
          id={inputId}
          type={input.type === 'number' ? 'number' : 'text'}
          placeholder={input.placeholder}
          value={toTextValue(currentValue)}
          min={input.type === 'number' ? input.min : undefined}
          max={input.type === 'number' ? input.max : undefined}
          step={input.type === 'number' ? input.step : undefined}
          onChange={(event) => updateToolbarInput(nodeKey, input.key, event.target.value)}
        />
      </div>
    )
  }

  const renderNode = (node: PluginWorkbenchNode, path: string): React.ReactElement => {
    const nodeKey = node.id ?? `${path}-${node.type}`

    switch (node.type) {
      case 'page': {
        return (
          <div key={nodeKey} className="flex h-full min-h-0 min-w-0 flex-col gap-4">
            {(node.title || node.description) && (
              <header className="space-y-1">
                {node.title && <h3 className="text-base font-semibold text-foreground">{node.title}</h3>}
                {node.description && <p className="text-sm text-muted-foreground">{node.description}</p>}
              </header>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              {node.children.map((child, index) => renderNode(child, `${nodeKey}-${index}`))}
            </div>
          </div>
        )
      }

      case 'panel': {
        return (
          <section
            key={nodeKey}
            className="rounded-xl border border-border/60 bg-background/70 p-4 shadow-sm flex min-h-0 min-w-0 flex-col gap-3"
          >
            {(node.title || node.description) && (
              <header className="space-y-1">
                {node.title && <h4 className="text-sm font-semibold text-foreground">{node.title}</h4>}
                {node.description && <p className="text-xs text-muted-foreground">{node.description}</p>}
              </header>
            )}
            <div className="flex min-h-0 min-w-0 flex-col gap-3">
              {node.children.map((child, index) => renderNode(child, `${nodeKey}-${index}`))}
            </div>
          </section>
        )
      }

      case 'split': {
        const ratios = normalizeSplitRatios(node.ratios, node.children.length)
        const isVertical = node.direction === 'vertical'

        return (
          <div
            key={nodeKey}
            className={cn(
              'flex min-h-0 min-w-0 flex-1 gap-3',
              isVertical ? 'flex-col' : 'flex-row',
            )}
          >
            {node.children.map((child, index) => (
              <div
                key={`${nodeKey}-${index}`}
                className="min-h-0 min-w-0 overflow-auto"
                style={{ flex: ratios[index] ?? 1 }}
              >
                {renderNode(child, `${nodeKey}-${index}`)}
              </div>
            ))}
          </div>
        )
      }

      case 'card': {
        return (
          <article
            key={nodeKey}
            className="rounded-xl bg-muted/20 border border-border/50 p-4 space-y-3"
          >
            {(node.title || node.description) && (
              <header className="space-y-1">
                {node.title && <h5 className="text-sm font-semibold text-foreground">{node.title}</h5>}
                {node.description && <p className="text-xs text-muted-foreground">{node.description}</p>}
              </header>
            )}
            {node.children && node.children.length > 0 ? (
              <div className="space-y-3">
                {node.children.map((child, index) => renderNode(child, `${nodeKey}-${index}`))}
              </div>
            ) : null}
          </article>
        )
      }

      case 'toolbar': {
        return (
          <div
            key={nodeKey}
            className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2 space-y-3"
          >
            {node.title && (
              <div className="text-xs font-medium text-muted-foreground">
                {node.title}
              </div>
            )}

            <div className="space-y-3">
              {node.actions.map((action) => {
                const pendingKey = `${pluginId}:${action.id}`
                const isPending = actionPendingMap[pendingKey] === true
                const variant = ACTION_VARIANT_MAP[action.variant ?? 'secondary']
                const nodeInputs = toolbarInputValuesMap[nodeKey] ?? {}
                const { payload, invalid } = buildActionPayload(action, nodeInputs)

                return (
                  <div
                    key={`${nodeKey}-${action.id}`}
                    className="rounded-lg border border-border/60 bg-background/80 p-3 space-y-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium text-foreground">{action.label}</p>
                        {action.description && (
                          <p className="text-xs text-muted-foreground">{action.description}</p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={variant}
                        disabled={action.disabled || isPending || invalid}
                        onClick={() => {
                          onInvokeAction({
                            actionId: action.id,
                            sourceNodeId: node.id,
                            payload,
                          })
                        }}
                      >
                        {isPending ? '执行中...' : action.label}
                      </Button>
                    </div>

                    {action.inputs && action.inputs.length > 0 && (
                      <div className="flex flex-wrap items-start gap-3">
                        {action.inputs.map((input) => renderToolbarInput(nodeKey, action, input))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      }

      case 'markdown': {
        const content = node.content?.trim() ?? ''
        return (
          <div key={nodeKey} className="rounded-xl border border-border/60 bg-background/80 p-4 space-y-2">
            {(node.title || node.description) && (
              <header className="space-y-1">
                {node.title && <h5 className="text-sm font-semibold text-foreground">{node.title}</h5>}
                {node.description && <p className="text-xs text-muted-foreground">{node.description}</p>}
              </header>
            )}

            {node.sourcePath && (
              <p className="text-[11px] font-mono text-muted-foreground">来源：{node.sourcePath}</p>
            )}

            {content.length > 0 ? (
              <MessageResponse>{content}</MessageResponse>
            ) : (
              <p className="text-sm text-muted-foreground">
                {node.emptyText ?? '暂无可展示的 Markdown 内容'}
              </p>
            )}
          </div>
        )
      }

      default: {
        return (
          <div key={nodeKey} className="text-sm text-muted-foreground">
            暂不支持的节点类型
          </div>
        )
      }
    }
  }

  return <div className="h-full min-h-0 min-w-0 overflow-auto">{renderNode(canvas.root, 'root')}</div>
}
