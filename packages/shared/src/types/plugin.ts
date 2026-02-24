/**
 * 插件系统相关类型定义
 *
 * 定义插件 manifest、权限、capability、生命周期状态与 IPC 输入输出。
 */

/** 插件权限（权限用于安全边界控制） */
export type PluginPermission =
  | 'filesystem:read'
  | 'filesystem:write'
  | 'llm:invoke'
  | 'mcp:access'
  | 'events:emit'
  | 'channels:read'

/** 插件生命周期状态 */
export type PluginLifecycleState =
  | 'installed'
  | 'active'
  | 'inactive'
  | 'error'
  | 'uninstalled'

/** 插件 capability 声明（能力用于功能发现与编排） */
export interface PluginCapability {
  /** 能力键（例如 wiki:local-repository） */
  key: string
  /** 能力显示名称 */
  title?: string
  /** 能力说明 */
  description?: string
  /** 能力扩展配置 */
  config?: Record<string, unknown>
}

/** 宿主版本兼容声明 */
export interface PluginCompatibility {
  /** 最低宿主版本 */
  minHostVersion?: string
  /** 最高宿主版本 */
  maxHostVersion?: string
}

/** 插件入口定义 */
export interface PluginEntry {
  /** 主进程入口（相对于插件安装目录） */
  main: string
  /** 渲染进程入口（可选） */
  renderer?: string
}

/** 插件清单（manifest） */
export interface PluginManifest {
  /** manifest 版本（V1 固定为 1） */
  manifestVersion: 1
  /** 插件唯一标识 */
  id: string
  /** 插件名称 */
  name: string
  /** 插件版本 */
  version: string
  /** 插件描述 */
  description?: string
  /** 插件作者 */
  author?: string
  /** 插件入口 */
  entry: PluginEntry
  /** 权限声明 */
  permissions: PluginPermission[]
  /** 能力声明 */
  capabilities: PluginCapability[]
  /** 工作台能力声明（可选） */
  workbench?: {
    /** 是否声明画布钩子 */
    canvasHook?: boolean
  }
  /** 宿主兼容信息 */
  compatibility?: PluginCompatibility
}

/** 已安装插件记录 */
export interface PluginRecord {
  /** 插件 ID（与 manifest.id 一致） */
  id: string
  /** 插件清单 */
  manifest: PluginManifest
  /** 安装目录 */
  installPath: string
  /** 插件工作区目录 */
  workspacePath: string
  /** 当前生命周期状态 */
  state: PluginLifecycleState
  /** 安装时间戳 */
  installedAt: number
  /** 更新时间戳 */
  updatedAt: number
  /** 最近错误（state=error 时） */
  lastError?: string
}

/** 插件索引文件格式 */
export interface PluginsIndex {
  /** 索引版本 */
  version: number
  /** 插件记录列表 */
  plugins: PluginRecord[]
}

/** 插件安装输入（仅本地路径） */
export interface PluginInstallInput {
  /** 本地插件目录路径 */
  sourcePath: string
  /** 安装后是否立即启用 */
  enableAfterInstall?: boolean
}

/** 插件生命周期操作输入 */
export interface PluginLifecycleInput {
  pluginId: string
}

/** 强制同步内置插件输入 */
export interface PluginForceSyncBundledInput {
  pluginId: string
}

/** 强制同步内置插件结果 */
export interface PluginForceSyncBundledResult {
  success: boolean
  pluginId: string
  /** 执行阶段：validate/disable/copy/enable/done */
  stage: 'validate' | 'disable' | 'copy' | 'enable' | 'done'
  /** 是否执行了运行态重载（先禁用后启用） */
  reloaded: boolean
  message?: string
  error?: string
  plugin?: PluginRecord
}

/** 插件能力调用输入 */
export interface PluginInvokeCapabilityInput {
  pluginId: string
  capabilityKey: string
  payload?: Record<string, unknown>
}

/** 插件能力调用结果 */
export interface PluginInvokeCapabilityResult {
  success: boolean
  pluginId: string
  capabilityKey: string
  data?: unknown
  error?: string
}

/** 插件状态查询输入 */
export interface PluginStatusInput {
  pluginId: string
}

/** 插件状态查询结果 */
export interface PluginStatusResult {
  pluginId: string
  state: PluginLifecycleState
  lastError?: string
}

/** 插件操作结果 */
export interface PluginOperationResult {
  success: boolean
  pluginId: string
  state: PluginLifecycleState
  message?: string
  error?: string
  plugin?: PluginRecord
}

/** 工作台分栏方向 */
export type PluginWorkbenchSplitDirection = 'horizontal' | 'vertical'

/** 工作台动作按钮视觉样式 */
export type PluginWorkbenchActionVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

/** 工作台组件类型 */
export type PluginWorkbenchNodeType =
  | 'page'
  | 'panel'
  | 'split'
  | 'card'
  | 'toolbar'
  | 'markdown'
  | 'task-status'
  | 'document-chat'

/** 工作台动作输入类型 */
export type PluginWorkbenchActionInputType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'path' | 'model-select'

/** 工作台动作输入选项（select 类型） */
export interface PluginWorkbenchActionInputOption {
  label: string
  value: string
}

/** 工作台动作输入定义 */
export interface PluginWorkbenchActionInputDefinition {
  /** 字段键（会写入 payload） */
  key: string
  /** 字段标签 */
  label: string
  /** 输入类型 */
  type: PluginWorkbenchActionInputType
  /** 字段说明 */
  description?: string
  /** 占位提示 */
  placeholder?: string
  /** 是否必填 */
  required?: boolean
  /** 默认值 */
  defaultValue?: string | number | boolean
  /** select 可选项 */
  options?: PluginWorkbenchActionInputOption[]
  /** number 最小值 */
  min?: number
  /** number 最大值 */
  max?: number
  /** number 步长 */
  step?: number
}

/** 工作台动作定义（用于声明式 UI 交互） */
export interface PluginWorkbenchActionDefinition {
  /** 动作唯一标识 */
  id: string
  /** 动作显示名称 */
  label: string
  /** 动作描述 */
  description?: string
  /** 动作样式 */
  variant?: PluginWorkbenchActionVariant
  /** 是否禁用 */
  disabled?: boolean
  /** 触发动作时携带的默认参数 */
  payload?: Record<string, unknown>
  /** 动作输入定义（由宿主渲染通用输入控件） */
  inputs?: PluginWorkbenchActionInputDefinition[]
}

/** 工作台节点基础结构 */
export interface PluginWorkbenchBaseNode {
  /** 节点类型 */
  type: PluginWorkbenchNodeType
  /** 节点唯一标识（可选） */
  id?: string
  /** 节点标题 */
  title?: string
  /** 节点描述 */
  description?: string
}

/** 页面容器节点 */
export interface PluginWorkbenchPageNode extends PluginWorkbenchBaseNode {
  type: 'page'
  children: PluginWorkbenchNode[]
}

/** 面板容器节点 */
export interface PluginWorkbenchPanelNode extends PluginWorkbenchBaseNode {
  type: 'panel'
  children: PluginWorkbenchNode[]
}

/** 分栏节点 */
export interface PluginWorkbenchSplitNode extends PluginWorkbenchBaseNode {
  type: 'split'
  direction: PluginWorkbenchSplitDirection
  /** 子节点比例，按 children 顺序对应 */
  ratios?: number[]
  children: PluginWorkbenchNode[]
}

/** 卡片节点 */
export interface PluginWorkbenchCardNode extends PluginWorkbenchBaseNode {
  type: 'card'
  children?: PluginWorkbenchNode[]
}

/** 工具栏节点 */
export interface PluginWorkbenchToolbarNode extends PluginWorkbenchBaseNode {
  type: 'toolbar'
  actions: PluginWorkbenchActionDefinition[]
}

/** Markdown 展示节点 */
export interface PluginWorkbenchMarkdownPage {
  /** 页面 ID（用于切换、锚点跳转） */
  id: string
  /** 页面标题 */
  title: string
  /** 直接渲染的 markdown 文本 */
  content?: string
  /** 从插件工作区读取的 markdown 文件路径 */
  sourcePath?: string
}

/** Markdown 展示节点 */
export interface PluginWorkbenchMarkdownNode extends PluginWorkbenchBaseNode {
  type: 'markdown'
  /** 直接渲染的 markdown 文本 */
  content?: string
  /** 从插件工作区读取的 markdown 文件路径 */
  sourcePath?: string
  /** 当内容为空时的提示文案 */
  emptyText?: string
  /** 多页 Markdown（可选，向后兼容单页 content/sourcePath） */
  pages?: PluginWorkbenchMarkdownPage[]
  /** 当前激活页面 ID */
  activePageId?: string
  /** 目录范围 */
  tocScope?: 'global' | 'current'
}

/** 任务运行态节点 */
export interface PluginWorkbenchTaskStatusNode extends PluginWorkbenchBaseNode {
  type: 'task-status'
  /** 关联任务 ID（可选，未提供时显示插件最近任务） */
  taskId?: string
  /** 关联任务类型（可选，与 taskId 二选一） */
  taskType?: string
  /** 显示控制动作 */
  controlActions?: PluginTaskControlAction[]
  /** 空态文案 */
  emptyText?: string
}

/** 文档会话节点 */
export interface PluginWorkbenchDocumentChatNode extends PluginWorkbenchBaseNode {
  type: 'document-chat'
  /** 文档库标识 */
  knowledgeBaseId: string
  /** 会话标识（可选，缺省则由宿主自动创建） */
  sessionId?: string
  /** 默认模型 */
  model?: string
  /** 检索条数 */
  topK?: number
  /** 输入占位文案 */
  placeholder?: string
  /** 空态文案 */
  emptyText?: string
}

/** 声明式画布组件树 */
export type PluginWorkbenchNode =
  | PluginWorkbenchPageNode
  | PluginWorkbenchPanelNode
  | PluginWorkbenchSplitNode
  | PluginWorkbenchCardNode
  | PluginWorkbenchToolbarNode
  | PluginWorkbenchMarkdownNode
  | PluginWorkbenchTaskStatusNode
  | PluginWorkbenchDocumentChatNode

/** 插件工作台画布结构 */
export interface PluginWorkbenchCanvas {
  /** 画布协议版本 */
  version: 1
  /** 画布标题 */
  title?: string
  /** 画布描述 */
  description?: string
  /** 声明式组件树根节点 */
  root: PluginWorkbenchNode
}

/** 工作台动作触发请求（由宿主发起） */
export interface PluginWorkbenchActionTrigger {
  /** 触发动作 ID */
  actionId: string
  /** 来源节点 ID（可选） */
  sourceNodeId?: string
  /** 动作参数 */
  payload?: Record<string, unknown>
}

/** 获取插件工作台画布时的请求参数 */
export interface PluginWorkbenchCanvasRequest {
  /** 请求原因，便于插件区分首屏和刷新 */
  reason?: 'initial' | 'refresh'
  /** 扩展上下文 */
  context?: Record<string, unknown>
}

/** 工作台错误码 */
export type PluginWorkbenchErrorCode =
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_NOT_ACTIVE'
  | 'WORKBENCH_HOOK_NOT_IMPLEMENTED'
  | 'WORKBENCH_CANVAS_INVALID'
  | 'WORKBENCH_ACTION_INVALID'
  | 'WORKBENCH_HOOK_FAILED'
  | 'WORKBENCH_ACTION_FAILED'

/** 工作台统一错误结构 */
export interface PluginWorkbenchError {
  code: PluginWorkbenchErrorCode | (string & {})
  message: string
}

/** 工作台统一响应结构 */
export interface PluginWorkbenchResponse<T = unknown> {
  success: boolean
  data?: T
  error?: PluginWorkbenchError
}

/** 工作台列表项 */
export interface PluginWorkbenchListItem {
  pluginId: string
  name: string
  description?: string
  state: PluginLifecycleState
  hasCanvasHook: boolean
}

/** 工作台列表请求 */
export interface PluginWorkbenchListInput {
  /** 是否包含未启用插件，默认 true */
  includeInactive?: boolean
}

/** 工作台列表响应 */
export type PluginWorkbenchListResult = PluginWorkbenchResponse<PluginWorkbenchListItem[]>

/** 获取工作台画布请求 */
export interface PluginGetWorkbenchCanvasInput {
  pluginId: string
  request?: PluginWorkbenchCanvasRequest
}

/** 获取工作台画布响应 */
export type PluginWorkbenchCanvasResult = PluginWorkbenchResponse<PluginWorkbenchCanvas>

/** 调用工作台动作请求 */
export interface PluginInvokeWorkbenchActionInput {
  pluginId: string
  action: PluginWorkbenchActionTrigger
}

/** 调用工作台动作响应 */
export type PluginWorkbenchActionInvokeResult = PluginWorkbenchResponse<unknown>

/** 插件任务状态 */
export type PluginTaskState = 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed'

/** 插件任务控制动作 */
export type PluginTaskControlAction = 'pause' | 'resume' | 'stop'

/** 插件任务进度 */
export interface PluginTaskProgress {
  /** 当前阶段（如 scan/chunk/embed/persist） */
  stage: string
  /** 百分比进度 0-100 */
  percent: number
  /** 可读进度描述 */
  detail?: string
  /** 已处理数量 */
  processed?: number
  /** 总数量 */
  total?: number
}

/** 插件任务快照 */
export interface PluginTaskSnapshot {
  taskId: string
  pluginId: string
  taskType: string
  state: PluginTaskState
  progress?: PluginTaskProgress
  metadata?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  startedAt: string
  updatedAt: string
  completedAt?: string
}

/** 插件任务事件类型 */
export type PluginTaskEventType =
  | 'started'
  | 'progress'
  | 'paused'
  | 'resumed'
  | 'stopped'
  | 'completed'
  | 'failed'

/** 插件任务事件 */
export interface PluginTaskEvent {
  type: PluginTaskEventType
  task: PluginTaskSnapshot
  timestamp: string
}

/** Wiki 输出语言 */
export type PluginWikiLanguage = 'zh' | 'en'

/** AI 分析深度 */
export type PluginAiAnalysisDepth = 'standard' | 'deep'

/** AI 扫描模式 */
export type PluginAiScanMode = 'smart' | 'full'

/** 索引分块策略 */
export interface PluginAiIndexChunkStrategy {
  maxChunkChars: number
  overlapChars: number
}

/** 索引分块记录 */
export interface PluginAiIndexChunkRecord {
  id: string
  filePath: string
  fileFingerprint: string
  chunkIndex: number
  content: string
  embedding: number[]
}

/** 索引元数据 */
export interface PluginAiIndexMetadata {
  indexVersion: string
  pluginId: string
  knowledgeBaseId: string
  repositoryPath: string
  repositoryFingerprint: string
  model: string
  language?: PluginWikiLanguage
  analysisDepth?: PluginAiAnalysisDepth
  chunkStrategy: PluginAiIndexChunkStrategy
  generatedAt: string
  totalFiles: number
  totalChunks: number
  reusedChunks: number
  rebuiltChunks: number
  fileFingerprints: Record<string, string>
}

/** 索引摘要 */
export interface PluginAiIndexSummary {
  knowledgeBaseId: string
  metadata: PluginAiIndexMetadata
  indexPath: string
  markdownPath: string
  generationMode?: 'single-page' | 'multi-page'
  pages?: Array<{ id: string; title: string; path: string }>
}

/** 启动 AI 扫描任务输入 */
export interface PluginStartAiIndexingTaskInput {
  pluginId: string
  repositoryPath: string
  knowledgeBaseId?: string
  model?: string
  language?: PluginWikiLanguage
  analysisDepth?: PluginAiAnalysisDepth
  scanMode?: PluginAiScanMode
  subagentCount?: number
  maxFileBytesForFullAnalyze?: number
  chunkStrategy?: Partial<PluginAiIndexChunkStrategy>
}

/** 插件任务控制输入 */
export interface PluginTaskControlInput {
  pluginId: string
  taskId: string
}

/** 插件任务状态查询输入 */
export interface PluginTaskStatusInput {
  pluginId: string
  taskId: string
}

/** 插件任务操作响应 */
export interface PluginTaskOperationResult {
  success: boolean
  task?: PluginTaskSnapshot
  error?: string
}

/** 文档会话消息角色 */
export type PluginDocumentChatMessageRole = 'system' | 'user' | 'assistant'

/** 文档会话消息 */
export interface PluginDocumentChatMessage {
  role: PluginDocumentChatMessageRole
  content: string
  createdAt?: string
}

/** 文档会话引用 */
export interface PluginDocumentChatReference {
  chunkId: string
  filePath: string
  score: number
  snippet: string
}

/** 文档会话发送输入 */
export interface PluginDocumentChatSendInput {
  pluginId: string
  knowledgeBaseId: string
  sessionId?: string
  model?: string
  messages: PluginDocumentChatMessage[]
  topK?: number
}

/** 文档会话发送响应 */
export interface PluginDocumentChatSendResult {
  success: boolean
  pluginId: string
  knowledgeBaseId: string
  sessionId: string
  error?: string
}

/** 文档会话结束输入 */
export interface PluginDocumentChatEndInput {
  pluginId: string
  knowledgeBaseId: string
  sessionId: string
}

/** 文档会话历史查询输入 */
export interface PluginDocumentChatHistoryInput {
  pluginId: string
  knowledgeBaseId: string
  sessionId: string
}

/** 文档会话历史响应 */
export interface PluginDocumentChatHistoryResult {
  pluginId: string
  knowledgeBaseId: string
  sessionId: string
  messages: PluginDocumentChatMessage[]
}

/** 文档会话流式事件类型 */
export type PluginDocumentChatEventType = 'delta' | 'citation' | 'done' | 'error'

/** 文档会话流式事件 */
export interface PluginDocumentChatEvent {
  type: PluginDocumentChatEventType
  pluginId: string
  knowledgeBaseId: string
  sessionId: string
  model?: string
  delta?: string
  references?: PluginDocumentChatReference[]
  message?: PluginDocumentChatMessage
  error?: string
  timestamp: string
}

/** 插件渠道 API 模型信息 */
export interface PluginChannelModel {
  /** 模型 ID */
  id: string
  /** 模型显示名称 */
  name: string
  /** 所属渠道名称 */
  channelName: string
}

/** 插件渠道 API 接口 */
export interface PluginChannelsAPI {
  /** 获取所有启用渠道的启用模型列表 */
  getAvailableModels: () => Promise<PluginChannelModel[]>
}

/**
 * 插件运行时生命周期管理
 *
 * - `signal`：插件被禁用/卸载时会触发 abort
 * - `onCleanup`：注册资源清理回调，宿主会在禁用时执行
 */
export interface PluginRuntimeLifecycle {
  signal: AbortSignal
  onCleanup: (cleanup: () => void | Promise<void>) => void
  throwIfAborted: () => void
}

/**
 * 插件运行时上下文
 *
 * V1 仅暴露受控 facade，插件不得直接访问宿主内部 service。
 */
export interface PluginRuntimeContext {
  pluginId: string
  installPath: string
  workspacePath: string
  lifecycle: PluginRuntimeLifecycle
  api: {
    llm: {
      invoke: (input: Record<string, unknown>) => Promise<string>
    }
    fs: {
      readText: (path: string) => Promise<string>
      writeText: (path: string, content: string) => Promise<void>
    }
    mcp: {
      callTool: (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>
    }
    events: {
      emit: (event: string, payload?: Record<string, unknown>) => void
    }
    channels: PluginChannelsAPI
    workbench: {
      /** 从插件工作区读取文本文件 */
      readFile: (path: string) => Promise<string>
      /** 调用插件自身已声明 capability */
      invokeCapability: (capabilityKey: string, payload?: Record<string, unknown>) => Promise<unknown>
      /** 调用插件工作台动作钩子 */
      invokeAction: (action: PluginWorkbenchActionTrigger) => Promise<PluginWorkbenchActionInvokeResult>
    }
    aiIndexing: {
      /** 启动 AI 扫描与索引任务 */
      startScan: (
        input: Omit<PluginStartAiIndexingTaskInput, 'pluginId'>,
      ) => Promise<PluginTaskOperationResult>
      /** 暂停任务 */
      pauseTask: (input: Omit<PluginTaskControlInput, 'pluginId'>) => Promise<PluginTaskOperationResult>
      /** 继续任务 */
      resumeTask: (input: Omit<PluginTaskControlInput, 'pluginId'>) => Promise<PluginTaskOperationResult>
      /** 停止任务 */
      stopTask: (input: Omit<PluginTaskControlInput, 'pluginId'>) => Promise<PluginTaskOperationResult>
      /** 查询任务状态 */
      getTaskStatus: (input: Omit<PluginTaskStatusInput, 'pluginId'>) => Promise<PluginTaskOperationResult>
      /** 获取最新索引摘要 */
      getLatestIndexSummary: (knowledgeBaseId?: string) => Promise<PluginAiIndexSummary | null>
    }
    documentChat: {
      /** 发送文档会话消息 */
      send: (input: Omit<PluginDocumentChatSendInput, 'pluginId'>) => Promise<PluginDocumentChatSendResult>
      /** 结束文档会话 */
      endSession: (input: Omit<PluginDocumentChatEndInput, 'pluginId'>) => Promise<{ success: boolean; error?: string }>
      /** 查询文档会话历史 */
      getHistory: (
        input: Omit<PluginDocumentChatHistoryInput, 'pluginId'>,
      ) => Promise<PluginDocumentChatHistoryResult>
    }
  }
}

/** 插件入口模块接口 */
export interface PluginModule {
  activate?: (context: PluginRuntimeContext) => Promise<void> | void
  deactivate?: () => Promise<void> | void
  invokeCapability?: (
    capabilityKey: string,
    payload?: Record<string, unknown>,
  ) => Promise<unknown> | unknown
  /**
   * 获取插件工作台声明式画布
   *
   * 允许直接返回画布对象，或返回统一响应结构。
   */
  getWorkbenchCanvas?: (
    request?: PluginWorkbenchCanvasRequest,
  ) =>
    | Promise<PluginWorkbenchCanvas | PluginWorkbenchCanvasResult>
    | PluginWorkbenchCanvas
    | PluginWorkbenchCanvasResult
  /**
   * 处理插件工作台动作调用
   *
   * 允许直接返回任意数据，或返回统一响应结构。
   */
  invokeWorkbenchAction?: (
    action: PluginWorkbenchActionTrigger,
  ) => Promise<PluginWorkbenchActionInvokeResult | unknown> | PluginWorkbenchActionInvokeResult | unknown
}

/** 插件相关 IPC 通道常量 */
export const PLUGIN_IPC_CHANNELS = {
  /** 获取插件列表 */
  LIST: 'plugin:list',
  /** 从本地路径安装插件 */
  INSTALL_LOCAL: 'plugin:install-local',
  /** 启用插件 */
  ENABLE: 'plugin:enable',
  /** 禁用插件 */
  DISABLE: 'plugin:disable',
  /** 卸载插件 */
  UNINSTALL: 'plugin:uninstall',
  /** 强制同步内置插件（开发者能力） */
  FORCE_SYNC_BUNDLED: 'plugin:force-sync-bundled',
  /** 获取插件状态 */
  GET_STATUS: 'plugin:get-status',
  /** 调用插件能力 */
  INVOKE_CAPABILITY: 'plugin:invoke-capability',
  /** 获取插件工作台列表 */
  WORKBENCH_LIST: 'plugin:workbench:list',
  /** 获取插件工作台画布 */
  WORKBENCH_GET_CANVAS: 'plugin:workbench:get-canvas',
  /** 调用插件工作台动作 */
  WORKBENCH_INVOKE_ACTION: 'plugin:workbench:invoke-action',
  /** 启动插件 AI 扫描任务 */
  TASK_START_AI_INDEXING: 'plugin:task:start-ai-indexing',
  /** 暂停插件任务 */
  TASK_PAUSE: 'plugin:task:pause',
  /** 继续插件任务 */
  TASK_RESUME: 'plugin:task:resume',
  /** 停止插件任务 */
  TASK_STOP: 'plugin:task:stop',
  /** 获取插件任务状态 */
  TASK_GET_STATUS: 'plugin:task:get-status',
  /** 插件任务事件流 */
  TASK_STREAM_EVENT: 'plugin:task:stream:event',
  /** 发送文档会话消息 */
  DOC_CHAT_SEND: 'plugin:doc-chat:send',
  /** 结束文档会话 */
  DOC_CHAT_END: 'plugin:doc-chat:end',
  /** 查询文档会话历史 */
  DOC_CHAT_GET_HISTORY: 'plugin:doc-chat:get-history',
  /** 文档会话事件流 */
  DOC_CHAT_STREAM_EVENT: 'plugin:doc-chat:stream:event',
} as const
