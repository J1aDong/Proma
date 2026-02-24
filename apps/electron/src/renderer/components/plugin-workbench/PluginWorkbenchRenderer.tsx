import * as React from 'react'
import { MessageResponse } from '@/components/ai-elements/message'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ModelSelector } from '@/components/chat/ModelSelector'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type {
  PluginDocumentChatEvent,
  PluginDocumentChatMessage,
  PluginDocumentChatReference,
  PluginTaskControlAction,
  PluginTaskSnapshot,
  PluginWorkbenchActionDefinition,
  PluginWorkbenchActionInputDefinition,
  PluginWorkbenchActionTrigger,
  PluginWorkbenchCanvas,
  PluginWorkbenchDocumentChatNode,
  PluginWorkbenchNode,
  PluginWorkbenchTaskStatusNode,
} from '@proma/shared'

interface PluginWorkbenchRendererProps {
  pluginId: string
  canvas: PluginWorkbenchCanvas
  actionPendingMap: Record<string, boolean>
  onInvokeAction: (action: PluginWorkbenchActionTrigger) => void
}

type ActionButtonVariant = 'default' | 'secondary' | 'ghost' | 'destructive'
type ToolbarInputsByNode = Record<string, Record<string, unknown>>
type TaskSnapshotMap = Record<string, PluginTaskSnapshot>

interface ChatUiState {
  knowledgeBaseId: string
  sessionId?: string
  draft: string
  pending: boolean
  error?: string
  references: PluginDocumentChatReference[]
  messages: PluginDocumentChatMessage[]
}

type ChatUiStateMap = Record<string, ChatUiState>

function buildTaskToolbarCollapseKey(
  pluginId: string,
  nodeKey: string,
  taskId: string,
): string {
  return `${pluginId}:${nodeKey}:${taskId}`
}

function shouldTaskToolbarDefaultOpen(state: PluginTaskSnapshot['state']): boolean {
  return state === 'running' || state === 'paused'
}

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

function collectTaskStatusNodes(node: PluginWorkbenchNode, path: string, output: Array<{ nodeKey: string; node: PluginWorkbenchTaskStatusNode }>): void {
  const nodeKey = node.id ?? `${path}-${node.type}`

  if (node.type === 'task-status') {
    output.push({
      nodeKey,
      node,
    })
    return
  }

  if ('children' in node && Array.isArray(node.children)) {
    node.children.forEach((child, index) => {
      collectTaskStatusNodes(child, `${nodeKey}-${index}`, output)
    })
  }
}

function collectDocumentChatNodes(
  node: PluginWorkbenchNode,
  path: string,
  output: Array<{ nodeKey: string; node: PluginWorkbenchDocumentChatNode }>,
): void {
  const nodeKey = node.id ?? `${path}-${node.type}`

  if (node.type === 'document-chat') {
    output.push({
      nodeKey,
      node,
    })
    return
  }

  if ('children' in node && Array.isArray(node.children)) {
    node.children.forEach((child, index) => {
      collectDocumentChatNodes(child, `${nodeKey}-${index}`, output)
    })
  }
}

function createInitialChatState(node: PluginWorkbenchDocumentChatNode): ChatUiState {
  return {
    knowledgeBaseId: node.knowledgeBaseId,
    sessionId: node.sessionId,
    draft: '',
    pending: false,
    error: undefined,
    references: [],
    messages: [],
  }
}

function buildTaskControlKey(pluginId: string, taskId: string, action: PluginTaskControlAction): string {
  return `${pluginId}:${taskId}:${action}`
}

function humanizeTaskState(state: PluginTaskSnapshot['state']): string {
  switch (state) {
    case 'running':
      return '运行中'
    case 'paused':
      return '已暂停'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'stopped':
      return '已停止'
    default:
      return state
  }
}

function applyDocumentChatEvent(state: ChatUiState, event: PluginDocumentChatEvent): ChatUiState {
  if (event.type === 'delta') {
    const messages = [...state.messages]
    const last = messages[messages.length - 1]

    if (last?.role === 'assistant') {
      const updated = {
        ...last,
        content: `${last.content}${event.delta ?? ''}`,
      }
      messages[messages.length - 1] = updated
    } else {
      messages.push({
        role: 'assistant',
        content: event.delta ?? '',
        createdAt: event.timestamp,
      })
    }

    return {
      ...state,
      sessionId: event.sessionId,
      pending: true,
      messages,
      error: undefined,
    }
  }

  if (event.type === 'citation') {
    return {
      ...state,
      sessionId: event.sessionId,
      references: event.references ?? [],
    }
  }

  if (event.type === 'done') {
    return {
      ...state,
      sessionId: event.sessionId,
      pending: false,
      error: undefined,
    }
  }

  if (event.type === 'error') {
    return {
      ...state,
      sessionId: event.sessionId,
      pending: false,
      error: event.error,
    }
  }

  return state
}

export function PluginWorkbenchRenderer({
  pluginId,
  canvas,
  actionPendingMap,
  onInvokeAction,
}: PluginWorkbenchRendererProps): React.ReactElement {
  const [toolbarInputValuesMap, setToolbarInputValuesMap] = React.useState<ToolbarInputsByNode>({})
  const [pathImportPendingMap, setPathImportPendingMap] = React.useState<Record<string, boolean>>({})
  const [taskSnapshotMap, setTaskSnapshotMap] = React.useState<TaskSnapshotMap>({})
  const [taskControlPendingMap, setTaskControlPendingMap] = React.useState<Record<string, boolean>>({})
  const [taskToolbarOpenMap, setTaskToolbarOpenMap] = React.useState<Map<string, boolean>>(new Map())
  const [chatStateMap, setChatStateMap] = React.useState<ChatUiStateMap>({})

  React.useEffect(() => {
    setTaskSnapshotMap({})
    setTaskControlPendingMap({})
    setTaskToolbarOpenMap(new Map())
    setChatStateMap({})
  }, [pluginId])

  React.useEffect(() => {
    const taskNodes: Array<{ nodeKey: string; node: PluginWorkbenchTaskStatusNode }> = []
    collectTaskStatusNodes(canvas.root, 'root', taskNodes)

    const taskIds = taskNodes
      .map((item) => item.node.taskId)
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)

    if (taskIds.length === 0) {
      return
    }

    void Promise.all(taskIds.map(async (taskId) => {
      const result = await window.electronAPI.getPluginTaskStatus({
        pluginId,
        taskId,
      })

      if (result.success && result.task) {
        const taskSnapshot = result.task
        setTaskSnapshotMap((prev) => ({
          ...prev,
          [taskSnapshot.taskId]: taskSnapshot,
        }))
      }
    }))
  }, [canvas, pluginId])

  React.useEffect(() => {
    const chatNodes: Array<{ nodeKey: string; node: PluginWorkbenchDocumentChatNode }> = []
    collectDocumentChatNodes(canvas.root, 'root', chatNodes)

    if (chatNodes.length === 0) {
      return
    }

    setChatStateMap((prev) => {
      const next: ChatUiStateMap = {
        ...prev,
      }

      for (const item of chatNodes) {
        if (!next[item.nodeKey]) {
          next[item.nodeKey] = createInitialChatState(item.node)
        }
      }

      return next
    })

    for (const item of chatNodes) {
      if (!item.node.sessionId) {
        continue
      }

      void window.electronAPI.getPluginDocumentChatHistory({
        pluginId,
        knowledgeBaseId: item.node.knowledgeBaseId,
        sessionId: item.node.sessionId,
      }).then((history) => {
        setChatStateMap((prev) => {
          const current = prev[item.nodeKey] ?? createInitialChatState(item.node)
          return {
            ...prev,
            [item.nodeKey]: {
              ...current,
              sessionId: history.sessionId,
              knowledgeBaseId: history.knowledgeBaseId,
              messages: history.messages,
            },
          }
        })
      }).catch(() => {
        // 会话历史读取失败时保留当前 UI 状态。
      })
    }
  }, [canvas, pluginId])

  React.useEffect(() => {
    const disposeTask = window.electronAPI.onPluginTaskEvent((event) => {
      if (event.task.pluginId !== pluginId) {
        return
      }

      setTaskSnapshotMap((prev) => ({
        ...prev,
        [event.task.taskId]: event.task,
      }))
    })

    const disposeChat = window.electronAPI.onPluginDocumentChatEvent((event) => {
      if (event.pluginId !== pluginId) {
        return
      }

      setChatStateMap((prev) => {
        const next: ChatUiStateMap = {
          ...prev,
        }

        let matched = false

        for (const [nodeKey, current] of Object.entries(next)) {
          const sessionMatches = current.sessionId ? current.sessionId === event.sessionId : true
          if (!sessionMatches || current.knowledgeBaseId !== event.knowledgeBaseId) {
            continue
          }

          next[nodeKey] = applyDocumentChatEvent(current, event)
          matched = true
        }

        if (!matched) {
          const fallbackKey = `session:${event.knowledgeBaseId}:${event.sessionId}`
          const fallbackState: ChatUiState = {
            knowledgeBaseId: event.knowledgeBaseId,
            sessionId: event.sessionId,
            draft: '',
            pending: event.type === 'delta',
            error: event.type === 'error' ? event.error : undefined,
            references: event.references ?? [],
            messages: event.message ? [event.message] : [],
          }

          next[fallbackKey] = applyDocumentChatEvent(fallbackState, event)
        }

        return next
      })
    })

    return () => {
      disposeTask()
      disposeChat()
    }
  }, [pluginId])

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

  const updateChatState = React.useCallback((nodeKey: string, updater: (state: ChatUiState) => ChatUiState, node: PluginWorkbenchDocumentChatNode): void => {
    setChatStateMap((prev) => {
      const current = prev[nodeKey] ?? createInitialChatState(node)
      return {
        ...prev,
        [nodeKey]: updater(current),
      }
    })
  }, [])

  const importPathToToolbarInput = React.useCallback(async (
    nodeKey: string,
    actionId: string,
    inputKey: string,
  ): Promise<void> => {
    const pendingKey = `${nodeKey}:${actionId}:${inputKey}`
    setPathImportPendingMap((prev) => ({
      ...prev,
      [pendingKey]: true,
    }))

    try {
      const result = await window.electronAPI.openFolderDialog()
      if (result?.path) {
        updateToolbarInput(nodeKey, inputKey, result.path)
      }
    } catch {
      // 选择器调用失败时保持当前输入值，用户仍可手动输入路径
    } finally {
      setPathImportPendingMap((prev) => {
        const next = {
          ...prev,
        }
        delete next[pendingKey]
        return next
      })
    }
  }, [updateToolbarInput])

  const controlPluginTask = React.useCallback(async (
    action: PluginTaskControlAction,
    taskId: string,
  ): Promise<void> => {
    const pendingKey = buildTaskControlKey(pluginId, taskId, action)
    setTaskControlPendingMap((prev) => ({
      ...prev,
      [pendingKey]: true,
    }))

    try {
      const payload = {
        pluginId,
        taskId,
      }

      const result = action === 'pause'
        ? await window.electronAPI.pausePluginTask(payload)
        : action === 'resume'
          ? await window.electronAPI.resumePluginTask(payload)
          : await window.electronAPI.stopPluginTask(payload)

      if (result.success && result.task) {
        const taskSnapshot = result.task
        setTaskSnapshotMap((prev) => ({
          ...prev,
          [taskSnapshot.taskId]: taskSnapshot,
        }))
      }
    } finally {
      setTaskControlPendingMap((prev) => ({
        ...prev,
        [pendingKey]: false,
      }))
    }
  }, [pluginId])

  const sendDocumentChat = React.useCallback(async (
    nodeKey: string,
    node: PluginWorkbenchDocumentChatNode,
  ): Promise<void> => {
    const current = chatStateMap[nodeKey] ?? createInitialChatState(node)
    const question = current.draft.trim()
    if (!question) {
      return
    }

    updateChatState(nodeKey, (state) => ({
      ...state,
      pending: true,
      error: undefined,
      draft: '',
      messages: [
        ...state.messages,
        {
          role: 'user',
          content: question,
          createdAt: new Date().toISOString(),
        },
      ],
    }), node)

    const result = await window.electronAPI.sendPluginDocumentChat({
      pluginId,
      knowledgeBaseId: node.knowledgeBaseId,
      sessionId: current.sessionId,
      model: node.model,
      topK: node.topK,
      messages: [
        {
          role: 'user',
          content: question,
        },
      ],
    })

    updateChatState(nodeKey, (state) => ({
      ...state,
      pending: false,
      sessionId: result.sessionId || state.sessionId,
      error: result.success ? undefined : result.error,
    }), node)
  }, [chatStateMap, pluginId, updateChatState])

  const resolveTaskForNode = React.useCallback((node: PluginWorkbenchTaskStatusNode): PluginTaskSnapshot | null => {
    if (node.taskId) {
      return taskSnapshotMap[node.taskId] ?? null
    }

    const candidates = Object.values(taskSnapshotMap)
      .filter((task) => !node.taskType || task.taskType === node.taskType)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    return candidates[0] ?? null
  }, [taskSnapshotMap])

  const setTaskToolbarOpen = React.useCallback((collapseKey: string, open: boolean): void => {
    setTaskToolbarOpenMap((prev) => {
      const next = new Map(prev)
      next.set(collapseKey, open)
      return next
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

    if (input.type === 'model-select') {
      const selectValue = toTextValue(currentValue) || '__auto__'

      return (
        <div key={inputId} className="min-w-[220px] space-y-1.5 flex flex-col items-start">
          {commonHeader}
          <div className="h-9 w-full flex items-center rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm">
            <ModelSelector
              externalSelectedModelId={selectValue}
              onModelSelect={(option) => updateToolbarInput(nodeKey, input.key, option.modelId)}
              includeAutoOption={true}
              triggerClassName="h-full w-full justify-between text-sm px-0 rounded-none border-none hover:bg-transparent"
            />
          </div>
        </div>
      )
    }

    if (input.type === 'path') {
      const pendingKey = `${nodeKey}:${action.id}:${input.key}`
      const isImportPending = pathImportPendingMap[pendingKey] === true

      return (
        <div key={inputId} className="min-w-[460px] space-y-1.5">
          {commonHeader}
          <div className="flex items-center gap-2">
            <Input
              id={inputId}
              type="text"
              placeholder={input.placeholder}
              value={toTextValue(currentValue)}
              onChange={(event) => updateToolbarInput(nodeKey, input.key, event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isImportPending}
              onClick={() => {
                void importPathToToolbarInput(nodeKey, action.id, input.key)
              }}
            >
              {isImportPending ? '导入中...' : '导入(路径)'}
            </Button>
          </div>
        </div>
      )
    }

    return (
      <div key={inputId} className="min-w-[360px] space-y-1.5">
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
          <div key={nodeKey} className="flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-hidden p-4">
            {(node.title || node.description) && (
              <header className="space-y-1 shrink-0">
                {node.title && <h3 className="text-base font-semibold text-foreground">{node.title}</h3>}
                {node.description && <p className="text-sm text-muted-foreground">{node.description}</p>}
              </header>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden">
              {node.children.map((child, index) => renderNode(child, `${nodeKey}-${index}`))}
            </div>
          </div>
        )
      }

      case 'panel': {
        return (
          <section
            key={nodeKey}
            className="rounded-xl border border-border/60 bg-background/70 p-4 shadow-sm flex min-h-0 min-w-0 flex-col gap-3 h-full overflow-hidden"
          >
            {(node.title || node.description) && (
              <header className="space-y-1 shrink-0">
                {node.title && <h4 className="text-sm font-semibold text-foreground">{node.title}</h4>}
                {node.description && <p className="text-xs text-muted-foreground">{node.description}</p>}
              </header>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
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
              'flex min-h-0 min-w-0 flex-1 gap-3 overflow-hidden',
              isVertical ? 'flex-col' : 'flex-row',
            )}
          >
            {node.children.map((child, index) => (
              <div
                key={`${nodeKey}-${index}`}
                className="flex flex-col min-h-0 min-w-0 overflow-hidden"
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
          <div key={nodeKey} className="flex flex-col h-full min-h-0 rounded-xl border border-border/60 bg-background/80 p-4 space-y-2">
            {(node.title || node.description) && (
              <header className="space-y-1 shrink-0">
                {node.title && <h5 className="text-sm font-semibold text-foreground">{node.title}</h5>}
                {node.description && <p className="text-xs text-muted-foreground">{node.description}</p>}
              </header>
            )}

            {node.sourcePath && (
              <p className="text-[11px] font-mono text-muted-foreground shrink-0">来源：{node.sourcePath}</p>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto pr-2">
              {content.length > 0 ? (
                <MessageResponse>{content}</MessageResponse>
              ) : (
                <p className="text-sm text-muted-foreground mt-4">
                  {node.emptyText ?? '暂无可展示的 Markdown 内容'}
                </p>
              )}
            </div>
          </div>
        )
      }

      case 'task-status': {
        const taskNode = node as PluginWorkbenchTaskStatusNode
        const task = resolveTaskForNode(taskNode)

        if (!task) {
          return (
            <div key={nodeKey} className="rounded-xl border border-dashed border-border/70 bg-muted/10 p-4">
              <p className="text-sm text-muted-foreground">
                {taskNode.emptyText ?? '暂无运行中的任务。'}
              </p>
            </div>
          )
        }

        const controls = taskNode.controlActions ?? ['pause', 'resume', 'stop']
        const progressPercent = task.progress?.percent ?? 0
        const collapseKey = buildTaskToolbarCollapseKey(pluginId, nodeKey, task.taskId)
        const defaultOpen = shouldTaskToolbarDefaultOpen(task.state)
        const isOpen = taskToolbarOpenMap.get(collapseKey) ?? defaultOpen

        return (
          <Collapsible
            key={nodeKey}
            open={isOpen}
            onOpenChange={(open) => {
              setTaskToolbarOpen(collapseKey, open)
            }}
            className="rounded-xl border border-border/70 bg-background/80 p-4 space-y-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">任务状态：{humanizeTaskState(task.state)}</p>
                <p className="text-xs text-muted-foreground font-mono">{task.taskId}</p>
                <p className="text-xs text-muted-foreground">类型：{task.taskType}</p>
              </div>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-expanded={isOpen}
                  className="h-8 shrink-0 px-2 text-xs"
                >
                  {isOpen ? '收起工具栏' : '展开工具栏'}
                </Button>
              </CollapsibleTrigger>
            </div>

            <div className="space-y-1">
              <div className="h-2 w-full rounded bg-muted/60 overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }} />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{task.progress?.stage ?? 'pending'}</span>
                <span>{Math.round(progressPercent)}%</span>
              </div>
            </div>

            <CollapsibleContent className="space-y-2">
              {task.progress?.detail && (
                <p className="text-xs text-muted-foreground">{task.progress.detail}</p>
              )}
              {task.error && (
                <p className="text-xs text-destructive">{task.error}</p>
              )}

              <div className="flex flex-wrap gap-2">
                {controls.map((action) => {
                  const pendingKey = buildTaskControlKey(pluginId, task.taskId, action)
                  const pending = taskControlPendingMap[pendingKey] === true
                  const disableByState =
                    action === 'pause'
                      ? task.state !== 'running'
                      : action === 'resume'
                        ? task.state !== 'paused'
                        : task.state !== 'running' && task.state !== 'paused'

                  return (
                    <Button
                      key={`${nodeKey}-${action}`}
                      size="sm"
                      variant={action === 'stop' ? 'destructive' : 'outline'}
                      disabled={pending || disableByState}
                      onClick={() => {
                        void controlPluginTask(action, task.taskId)
                      }}
                    >
                      {pending ? '处理中...' : action}
                    </Button>
                  )
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )
      }

      case 'document-chat': {
        const chatNode = node as PluginWorkbenchDocumentChatNode
        const state = chatStateMap[nodeKey] ?? createInitialChatState(chatNode)

        return (
          <div key={nodeKey} className="rounded-xl border border-border/60 bg-background/80 p-4 flex flex-col h-full min-h-0 space-y-3">
            {(chatNode.title || chatNode.description) && (
              <header className="space-y-1 shrink-0">
                {chatNode.title && <h5 className="text-sm font-semibold text-foreground">{chatNode.title}</h5>}
                {chatNode.description && <p className="text-xs text-muted-foreground">{chatNode.description}</p>}
              </header>
            )}

            <div className="rounded-lg border border-border/50 bg-muted/10 p-3 flex-1 min-h-0 overflow-y-auto space-y-3 relative">
              {state.messages.length > 0 ? (
                state.messages.map((message, index) => (
                  <div key={`${nodeKey}-message-${index}`} className={cn(
                    "flex flex-col space-y-1 mb-4",
                    message.role === 'user' ? "items-end" : "items-start"
                  )}>
                    <div className="text-[11px] font-medium text-muted-foreground/70 px-1 mb-0.5">
                      {message.role === 'user' ? '你' : 'DeepWiki'}
                    </div>
                    <div className={cn(
                      "px-4 py-3 rounded-2xl max-w-[85%]",
                      message.role === 'user'
                        ? "bg-primary text-primary-foreground rounded-tr-sm"
                        : "bg-muted/40 text-foreground border border-border/50 rounded-tl-sm"
                    )}>
                      {message.role === 'assistant' ? (
                        <div className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:p-0">
                          <MessageResponse>{message.content}</MessageResponse>
                        </div>
                      ) : (
                        <div className="text-[15px] whitespace-pre-wrap leading-relaxed">{message.content}</div>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div className="h-full flex items-center justify-center text-center">
                  <p className="text-sm text-muted-foreground">
                    {chatNode.emptyText ?? '暂无对话，输入问题开始继续聊天。'}
                  </p>
                </div>
              )}
            </div>

            {state.references.length > 0 && (
              <Collapsible className="shrink-0 border border-border/40 rounded-lg overflow-hidden bg-muted/10">
                <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/30 transition-colors">
                  <div className="flex items-center gap-2">
                    <span className="i-lucide-file-text w-3.5 h-3.5" />
                    <span>查看参考来源 ({state.references.length})</span>
                  </div>
                  <span className="i-lucide-chevron-down w-3.5 h-3.5" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="px-3 pb-3 pt-1 space-y-1.5 max-h-[150px] overflow-y-auto">
                    {state.references.map((item) => (
                      <li key={`${nodeKey}-${item.chunkId}`} className="text-[11px] text-muted-foreground/80 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary/40 shrink-0" />
                        <span className="font-mono truncate flex-1">{item.filePath}</span>
                        <span className="opacity-60 shrink-0 border border-border/50 rounded px-1">{(item.score * 100).toFixed(1)}%</span>
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}

            {state.error && (
              <div className="shrink-0 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                <p className="text-xs font-medium text-destructive flex items-center gap-2">
                  <span className="i-lucide-alert-circle w-4 h-4" />
                  {state.error}
                </p>
              </div>
            )}

            <div className="flex items-center gap-2 shrink-0">
              <Input
                value={state.draft}
                placeholder={chatNode.placeholder ?? '基于文档库继续提问...'}
                onChange={(event) => {
                  updateChatState(nodeKey, (current) => ({
                    ...current,
                    draft: event.target.value,
                    knowledgeBaseId: chatNode.knowledgeBaseId,
                  }), chatNode)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void sendDocumentChat(nodeKey, chatNode)
                  }
                }}
              />
              <Button
                size="sm"
                disabled={state.pending || state.draft.trim().length === 0}
                onClick={() => {
                  void sendDocumentChat(nodeKey, chatNode)
                }}
              >
                {state.pending ? '发送中...' : '发送'}
              </Button>
            </div>
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

  return <div className="h-full min-h-0 min-w-0 flex flex-col overflow-hidden">{renderNode(canvas.root, 'root')}</div>
}
