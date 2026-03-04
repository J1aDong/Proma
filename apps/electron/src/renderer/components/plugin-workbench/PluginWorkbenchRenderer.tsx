import * as React from 'react'
import { MoreHorizontal } from 'lucide-react'
import { MessageResponse, buildMarkdownHeadingAnchorId } from '@/components/ai-elements/message'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { PluginReadonlyChatPanel } from './base/PluginReadonlyChatPanel'
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
  PluginWorkbenchRepositoryItem,
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
  elementId: string
  pageId?: string
}

type WikiViewportMode = 'desktop' | 'compact' | 'tablet' | 'mobile'

function getWikiViewportMode(width: number): WikiViewportMode {
  if (width < 700) {
    return 'mobile'
  }
  if (width < 900) {
    return 'tablet'
  }
  if (width < 1200) {
    return 'compact'
  }
  return 'desktop'
}

function useWikiViewportMode(): WikiViewportMode {
  const [mode, setMode] = React.useState<WikiViewportMode>(() => {
    if (typeof window === 'undefined') {
      return 'desktop'
    }
    return getWikiViewportMode(window.innerWidth)
  })

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handleResize = (): void => {
      setMode(getWikiViewportMode(window.innerWidth))
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return mode
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

function withoutNodeById(node: PluginWorkbenchNode, targetId: string): PluginWorkbenchNode | null {
  if (node.id === targetId) {
    return null
  }

  if ('children' in node && Array.isArray(node.children)) {
    const children = node.children
      .map((child) => withoutNodeById(child, targetId))
      .filter((child): child is PluginWorkbenchNode => Boolean(child))

    return {
      ...node,
      children,
    }
  }

  return node
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

function buildHeadingPrefix(pageId: string): string {
  return pageId.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').toLowerCase() || 'page'
}

function normalizeHeadingIdForMatch(headingId: string): string {
  return headingId.replace(/-\d+$/, '')
}

function resolveHeadingElement(container: HTMLElement, elementId: string): HTMLElement | null {
  const exact = container.querySelector(`[data-heading-id="${elementId}"]`) as HTMLElement | null
  if (exact) {
    return exact
  }

  const targetNormalized = normalizeHeadingIdForMatch(elementId)
  const candidates = Array.from(container.querySelectorAll<HTMLElement>('[data-heading-id]'))
  for (const candidate of candidates) {
    const candidateId = candidate.getAttribute('data-heading-id')
    if (!candidateId) {
      continue
    }
    if (normalizeHeadingIdForMatch(candidateId) === targetNormalized) {
      return candidate
    }
  }

  return null
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
      id: buildMarkdownHeadingAnchorId(text, slugMap, headingPrefix),
      text,
      level,
      pageId,
      pageTitle,
    })
  }

  return headings
}

function normalizeRepositoryList(items: PluginWorkbenchRepositoryItem[] | undefined): PluginWorkbenchRepositoryItem[] {
  if (!Array.isArray(items)) {
    return []
  }

  return items
    .map((item) => ({
      id: item.id.trim(),
      repoPath: item.repoPath.trim(),
      knowledgeBaseId: item.knowledgeBaseId.trim(),
      updatedAt: item.updatedAt,
      lastScannedAt: item.lastScannedAt,
    }))
    .filter((item) => item.id.length > 0 && item.repoPath.length > 0 && item.knowledgeBaseId.length > 0)
}

function getWikiFloatingChatMaxHeight(): number {
  if (typeof window === 'undefined') {
    return 760
  }
  return Math.max(360, Math.min(980, window.innerHeight - 120))
}

function getWikiFloatingChatDefaultHeight(): number {
  if (typeof window === 'undefined') {
    return 560
  }
  const preferred = Math.round(window.innerHeight * 0.7)
  return Math.max(360, Math.min(getWikiFloatingChatMaxHeight(), preferred))
}

function clampWikiFloatingChatHeight(height: number): number {
  const minHeight = 320
  const maxHeight = getWikiFloatingChatMaxHeight()
  return Math.max(minHeight, Math.min(maxHeight, Math.round(height)))
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
  const wikiViewportMode = useWikiViewportMode()
  const [toolbarInputValuesMap, setToolbarInputValuesMap] = React.useState<ToolbarInputsByNode>({})
  const [pathImportPendingMap, setPathImportPendingMap] = React.useState<Record<string, boolean>>({})
  const [taskSnapshotMap, setTaskSnapshotMap] = React.useState<TaskSnapshotMap>({})
  const [taskControlPendingMap, setTaskControlPendingMap] = React.useState<Record<string, boolean>>({})
  const [taskToolbarOpenMap, setTaskToolbarOpenMap] = React.useState<Map<string, boolean>>(new Map())
  const [chatStateMap, setChatStateMap] = React.useState<ChatUiStateMap>({})
  const [wikiControlPanelOpen, setWikiControlPanelOpen] = React.useState<boolean>(true)
  const [wikiFloatingChatOpen, setWikiFloatingChatOpen] = React.useState<boolean>(false)
  const [wikiFloatingChatHeight, setWikiFloatingChatHeight] = React.useState<number>(() => getWikiFloatingChatDefaultHeight())
  const [wikiFloatingChatResizing, setWikiFloatingChatResizing] = React.useState<boolean>(false)
  const [wikiRepositoryPanelOpen, setWikiRepositoryPanelOpen] = React.useState<boolean>(true)
  const [wikiRepositoryPickerOpen, setWikiRepositoryPickerOpen] = React.useState<boolean>(false)
  const [wikiRepositoryExpandedMap, setWikiRepositoryExpandedMap] = React.useState<Record<string, boolean>>({})
  const [wikiPreparingNewAnalysis, setWikiPreparingNewAnalysis] = React.useState<boolean>(false)
  const [markdownActivePageMap, setMarkdownActivePageMap] = React.useState<Record<string, string>>({})
  const [markdownActiveHeadingMap, setMarkdownActiveHeadingMap] = React.useState<Record<string, string>>({})
  const [markdownScrollTargetMap, setMarkdownScrollTargetMap] = React.useState<Record<string, MarkdownScrollTarget>>({})
  const [markdownTocDialogOpenMap, setMarkdownTocDialogOpenMap] = React.useState<Record<string, boolean>>({})
  const [markdownTocHoverMap, setMarkdownTocHoverMap] = React.useState<Record<string, boolean>>({})
  const markdownContainerRefMap = React.useRef<Record<string, HTMLDivElement | null>>({})
  const wikiContentVisibleRef = React.useRef<boolean>(false)
  const wikiFloatingChatResizeRef = React.useRef<{ startY: number; startHeight: number } | null>(null)

  const blurActiveElement = React.useCallback((): void => {
    if (typeof document === 'undefined') {
      return
    }
    const active = document.activeElement
    if (active instanceof HTMLElement) {
      active.blur()
    }
  }, [])

  const handleWikiControlPanelDialogOpenChange = React.useCallback((open: boolean): void => {
    if (!open) {
      blurActiveElement()
    }
    setWikiControlPanelOpen(open)
  }, [blurActiveElement])

  const handleWikiFloatingChatDialogOpenChange = React.useCallback((open: boolean): void => {
    if (!open) {
      blurActiveElement()
    }
    setWikiFloatingChatOpen(open)
  }, [blurActiveElement])

  React.useEffect(() => {
    setTaskSnapshotMap({})
    setTaskControlPendingMap({})
    setTaskToolbarOpenMap(new Map())
    setChatStateMap({})
    setWikiControlPanelOpen(true)
    setWikiFloatingChatOpen(false)
    setWikiFloatingChatHeight(getWikiFloatingChatDefaultHeight())
    setWikiFloatingChatResizing(false)
    wikiFloatingChatResizeRef.current = null
    setWikiRepositoryPanelOpen(true)
    setWikiRepositoryPickerOpen(false)
    setWikiRepositoryExpandedMap({})
    setWikiPreparingNewAnalysis(false)
    setMarkdownActivePageMap({})
    setMarkdownActiveHeadingMap({})
    setMarkdownScrollTargetMap({})
    setMarkdownTocDialogOpenMap({})
    setMarkdownTocHoverMap({})
    markdownContainerRefMap.current = {}
  }, [pluginId])

  const wikiHasMarkdownContent = React.useMemo(() => {
    if (!isWikiWorkbench) {
      return false
    }
    if (wikiPreparingNewAnalysis) {
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
  }, [canvas.root, isWikiWorkbench, wikiPreparingNewAnalysis])

  React.useEffect(() => {
    if (!isWikiWorkbench) {
      wikiContentVisibleRef.current = false
      return
    }

    if (wikiHasMarkdownContent && !wikiContentVisibleRef.current) {
      setWikiFloatingChatOpen(wikiViewportMode !== 'mobile')
    } else if (!wikiHasMarkdownContent) {
      setWikiFloatingChatOpen(false)
    }

    wikiContentVisibleRef.current = wikiHasMarkdownContent
  }, [isWikiWorkbench, wikiHasMarkdownContent, wikiViewportMode])

  const handleWikiFloatingChatResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()

    const startHeight = clampWikiFloatingChatHeight(wikiFloatingChatHeight)
    wikiFloatingChatResizeRef.current = {
      startY: event.clientY,
      startHeight,
    }
    setWikiFloatingChatResizing(true)
  }, [wikiFloatingChatHeight])

  React.useEffect(() => {
    if (!wikiFloatingChatResizing) {
      return
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const context = wikiFloatingChatResizeRef.current
      if (!context) {
        return
      }

      const delta = context.startY - event.clientY
      const nextHeight = clampWikiFloatingChatHeight(context.startHeight + delta)
      setWikiFloatingChatHeight(nextHeight)
    }

    const handlePointerEnd = (): void => {
      setWikiFloatingChatResizing(false)
      wikiFloatingChatResizeRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ns-resize'

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [wikiFloatingChatResizing])

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handleResize = (): void => {
      setWikiFloatingChatHeight((prev) => clampWikiFloatingChatHeight(prev))
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

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
          const container = markdownContainerRefMap.current[nodeKey]
          if (!container) {
            continue
          }

          const targetElement = resolveHeadingElement(container, target.elementId)
          if (!targetElement) {
            continue
          }

          const top = Math.max(0, targetElement.offsetTop - 12)
          container.scrollTo({
            top,
            behavior: 'smooth',
          })
          if (target.pageId) {
            const pageId = target.pageId
            setMarkdownActivePageMap((current) => ({
              ...current,
              [nodeKey]: pageId,
            }))
          }
          delete next[nodeKey]
        }

        return next
      })
    })

    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [markdownScrollTargetMap, canvas])

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

  const removeWikiRepository = React.useCallback((repositoryId: string, sourceNodeId?: string): void => {
    onInvokeAction({
      actionId: 'remove-repository',
      sourceNodeId,
      payload: {
        repositoryId,
      },
    })
  }, [onInvokeAction])

  const activateWikiRepository = React.useCallback((repositoryId: string, sourceNodeId?: string): void => {
    onInvokeAction({
      actionId: 'activate-repository',
      sourceNodeId,
      payload: {
        repositoryId,
      },
    })
  }, [onInvokeAction])

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
          const rawControlPanelNode = findWorkbenchNodeById(node, 'wiki-controls-panel')
            ?? findWorkbenchNodeById(node, 'wiki-sidebar')
          const controlPanelNode = rawControlPanelNode
            ? withoutNodeById(rawControlPanelNode, 'wiki-doc-chat')
            : null
          const chatPanelNode = rawControlPanelNode
            ? findWorkbenchNodeById(rawControlPanelNode, 'wiki-doc-chat')
            : null
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
          const markdownNodeForWiki = mainPanelNode
            ? findWorkbenchNodeById(mainPanelNode, 'wiki-markdown')
            : null
          const wikiRepositoryList = markdownNodeForWiki && markdownNodeForWiki.type === 'markdown'
            ? normalizeRepositoryList(markdownNodeForWiki.repositoryList)
            : []
          const wikiActiveRepositoryId = markdownNodeForWiki
            && markdownNodeForWiki.type === 'markdown'
            && typeof markdownNodeForWiki.activeRepositoryId === 'string'
            ? markdownNodeForWiki.activeRepositoryId
            : ''
          const wikiAnalyzingPlaceholder = markdownNodeForWiki
            && markdownNodeForWiki.type === 'markdown'
            && typeof markdownNodeForWiki.emptyText === 'string'
            && markdownNodeForWiki.emptyText.includes('正在分析')
          const showWikiMainArea = wikiHasMarkdownContent || taskInFlight || Boolean(wikiAnalyzingPlaceholder)
          const wikiActiveRepository = wikiRepositoryList.find((item) => item.id === wikiActiveRepositoryId) ?? wikiRepositoryList[0]
          const removeRepositoryPending = actionPendingMap[`${pluginId}:remove-repository`] === true
          const activateRepositoryPending = actionPendingMap[`${pluginId}:activate-repository`] === true
          const toolbarNodeForWiki = controlPanelNode
            ? findWorkbenchNodeById(controlPanelNode, 'wiki-toolbar')
            : null
          const wikiToolbarNode = toolbarNodeForWiki && toolbarNodeForWiki.type === 'toolbar'
            ? toolbarNodeForWiki
            : null
          const analyzeAction = wikiToolbarNode?.actions.find((action) => action.id === 'analyze')
          const analyzeInputValues = toolbarInputValuesMap['wiki-toolbar'] ?? {}
          const analyzePayloadResult = analyzeAction
            ? buildActionPayload(analyzeAction, analyzeInputValues)
            : null
          const analyzePending = analyzeAction
            ? actionPendingMap[`${pluginId}:${analyzeAction.id}`] === true
            : false
          const analyzeDisabled = !analyzeAction
            || !analyzePayloadResult
            || analyzePayloadResult.invalid
            || analyzePending
          const useTopbarMenu = wikiViewportMode === 'tablet' || wikiViewportMode === 'mobile' || wikiViewportMode === 'compact'
          const useFullscreenChatDialog = wikiViewportMode === 'mobile'
          const canUseWikiChat = wikiHasMarkdownContent && chatPanelNode?.type === 'document-chat'
          const showChatQuickToggle = canUseWikiChat
          const headerRepositoryName = wikiActiveRepository
            ? (wikiActiveRepository.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? wikiActiveRepository.repoPath)
            : '未选择仓库'
          const headerTaskState = activeTask
            ? humanizeTaskState(activeTask.state)
            : wikiPreparingNewAnalysis
              ? '待分析'
              : wikiHasMarkdownContent
                ? '已完成'
                : '未分析'
          const headerTaskStateClass = activeTask?.state === 'running'
            ? 'bg-amber-500/10 text-amber-700 ring-amber-500/30'
            : activeTask?.state === 'paused'
              ? 'bg-slate-500/10 text-slate-700 ring-slate-500/30'
              : activeTask?.state === 'completed'
                ? 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/30'
                : activeTask?.state === 'failed' || activeTask?.state === 'stopped'
                  ? 'bg-destructive/10 text-destructive ring-destructive/30'
                  : 'bg-muted text-muted-foreground ring-border'
          const triggerAnalyzeFromTopBar = (): void => {
            if (!analyzeAction || !analyzePayloadResult || analyzePayloadResult.invalid) {
              return
            }
            setWikiControlPanelOpen(false)
            setWikiPreparingNewAnalysis(false)
            onInvokeAction({
              actionId: analyzeAction.id,
              sourceNodeId: wikiToolbarNode?.id ?? 'wiki-toolbar',
              payload: analyzePayloadResult.payload,
            })
          }
          const taskControlLabel = (action: PluginTaskControlAction): string => {
            if (action === 'pause') {
              return '暂停任务'
            }
            if (action === 'resume') {
              return '继续任务'
            }
            return '停止任务'
          }
          const useCompactRepositoryStrip = wikiViewportMode === 'compact'
            || wikiViewportMode === 'tablet'
            || wikiViewportMode === 'mobile'
          const useControlPanelDrawer = wikiViewportMode === 'tablet' || wikiViewportMode === 'mobile'

          const renderRepositoryRows = (compactList: boolean): React.ReactElement => {
            if (wikiRepositoryList.length === 0) {
              return (
                <p className="text-[11px] text-muted-foreground">
                  暂无仓库记录，点击“新增”后在控制面板导入路径并开始分析。
                </p>
              )
            }

            return (
              <div className={cn(
                'space-y-1 overflow-y-auto pr-1',
                compactList ? 'max-h-64' : 'max-h-40',
              )}>
                {wikiRepositoryList.map((repository) => {
                  const expanded = wikiRepositoryExpandedMap[repository.id] === true
                    || repository.id === wikiActiveRepository?.id
                  const repositoryName = repository.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repository.repoPath
                  const active = repository.id === wikiActiveRepository?.id
                  return (
                    <div
                      key={`${nodeKey}-repo-${compactList ? 'compact' : 'inline'}-${repository.id}`}
                      className={cn(
                        'rounded-md border px-2 py-1.5',
                        active
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-border/50 bg-background/70',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-foreground">{repositoryName}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{repository.knowledgeBaseId}</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant={active ? 'secondary' : 'ghost'}
                            className="h-6 px-2 text-[11px]"
                            disabled={activateRepositoryPending}
                            onClick={() => {
                              setWikiPreparingNewAnalysis(false)
                              updateToolbarInput('wiki-toolbar', 'repoPath', repository.repoPath)
                              updateToolbarInput('wiki-toolbar', 'knowledgeBaseId', repository.knowledgeBaseId)
                              activateWikiRepository(repository.id, node.id)
                              if (compactList) {
                                setWikiRepositoryPickerOpen(false)
                              }
                            }}
                          >
                            {active ? '当前' : '使用'}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px]"
                            onClick={() => {
                              setWikiRepositoryExpandedMap((prev) => ({
                                ...prev,
                                [repository.id]: !expanded,
                              }))
                            }}
                          >
                            {expanded ? '隐藏' : '展开'}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                            disabled={removeRepositoryPending}
                            onClick={() => {
                              removeWikiRepository(repository.id, node.id)
                            }}
                          >
                            删除
                          </Button>
                        </div>
                      </div>

                      {expanded ? (
                        <div className="mt-1.5 space-y-1 border-t border-border/50 pt-1.5 text-[11px] text-muted-foreground">
                          <p className="font-mono break-all">{repository.repoPath}</p>
                          <p>
                            最近更新：
                            {repository.updatedAt ?? '-'}
                          </p>
                          <p>
                            最近扫描：
                            {repository.lastScannedAt ?? '-'}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )
          }

          return (
            <div key={nodeKey} className="flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-hidden p-4">
              {(node.title || node.description) && (
                <header className="flex shrink-0 items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    {node.title && <h3 className="text-base font-semibold text-foreground">{node.title}</h3>}
                    {node.description && <p className="text-sm text-muted-foreground">{node.description}</p>}
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 ring-1',
                        headerTaskStateClass,
                      )}>
                        {headerTaskState}
                      </span>
                      <span className="truncate text-muted-foreground">仓库：{headerRepositoryName}</span>
                      {taskInFlight && activeTask ? (
                        <span className="text-muted-foreground">
                          {taskStage} · {Math.round(taskProgressPercent)}%
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    <Button
                      size="sm"
                      className="rounded-full px-3 text-xs"
                      disabled={analyzeDisabled}
                      onClick={triggerAnalyzeFromTopBar}
                    >
                      {analyzePending ? '分析中...' : '开始分析'}
                    </Button>

                    {!useTopbarMenu && taskInFlight && activeTask ? (
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
                              key={`${nodeKey}-header-inline-${action}`}
                              size="sm"
                              variant={action === 'stop' ? 'destructive' : 'outline'}
                              className="h-7 rounded-full px-2 text-[11px]"
                              disabled={pending || disableByState}
                              onClick={() => {
                                void controlPluginTask(action, activeTask.taskId)
                              }}
                            >
                              {pending ? '处理中' : taskControlLabel(action)}
                            </Button>
                          )
                        })}
                      </div>
                    ) : null}

                    {!useTopbarMenu && showWikiMainArea ? (
                      <Button
                        size="sm"
                        variant={wikiControlPanelOpen ? 'secondary' : 'outline'}
                        className="shrink-0 rounded-full px-3 text-xs"
                        onClick={() => {
                          setWikiControlPanelOpen((prev) => !prev)
                        }}
                      >
                        {wikiControlPanelOpen ? '收起控制面板' : '展开控制面板'}
                      </Button>
                    ) : null}

                    {!useTopbarMenu && showChatQuickToggle ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 rounded-full px-3 text-xs"
                        onClick={() => {
                          setWikiFloatingChatOpen((prev) => !prev)
                        }}
                      >
                        {wikiFloatingChatOpen ? '收起问答窗' : '展开问答窗'}
                      </Button>
                    ) : null}

                    {useTopbarMenu ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            className="size-8 rounded-full"
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          {showWikiMainArea ? (
                            <DropdownMenuItem
                              onSelect={() => {
                                setWikiControlPanelOpen((prev) => !prev)
                              }}
                            >
                              {wikiControlPanelOpen ? '收起控制面板' : '展开控制面板'}
                            </DropdownMenuItem>
                          ) : null}
                          {showChatQuickToggle ? (
                            <DropdownMenuItem
                              onSelect={() => {
                                setWikiFloatingChatOpen((prev) => !prev)
                              }}
                            >
                              {wikiFloatingChatOpen ? '收起问答窗' : '展开问答窗'}
                            </DropdownMenuItem>
                          ) : null}
                          {taskInFlight && activeTask ? (
                            <>
                              <DropdownMenuSeparator />
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
                                  <DropdownMenuItem
                                    key={`${nodeKey}-header-menu-${action}`}
                                    disabled={pending || disableByState}
                                    onSelect={() => {
                                      void controlPluginTask(action, activeTask.taskId)
                                    }}
                                  >
                                    {pending ? '处理中...' : taskControlLabel(action)}
                                  </DropdownMenuItem>
                                )
                              })}
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </header>
              )}

              <section className="shrink-0 rounded-xl border border-border/50 bg-background/85 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-foreground">基于仓库的列表</p>
                    <p className="text-[11px] text-muted-foreground">基于仓库持久化保存，可切换、删除与展开查看</p>
                    {useCompactRepositoryStrip ? (
                      <p className="truncate text-[11px] text-muted-foreground/90">
                        当前：{headerRepositoryName}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => {
                        setWikiPreparingNewAnalysis(true)
                        setWikiControlPanelOpen(true)
                        setWikiFloatingChatOpen(false)
                        setWikiRepositoryPickerOpen(false)
                        updateToolbarInput('wiki-toolbar', 'repoPath', '')
                        updateToolbarInput('wiki-toolbar', 'knowledgeBaseId', '')
                      }}
                    >
                      新增
                    </Button>
                    {useCompactRepositoryStrip ? (
                      <Popover open={wikiRepositoryPickerOpen} onOpenChange={setWikiRepositoryPickerOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px]"
                          >
                            仓库列表
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-[min(90vw,460px)] p-3">
                          <div className="space-y-2">
                            <p className="text-xs font-semibold text-foreground">仓库切换</p>
                            {renderRepositoryRows(true)}
                          </div>
                        </PopoverContent>
                      </Popover>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => {
                          setWikiRepositoryPanelOpen((prev) => !prev)
                        }}
                      >
                        {wikiRepositoryPanelOpen ? '收拢' : '展开'}
                      </Button>
                    )}
                  </div>
                </div>

                {!useCompactRepositoryStrip && wikiRepositoryPanelOpen ? (
                  <div className="mt-2 space-y-1.5">
                    {renderRepositoryRows(false)}
                  </div>
                ) : null}
              </section>

              {!showWikiMainArea ? (
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

                  {wikiControlPanelOpen && controlPanelNode && !useControlPanelDrawer ? (
                    <div className="pointer-events-none absolute left-1/2 top-2 z-20 flex w-full -translate-x-1/2 justify-center px-4">
                      <div className="pointer-events-auto max-h-[calc(100%-0.5rem)] w-full max-w-5xl overflow-y-auto rounded-2xl border border-border/40 bg-background/95 p-4 shadow-[0_18px_45px_-28px_rgba(0,0,0,0.55)] backdrop-blur">
                        {renderNode(controlPanelNode, `${nodeKey}-controls-floating`)}
                      </div>
                    </div>
                  ) : null}

                  {useControlPanelDrawer && controlPanelNode ? (
                    <Dialog open={wikiControlPanelOpen} onOpenChange={handleWikiControlPanelDialogOpenChange}>
                      <DialogContent className="left-0 top-auto bottom-0 z-40 w-full max-w-none translate-x-0 translate-y-0 gap-0 rounded-t-2xl rounded-b-none border border-border/50 bg-background p-0 sm:rounded-t-2xl sm:rounded-b-none">
                        <DialogHeader className="sr-only">
                          <DialogTitle>控制面板</DialogTitle>
                          <DialogDescription>导入仓库路径并启动分析任务</DialogDescription>
                        </DialogHeader>
                        <div className="flex h-[85vh] min-h-0 flex-col overflow-hidden pt-6">
                          <div className="shrink-0 border-b border-border/40 px-4 pb-3">
                            <p className="text-sm font-semibold text-foreground">控制面板</p>
                            <p className="text-xs text-muted-foreground">导入仓库路径并启动分析任务</p>
                          </div>
                          <div className="min-h-0 flex-1 overflow-hidden p-4">
                            {renderNode(controlPanelNode, `${nodeKey}-controls-drawer`)}
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>
                  ) : null}

                  {canUseWikiChat && chatPanelNode && chatPanelNode.type === 'document-chat' && !useFullscreenChatDialog ? (
                    <div
                      className="pointer-events-none absolute bottom-4 right-4 z-30 flex w-[min(620px,calc(100%-2rem))] max-h-[calc(100%-1.5rem)] flex-col items-end"
                      style={{ height: `${wikiFloatingChatHeight}px` }}
                    >
                      {wikiFloatingChatOpen ? (
                        <div className="pointer-events-auto flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border/50 bg-background/95 shadow-[0_18px_42px_-24px_rgba(0,0,0,0.45)] backdrop-blur">
                          <div
                            role="separator"
                            aria-label="拖拽调整问答窗高度"
                            className={cn(
                              'flex h-4 cursor-ns-resize items-center justify-center border-b border-border/40 text-[10px] text-muted-foreground/80 select-none',
                              wikiFloatingChatResizing ? 'bg-primary/10' : 'hover:bg-muted/40',
                            )}
                            onPointerDown={handleWikiFloatingChatResizeStart}
                          >
                            <span className="h-1 w-10 rounded-full bg-muted-foreground/40" />
                          </div>
                          <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
                            <div className="space-y-0.5">
                              <p className="text-xs font-semibold text-foreground">DeepWiki 对话</p>
                              <p className="text-[11px] text-muted-foreground">先定位 Wiki，再下钻源码证据</p>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => {
                                setWikiFloatingChatOpen(false)
                              }}
                            >
                              收起
                            </Button>
                          </div>
                          <div className="min-h-0 flex-1 overflow-hidden p-3">
                            {renderNode(chatPanelNode, `${nodeKey}-floating-chat`)}
                          </div>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          className="pointer-events-auto rounded-full px-4 py-2 text-xs shadow-sm"
                          onClick={() => {
                            setWikiFloatingChatOpen(true)
                          }}
                        >
                          展开问答窗
                        </Button>
                      )}
                    </div>
                  ) : null}

                  {canUseWikiChat && chatPanelNode && chatPanelNode.type === 'document-chat' && useFullscreenChatDialog ? (
                    <Dialog open={wikiFloatingChatOpen} onOpenChange={handleWikiFloatingChatDialogOpenChange}>
                      <DialogContent className="left-0 top-0 z-40 h-[100dvh] max-h-none w-full max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-none bg-background p-0 sm:rounded-none">
                        <DialogHeader className="sr-only">
                          <DialogTitle>DeepWiki 问答</DialogTitle>
                          <DialogDescription>只读模式，先定位 Wiki 再下钻源码证据</DialogDescription>
                        </DialogHeader>
                        <div className="flex h-full min-h-0 flex-col overflow-hidden pt-6">
                          <div className="shrink-0 border-b border-border/40 px-4 pb-3">
                            <p className="text-sm font-semibold text-foreground">DeepWiki 问答</p>
                            <p className="text-xs text-muted-foreground">只读模式，先定位 Wiki 再下钻源码证据</p>
                          </div>
                          <div className="min-h-0 flex-1 overflow-hidden p-3">
                            {renderNode(chatPanelNode, `${nodeKey}-mobile-chat-sheet`)}
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>
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
                          if (isWikiToolbar && action.id === 'analyze') {
                            setWikiControlPanelOpen(false)
                            setWikiPreparingNewAnalysis(false)
                          }
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
        const pageAnchorMap = new Map(pages.map((page) => [page.id, `${page.headingPrefix}-page-anchor`]))
        const pageHeadingGroups = pages.map((page) => ({
          page,
          headings: parseMarkdownHeadings(page.content, page.id, page.title, page.headingPrefix),
        }))
        const allHeadings = pageHeadingGroups.flatMap((group) => group.headings)
        const headingById = new Map(allHeadings.map((heading) => [heading.id, heading]))
        const activePageId = hasPages
          ? (markdownActivePageMap[nodeKey] ?? node.activePageId ?? allHeadings[0]?.pageId ?? fallbackPageId)
          : ''
        const activePage = hasPages
          ? pages.find((page) => page.id === activePageId) ?? pages[0]
          : undefined
        const displaySourcePath = activePage?.sourcePath ?? node.sourcePath
        const activeHeadingId = markdownActiveHeadingMap[nodeKey]
        const tocScope = node.tocScope ?? 'global'
        const tocHeadingGroups = tocScope === 'current' && activePage
          ? pageHeadingGroups.filter((group) => group.page.id === activePage.id)
          : pageHeadingGroups
        const openTocDialog = markdownTocDialogOpenMap[nodeKey] === true
        const minimapHovered = markdownTocHoverMap[nodeKey] === true
        const minimapItems = allHeadings.length > 0
          ? allHeadings.map((heading) => ({
            id: heading.id,
            pageId: heading.pageId,
          }))
          : pages.map((page) => ({
            id: pageAnchorMap.get(page.id) ?? `${buildHeadingPrefix(page.id)}-page-anchor`,
            pageId: page.id,
          }))
        const minimapBarCount = Math.min(minimapItems.length, 24)
        const markdownFallbackEmptyText = node.emptyText ?? '暂无可展示的 Markdown 内容'
        const dynamicWikiEmptyText = (() => {
          if (!isWikiMarkdown) {
            return markdownFallbackEmptyText
          }

          const repositories = normalizeRepositoryList(node.repositoryList)
          const activeRepositoryId = typeof node.activeRepositoryId === 'string'
            ? node.activeRepositoryId
            : ''
          const activeRepository = repositories.find((item) => item.id === activeRepositoryId) ?? repositories[0]
          if (!activeRepository) {
            return markdownFallbackEmptyText
          }

          const scanningTask = Object.values(taskSnapshotMap)
            .filter((task) => {
              return task.taskType === 'ai-indexing-scan'
                && (task.state === 'running' || task.state === 'paused')
            })
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]

          if (!scanningTask) {
            return markdownFallbackEmptyText
          }

          const metadata = scanningTask.metadata ?? {}
          const taskRepositoryPath = typeof metadata.repositoryPath === 'string'
            ? metadata.repositoryPath.trim()
            : ''
          const taskKnowledgeBaseId = typeof metadata.knowledgeBaseId === 'string'
            ? metadata.knowledgeBaseId.trim()
            : ''
          const matchesActiveRepository =
            (taskRepositoryPath.length > 0 && taskRepositoryPath === activeRepository.repoPath)
            || (taskKnowledgeBaseId.length > 0 && taskKnowledgeBaseId === activeRepository.knowledgeBaseId)

          if (!matchesActiveRepository) {
            return markdownFallbackEmptyText
          }

          const detail = typeof scanningTask.progress?.detail === 'string' && scanningTask.progress.detail.trim().length > 0
            ? scanningTask.progress.detail.trim()
            : scanningTask.state === 'paused'
              ? '任务已暂停，可在状态区继续。'
              : '正在分析仓库，请稍候...'

          return scanningTask.state === 'paused'
            ? `任务已暂停：${detail}`
            : `正在分析：${detail}`
        })()

        const updateActiveHeadingByScroll = (): void => {
          if (!hasPages) {
            return
          }

          const container = markdownContainerRefMap.current[nodeKey]
          if (!container) {
            return
          }

          const scrollTop = container.scrollTop
          let currentPageId = pages[0]?.id
          for (const page of pages) {
            const anchorId = pageAnchorMap.get(page.id)
            if (!anchorId) {
              continue
            }
            const anchorElement = container.querySelector(`[data-page-anchor-id="${anchorId}"]`) as HTMLElement | null
            if (!anchorElement) {
              continue
            }
            if (anchorElement.offsetTop - 28 <= scrollTop) {
              currentPageId = page.id
              continue
            }
            break
          }

          if (currentPageId) {
            setMarkdownActivePageMap((prev) => {
              if (prev[nodeKey] === currentPageId) {
                return prev
              }
              return {
                ...prev,
                [nodeKey]: currentPageId,
              }
            })
          }

          if (allHeadings.length === 0) {
            return
          }

          const resolvedHeadings = allHeadings
            .map((heading) => ({
              heading,
              element: resolveHeadingElement(container, heading.id),
            }))
            .filter((item): item is { heading: MarkdownHeadingItem; element: HTMLElement } => Boolean(item.element))

          if (resolvedHeadings.length === 0) {
            return
          }

          const activeViewportTop = scrollTop + 8
          const firstVisible = resolvedHeadings.find((item) => item.element.offsetTop >= activeViewportTop)
          const currentId = firstVisible
            ? firstVisible.heading.id
            : resolvedHeadings[resolvedHeadings.length - 1]?.heading.id

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

          const headingPageId = headingById.get(currentId)?.pageId
          if (headingPageId) {
            setMarkdownActivePageMap((prev) => {
              if (prev[nodeKey] === headingPageId) {
                return prev
              }
              return {
                ...prev,
                [nodeKey]: headingPageId,
              }
            })
          }
        }

        const scrollToMarkdownElement = (
          elementId: string,
          pageId?: string,
          compact = false,
          activeHeadingId?: string,
        ): void => {
          setMarkdownScrollTargetMap((prev) => ({
            ...prev,
            [nodeKey]: {
              elementId,
              pageId,
            },
          }))
          if (pageId) {
            setMarkdownActivePageMap((prev) => ({
              ...prev,
              [nodeKey]: pageId,
            }))
          }
          if (activeHeadingId) {
            setMarkdownActiveHeadingMap((prev) => ({
              ...prev,
              [nodeKey]: activeHeadingId,
            }))
          }
          if (compact) {
            setMarkdownTocDialogOpenMap((prev) => ({
              ...prev,
              [nodeKey]: false,
            }))
          }
        }

        const renderWikiToc = (compact = false): React.ReactElement => (
          <div className={cn('space-y-2', compact ? 'mt-0' : 'mt-2')}>
            {tocHeadingGroups.map((group) => {
              const pageSelected = group.page.id === activePageId
              const pageAnchorId = pageAnchorMap.get(group.page.id)
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
                      const firstHeadingId = group.headings[0]?.id
                      if (firstHeadingId) {
                        scrollToMarkdownElement(firstHeadingId, group.page.id, compact, firstHeadingId)
                      } else if (pageAnchorId) {
                        scrollToMarkdownElement(pageAnchorId, group.page.id, compact)
                      }
                    }}
                  >
                    {group.page.title}
                  </button>
                  {group.headings.length > 0 ? (
                    <div className="space-y-0.5 pl-1">
                      {group.headings.map((heading) => {
                        const selected = activeHeadingId === heading.id
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
                              scrollToMarkdownElement(heading.id, group.page.id, compact, heading.id)
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

        const renderMinimap = (): React.ReactElement | null => {
          if (!isWikiMarkdown || !hasPages || minimapItems.length === 0) {
            return null
          }

          return (
            <div
              className="absolute right-2 top-2 z-30 hidden items-start md:flex"
              onMouseEnter={() => {
                setMarkdownTocHoverMap((prev) => ({
                  ...prev,
                  [nodeKey]: true,
                }))
              }}
              onMouseLeave={() => {
                setMarkdownTocHoverMap((prev) => ({
                  ...prev,
                  [nodeKey]: false,
                }))
              }}
            >
              {minimapHovered ? (
                <div className="mr-2 w-72 max-h-[calc(100%-0.5rem)] overflow-y-auto rounded-xl border border-border/50 bg-background/95 p-3 shadow-sm backdrop-blur-sm">
                  <p className="text-xs font-semibold text-foreground">目录地图</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">全局目录（按页面分组）</p>
                  {renderWikiToc()}
                </div>
              ) : null}

              <div className="mt-1 w-6 rounded-md border border-border/60 bg-background/90 px-1 py-1 shadow-sm">
                <div className="relative h-36">
                  {Array.from({ length: minimapBarCount }, (_, index) => {
                    const start = Math.floor((index * minimapItems.length) / minimapBarCount)
                    const end = Math.max(start + 1, Math.floor(((index + 1) * minimapItems.length) / minimapBarCount))
                    const group = minimapItems.slice(start, end)
                    const target = group[0]
                    if (!target) {
                      return null
                    }

                    const highlighted = group.some((item) => item.id === activeHeadingId || item.pageId === activePageId)
                    return (
                      <button
                        key={`${nodeKey}-minimap-${index}`}
                        type="button"
                        className={cn(
                          'absolute left-[2px] h-[2px] w-[14px] rounded-full transition-colors',
                          highlighted ? 'bg-primary/70' : 'bg-muted-foreground/35 hover:bg-primary/50',
                        )}
                        style={{ top: `${((index + 0.5) / minimapBarCount) * 100}%` }}
                        onClick={() => {
                          scrollToMarkdownElement(target.id, target.pageId)
                        }}
                      />
                    )
                  })}
                </div>
              </div>
            </div>
          )
        }

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
                  isWikiMarkdown && hasPages ? 'md:pr-12' : 'pr-2',
                )}
                onScroll={() => {
                  updateActiveHeadingByScroll()
                }}
              >
                {hasPages ? (
                  <div className="space-y-8 pb-8">
                    {pages.map((page) => {
                      const pageAnchorId = pageAnchorMap.get(page.id)
                      return (
                        <section key={`${nodeKey}-page-${page.id}`} className="space-y-3">
                          {pageAnchorId ? (
                            <div
                              data-page-anchor-id={pageAnchorId}
                              data-heading-id={pageAnchorId}
                              className="h-px w-full"
                            />
                          ) : null}
                          <div className="space-y-0.5">
                            <h6 className="text-sm font-semibold text-foreground">{page.title}</h6>
                            {page.sourcePath ? (
                              <p className="text-[11px] font-mono text-muted-foreground">{page.sourcePath}</p>
                            ) : null}
                          </div>

                          {page.content.length > 0 ? (
                            <MessageResponse headingIdPrefix={page.headingPrefix}>{page.content}</MessageResponse>
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              {node.emptyText ?? '该页面暂无可展示内容'}
                            </p>
                          )}
                        </section>
                      )
                    })}
                  </div>
                ) : content.length > 0 ? (
                  <MessageResponse>{content}</MessageResponse>
                ) : (
                  <p className="text-sm text-muted-foreground mt-4">
                    {dynamicWikiEmptyText}
                  </p>
                )}
              </div>

              {renderMinimap()}
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
          <div key={nodeKey} className="h-full min-h-0 overflow-hidden">
            <PluginReadonlyChatPanel
              nodeKey={nodeKey}
              chatNode={chatNode}
              state={state}
              isWikiDocumentChat={isWikiDocumentChat}
              onDraftChange={(value) => {
                updateChatState(nodeKey, (current) => ({
                  ...current,
                  draft: value,
                  knowledgeBaseId: chatNode.knowledgeBaseId,
                }), chatNode)
              }}
              onSend={() => {
                void sendDocumentChat(nodeKey, chatNode)
              }}
            />
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

  return (
    <div
      className="h-full min-h-0 min-w-0 flex flex-col overflow-hidden"
      data-wiki-viewport-mode={isWikiWorkbench ? wikiViewportMode : undefined}
    >
      {renderNode(canvas.root, 'root')}
    </div>
  )
}
