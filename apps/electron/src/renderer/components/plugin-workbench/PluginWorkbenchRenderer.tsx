import * as React from 'react'
import { MessageResponse } from '@/components/ai-elements/message'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

interface MarkdownHeadingItem {
  id: string
  text: string
  level: number
  pageId: string
  pageTitle: string
}

interface MarkdownScrollTarget {
  pageId: string
  headingId: string
}

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
    const raw = Object.prototype.hasOwnProperty.call(values, input.key)
      ? values[input.key]
      : getDefaultInputValue(action, input)

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

function findWorkbenchNodeById(node: PluginWorkbenchNode, targetId: string): PluginWorkbenchNode | null {
  if (node.id === targetId) {
    return node
  }

  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      const matched = findWorkbenchNodeById(child, targetId)
      if (matched) {
        return matched
      }
    }
  }

  return null
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

function toHeadingSlug(rawText: string, slugMap: Map<string, number>, prefix?: string): string {
  const base = rawText
    .trim()
    .toLowerCase()
    .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
  const normalizedBase = base || 'section'
  const used = slugMap.get(normalizedBase) ?? 0
  slugMap.set(normalizedBase, used + 1)
  const suffix = used > 0 ? `-${used}` : ''
  const withDup = `${normalizedBase}${suffix}`
  return prefix ? `${prefix}-${withDup}` : withDup
}

function buildHeadingPrefix(pageId: string): string {
  return pageId.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').toLowerCase() || 'page'
}

function parseMarkdownHeadings(
  content: string,
  pageId: string,
  pageTitle: string,
  headingPrefix: string,
): MarkdownHeadingItem[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const slugMap = new Map<string, number>()
  const headings: MarkdownHeadingItem[] = []

  for (const line of lines) {
    const matched = /^(#{2,4})\s+(.+)$/.exec(line.trim())
    if (!matched) {
      continue
    }

    const level = matched[1]?.length ?? 0
    const text = (matched[2] ?? '').trim()
    if (!text) {
      continue
    }

    headings.push({
      id: toHeadingSlug(text, slugMap, headingPrefix),
      text,
      level,
      pageId,
      pageTitle,
    })
  }

  return headings
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
  const isWikiWorkbench = pluginId === 'wiki-local-repository-plugin'
  const [toolbarInputValuesMap, setToolbarInputValuesMap] = React.useState<ToolbarInputsByNode>({})
  const [pathImportPendingMap, setPathImportPendingMap] = React.useState<Record<string, boolean>>({})
  const [taskSnapshotMap, setTaskSnapshotMap] = React.useState<TaskSnapshotMap>({})
  const [taskControlPendingMap, setTaskControlPendingMap] = React.useState<Record<string, boolean>>({})
  const [taskToolbarOpenMap, setTaskToolbarOpenMap] = React.useState<Map<string, boolean>>(new Map())
  const [chatStateMap, setChatStateMap] = React.useState<ChatUiStateMap>({})
  const [wikiControlPanelOpen, setWikiControlPanelOpen] = React.useState<boolean>(true)
  const [markdownActivePageMap, setMarkdownActivePageMap] = React.useState<Record<string, string>>({})
  const [markdownActiveHeadingMap, setMarkdownActiveHeadingMap] = React.useState<Record<string, string>>({})
  const [markdownScrollTargetMap, setMarkdownScrollTargetMap] = React.useState<Record<string, MarkdownScrollTarget>>({})
  const [markdownTocDialogOpenMap, setMarkdownTocDialogOpenMap] = React.useState<Record<string, boolean>>({})
  const markdownContainerRefMap = React.useRef<Record<string, HTMLDivElement | null>>({})

  React.useEffect(() => {
    setTaskSnapshotMap({})
    setTaskControlPendingMap({})
    setTaskToolbarOpenMap(new Map())
    setChatStateMap({})
    setWikiControlPanelOpen(true)
    setMarkdownActivePageMap({})
    setMarkdownActiveHeadingMap({})
    setMarkdownScrollTargetMap({})
    setMarkdownTocDialogOpenMap({})
    markdownContainerRefMap.current = {}
  }, [pluginId])

  const wikiHasMarkdownContent = React.useMemo(() => {
    if (!isWikiWorkbench) {
      return false
    }

    const markdownNode = findWorkbenchNodeById(canvas.root, 'wiki-markdown')
    if (!markdownNode || markdownNode.type !== 'markdown') {
      return false
    }

    if ((markdownNode.content?.trim().length ?? 0) > 0) {
      return true
    }

    return (markdownNode.pages ?? []).some((page) => (page.content?.trim().length ?? 0) > 0)
  }, [canvas.root, isWikiWorkbench])

  React.useEffect(() => {
    if (!isWikiWorkbench) {
      return
    }

    setWikiControlPanelOpen(!wikiHasMarkdownContent)
  }, [isWikiWorkbench, wikiHasMarkdownContent])

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

  React.useEffect(() => {
    const entries = Object.entries(markdownScrollTargetMap)
    if (entries.length === 0) {
      return
    }

    const rafId = window.requestAnimationFrame(() => {
      setMarkdownScrollTargetMap((prev) => {
        const next = { ...prev }

        for (const [nodeKey, target] of entries) {
          const currentPageId = markdownActivePageMap[nodeKey]
          if (currentPageId && currentPageId !== target.pageId) {
            continue
          }
          const container = markdownContainerRefMap.current[nodeKey]
          if (!container) {
            continue
          }

          const heading = container.querySelector(`[data-heading-id="${target.headingId}"]`) as HTMLElement | null
          if (!heading) {
            continue
          }

          const top = Math.max(0, heading.offsetTop - 12)
          container.scrollTo({
            top,
            behavior: 'smooth',
          })
          delete next[nodeKey]
        }

        return next
      })
    })

    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [markdownScrollTargetMap, markdownActivePageMap, canvas])

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
        <div key={inputId} className="w-full rounded-md border border-border/60 bg-background/80 px-3 py-2 space-y-2">
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
        <div key={inputId} className="w-full space-y-1.5">
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
      const normalizedSelectValue = selectValue.includes(':')
        ? selectValue.split(':').slice(1).join(':')
        : selectValue

      return (
        <div key={inputId} className="w-full space-y-1.5 flex flex-col items-start">
          {commonHeader}
          <div className="h-9 w-full flex items-center rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm">
            <ModelSelector
              externalSelectedModelId={normalizedSelectValue}
              onModelSelect={(option) => updateToolbarInput(
                nodeKey,
                input.key,
                option.modelId === '__auto__' ? '__auto__' : `${option.channelId}:${option.modelId}`,
              )}
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
        <div key={inputId} className="w-full space-y-1.5 lg:col-span-2">
          {commonHeader}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              id={inputId}
              className="sm:flex-1"
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
      <div key={inputId} className="w-full space-y-1.5">
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
        if (isWikiWorkbench && node.id === 'wiki-root') {
          // 兼容旧画布结构（wiki-main-split/wiki-sidebar/wiki-main）与新结构（controls/main panel）。
          const controlPanelNode = findWorkbenchNodeById(node, 'wiki-controls-panel')
            ?? findWorkbenchNodeById(node, 'wiki-sidebar')
          const mainPanelNode = findWorkbenchNodeById(node, 'wiki-main-panel')
            ?? findWorkbenchNodeById(node, 'wiki-main')
          const taskStatusNode = findWorkbenchNodeById(node, 'wiki-task-status')
          const activeTask = taskStatusNode && taskStatusNode.type === 'task-status'
            ? resolveTaskForNode(taskStatusNode)
            : null
          const taskProgressPercent = activeTask?.progress?.percent ?? 0
          const taskStage = activeTask?.progress?.stage ?? 'pending'
          const taskInFlight = activeTask?.state === 'running' || activeTask?.state === 'paused'
          const fallbackTaskControls: PluginTaskControlAction[] = ['pause', 'resume', 'stop']
          const taskControlActions: PluginTaskControlAction[] = taskStatusNode && taskStatusNode.type === 'task-status'
            ? (taskStatusNode.controlActions ?? fallbackTaskControls)
            : fallbackTaskControls

          return (
            <div key={nodeKey} className="flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-hidden p-4">
              {(node.title || node.description) && (
                <header className="flex shrink-0 items-start justify-between gap-3">
                  <div className="space-y-1">
                    {node.title && <h3 className="text-base font-semibold text-foreground">{node.title}</h3>}
                    {node.description && <p className="text-sm text-muted-foreground">{node.description}</p>}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {wikiHasMarkdownContent && !wikiControlPanelOpen && taskInFlight && activeTask ? (
                      <div className="flex items-center gap-2 rounded-full bg-background/95 px-3 py-1.5 shadow-sm ring-1 ring-border/60">
                        <span className="text-[11px] text-muted-foreground">
                          {taskStage} · {Math.round(taskProgressPercent)}%
                        </span>
                        <div className="flex items-center gap-1">
                          {taskControlActions.map((action) => {
                            const pendingKey = buildTaskControlKey(pluginId, activeTask.taskId, action)
                            const pending = taskControlPendingMap[pendingKey] === true
                            const disableByState =
                              action === 'pause'
                                ? activeTask.state !== 'running'
                                : action === 'resume'
                                  ? activeTask.state !== 'paused'
                                  : activeTask.state !== 'running' && activeTask.state !== 'paused'
                            return (
                              <Button
                                key={`${nodeKey}-header-${action}`}
                                size="sm"
                                variant={action === 'stop' ? 'destructive' : 'outline'}
                                className="h-7 rounded-full px-2 text-[11px]"
                                disabled={pending || disableByState}
                                onClick={() => {
                                  void controlPluginTask(action, activeTask.taskId)
                                }}
                              >
                                {pending ? '处理中' : action}
                              </Button>
                            )
                          })}
                        </div>
                      </div>
                    ) : null}

                    {wikiHasMarkdownContent ? (
                      <Button
                        size="sm"
                        variant={wikiControlPanelOpen ? 'secondary' : 'outline'}
                        className="shrink-0 rounded-full px-3 text-xs"
                        onClick={() => {
                          setWikiControlPanelOpen((prev) => !prev)
                        }}
                      >
                        {wikiControlPanelOpen ? '收起控制与会话' : '展开控制与会话'}
                      </Button>
                    ) : null}
                  </div>
                </header>
              )}

              {!wikiHasMarkdownContent ? (
                <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                  {controlPanelNode
                    ? renderNode(controlPanelNode, `${nodeKey}-controls`)
                    : <p className="text-sm text-muted-foreground">暂无控制面板配置</p>}
                </div>
              ) : (
                <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
                  <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                    {mainPanelNode
                      ? renderNode(mainPanelNode, `${nodeKey}-main`)
                      : <p className="text-sm text-muted-foreground">暂无 Wiki 内容节点</p>}
                  </div>

                  {wikiControlPanelOpen && controlPanelNode ? (
                    <div className="pointer-events-none absolute left-1/2 top-2 z-20 flex w-full -translate-x-1/2 justify-center px-4">
                      <div className="pointer-events-auto max-h-[calc(100%-0.5rem)] w-full max-w-5xl overflow-y-auto rounded-2xl border border-border/40 bg-background/95 p-4 shadow-[0_18px_45px_-28px_rgba(0,0,0,0.55)] backdrop-blur">
                        {renderNode(controlPanelNode, `${nodeKey}-controls-floating`)}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          )
        }

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
        const isWikiControlPanel = isWikiWorkbench && node.id === 'wiki-controls-panel'
        const isWikiMainPanel = isWikiWorkbench && node.id === 'wiki-main-panel'

        return (
          <section
            key={nodeKey}
            className={cn(
              'flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden',
              isWikiControlPanel
                ? 'rounded-none border-none bg-transparent p-0 shadow-none'
                : isWikiMainPanel
                  ? 'rounded-2xl border border-border/40 bg-background/80 p-3 shadow-sm'
                  : 'rounded-xl border border-border/60 bg-background/70 p-4 shadow-sm',
            )}
          >
            {(node.title || node.description) && (
              <header className="space-y-1 shrink-0">
                {node.title && <h4 className="text-sm font-semibold text-foreground">{node.title}</h4>}
                {node.description && <p className="text-xs text-muted-foreground">{node.description}</p>}
              </header>
            )}
            <div className={cn(
              'flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto',
              isWikiControlPanel ? 'pr-0' : 'pr-1',
            )}>
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
        const isWikiToolbar = isWikiWorkbench && node.id === 'wiki-toolbar'

        return (
          <div
            key={nodeKey}
            className={cn(
              'space-y-3',
              isWikiToolbar
                ? 'rounded-none bg-transparent px-0 py-0'
                : 'rounded-xl border border-border/60 bg-muted/20 px-3 py-2',
            )}
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
                    className={cn(
                      'space-y-3 rounded-lg',
                      isWikiToolbar
                        ? 'bg-transparent px-0 py-1'
                        : 'border border-border/60 bg-background/80 p-4',
                    )}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium text-foreground">{action.label}</p>
                        {action.description && (
                          <p className="text-xs text-muted-foreground">{action.description}</p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={variant}
                        className="w-full sm:w-auto"
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
                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
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
        const isWikiMarkdown = isWikiWorkbench && node.id === 'wiki-markdown'
        const content = node.content?.trim() ?? ''
        const pages = (node.pages ?? []).map((page) => ({
          id: page.id,
          title: page.title,
          sourcePath: page.sourcePath,
          content: page.content?.trim() ?? '',
          headingPrefix: buildHeadingPrefix(page.id),
        }))
        const hasPages = pages.length > 0
        const fallbackPageId = pages[0]?.id ?? ''
        const activePageId = hasPages
          ? (markdownActivePageMap[nodeKey] ?? node.activePageId ?? fallbackPageId)
          : ''
        const activePage = hasPages
          ? pages.find((page) => page.id === activePageId) ?? pages[0]
          : undefined
        const activeContent = activePage ? activePage.content : content
        const activeHeadingPrefix = activePage?.headingPrefix
        const displaySourcePath = activePage?.sourcePath ?? node.sourcePath
        const pageHeadingGroups = pages.map((page) => ({
          page,
          headings: parseMarkdownHeadings(page.content, page.id, page.title, page.headingPrefix),
        }))
        const activePageHeadings = pageHeadingGroups.find((group) => group.page.id === activePage?.id)?.headings ?? []
        const activeHeadingId = markdownActiveHeadingMap[nodeKey]

        const updateActiveHeadingByScroll = (): void => {
          if (!hasPages || !activePage || activePageHeadings.length === 0) {
            return
          }

          const container = markdownContainerRefMap.current[nodeKey]
          if (!container) {
            return
          }

          const scrollTop = container.scrollTop
          let currentId = activePageHeadings[0]?.id

          for (const heading of activePageHeadings) {
            const element = container.querySelector(`[data-heading-id="${heading.id}"]`) as HTMLElement | null
            if (!element) {
              continue
            }
            if (element.offsetTop - 18 <= scrollTop) {
              currentId = heading.id
              continue
            }
            break
          }

          if (!currentId) {
            return
          }

          setMarkdownActiveHeadingMap((prev) => {
            if (prev[nodeKey] === currentId) {
              return prev
            }
            return {
              ...prev,
              [nodeKey]: currentId,
            }
          })
        }

        const openTocDialog = markdownTocDialogOpenMap[nodeKey] === true
        const renderWikiToc = (compact = false): React.ReactElement => (
          <div className={cn('space-y-2', compact ? 'mt-0' : 'mt-2')}>
            {pageHeadingGroups.map((group) => {
              const pageSelected = group.page.id === activePage?.id
              return (
                <div key={`${nodeKey}-toc-${group.page.id}`} className="space-y-1">
                  <button
                    type="button"
                    className={cn(
                      'w-full rounded-md px-2 py-1 text-left text-xs transition-colors',
                      pageSelected
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                    )}
                    onClick={() => {
                      setMarkdownActivePageMap((prev) => ({
                        ...prev,
                        [nodeKey]: group.page.id,
                      }))
                      const firstHeadingId = group.headings[0]?.id
                      if (firstHeadingId) {
                        setMarkdownActiveHeadingMap((prev) => ({
                          ...prev,
                          [nodeKey]: firstHeadingId,
                        }))
                      }
                      if (compact) {
                        setMarkdownTocDialogOpenMap((prev) => ({
                          ...prev,
                          [nodeKey]: false,
                        }))
                      }
                    }}
                  >
                    {group.page.title}
                  </button>
                  {group.headings.length > 0 ? (
                    <div className="space-y-0.5 pl-1">
                      {group.headings.map((heading) => {
                        const selected = pageSelected && activeHeadingId === heading.id
                        return (
                          <button
                            key={`${nodeKey}-toc-${group.page.id}-${heading.id}`}
                            type="button"
                            className={cn(
                              'block w-full rounded px-2 py-1 text-left text-[11px] leading-snug transition-colors',
                              heading.level >= 3 ? 'pl-4' : 'pl-2',
                              selected
                                ? 'bg-primary/15 text-primary'
                                : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                            )}
                            onClick={() => {
                              if (group.page.id !== activePage?.id) {
                                setMarkdownActivePageMap((prev) => ({
                                  ...prev,
                                  [nodeKey]: group.page.id,
                                }))
                              }
                              setMarkdownScrollTargetMap((prev) => ({
                                ...prev,
                                [nodeKey]: {
                                  pageId: group.page.id,
                                  headingId: heading.id,
                                },
                              }))
                              if (compact) {
                                setMarkdownTocDialogOpenMap((prev) => ({
                                  ...prev,
                                  [nodeKey]: false,
                                }))
                              }
                            }}
                          >
                            {heading.text}
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="pl-2 text-[11px] text-muted-foreground/70">该页暂无可定位标题</p>
                  )}
                </div>
              )
            })}
          </div>
        )

        return (
          <div
            key={nodeKey}
            className={cn(
              'flex h-full min-h-0 flex-col space-y-2',
              isWikiMarkdown
                ? 'rounded-xl bg-background/90 p-4'
                : 'rounded-xl border border-border/60 bg-background/80 p-4',
            )}
          >
            {(node.title || node.description) && (
              <header className="shrink-0 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  {node.title && <h5 className="text-sm font-semibold text-foreground">{node.title}</h5>}
                  {isWikiMarkdown && hasPages ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs md:hidden"
                      onClick={() => {
                        setMarkdownTocDialogOpenMap((prev) => ({
                          ...prev,
                          [nodeKey]: true,
                        }))
                      }}
                    >
                      目录地图
                    </Button>
                  ) : null}
                </div>
                {node.description && <p className="text-xs text-muted-foreground">{node.description}</p>}
              </header>
            )}

            {displaySourcePath && (
              <p className="text-[11px] font-mono text-muted-foreground shrink-0">来源：{displaySourcePath}</p>
            )}

            <div className="relative flex-1 min-h-0 overflow-hidden">
              <div
                ref={(element) => {
                  markdownContainerRefMap.current[nodeKey] = element
                  if (element && hasPages) {
                    window.requestAnimationFrame(() => {
                      updateActiveHeadingByScroll()
                    })
                  }
                }}
                className={cn(
                  'h-full overflow-y-auto pr-2',
                  isWikiMarkdown && hasPages ? 'md:pr-[20rem]' : 'pr-2',
                )}
                onScroll={() => {
                  updateActiveHeadingByScroll()
                }}
              >
                {activeContent.length > 0 ? (
                  <MessageResponse headingIdPrefix={activeHeadingPrefix}>{activeContent}</MessageResponse>
                ) : (
                  <p className="text-sm text-muted-foreground mt-4">
                    {node.emptyText ?? '暂无可展示的 Markdown 内容'}
                  </p>
                )}
              </div>

              {isWikiMarkdown && hasPages ? (
                <aside className="pointer-events-none absolute right-2 top-2 z-20 hidden w-72 md:block">
                  <div className="pointer-events-auto max-h-[calc(100%-0.5rem)] overflow-y-auto rounded-xl border border-border/50 bg-background/95 p-3 shadow-sm backdrop-blur-sm">
                    <p className="text-xs font-semibold text-foreground">目录地图</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">全局目录（按页面分组）</p>
                    {renderWikiToc()}
                  </div>
                </aside>
              ) : null}
            </div>

            {isWikiMarkdown && hasPages ? (
              <Dialog
                open={openTocDialog}
                onOpenChange={(open) => {
                  setMarkdownTocDialogOpenMap((prev) => ({
                    ...prev,
                    [nodeKey]: open,
                  }))
                }}
              >
                <DialogContent className="max-h-[80vh] overflow-hidden p-0 sm:max-w-md md:hidden">
                  <DialogHeader className="border-b border-border/60 px-4 py-3">
                    <DialogTitle className="text-sm">目录地图</DialogTitle>
                  </DialogHeader>
                  <div className="max-h-[calc(80vh-52px)] overflow-y-auto px-4 py-3">
                    <p className="text-[11px] text-muted-foreground">全局目录（按页面分组）</p>
                    {renderWikiToc(true)}
                  </div>
                </DialogContent>
              </Dialog>
            ) : null}
          </div>
        )
      }

      case 'task-status': {
        const taskNode = node as PluginWorkbenchTaskStatusNode
        const task = resolveTaskForNode(taskNode)
        const isWikiTaskStatus = isWikiWorkbench && node.id === 'wiki-task-status'

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
            className={cn(
              'space-y-3 rounded-xl p-4',
              isWikiTaskStatus
                ? 'border-none bg-transparent p-0'
                : 'border border-border/70 bg-background/80',
            )}
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
        const isWikiDocumentChat = isWikiWorkbench && node.id === 'wiki-doc-chat'

        return (
          <div
            key={nodeKey}
            className={cn(
              'flex h-full min-h-0 flex-col space-y-3 rounded-xl p-4',
              isWikiDocumentChat
                ? 'border-none bg-transparent p-0'
                : 'border border-border/60 bg-background/80',
            )}
          >
            {(chatNode.title || chatNode.description) && (
              <header className="space-y-1 shrink-0">
                {chatNode.title && <h5 className="text-sm font-semibold text-foreground">{chatNode.title}</h5>}
                {chatNode.description && <p className="text-xs text-muted-foreground">{chatNode.description}</p>}
              </header>
            )}

            <div className={cn(
              'relative flex-1 min-h-0 overflow-y-auto space-y-3 rounded-lg p-3',
              isWikiDocumentChat
                ? 'bg-background/60'
                : 'border border-border/50 bg-muted/10',
            )}>
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
              <Collapsible className={cn(
                'shrink-0 overflow-hidden rounded-lg',
                isWikiDocumentChat
                  ? 'border border-border/30 bg-background/50'
                  : 'border border-border/40 bg-muted/10',
              )}>
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
