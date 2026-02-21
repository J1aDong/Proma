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

/** 工作台动作输入类型 */
export type PluginWorkbenchActionInputType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'path'

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
export interface PluginWorkbenchMarkdownNode extends PluginWorkbenchBaseNode {
  type: 'markdown'
  /** 直接渲染的 markdown 文本 */
  content?: string
  /** 从插件工作区读取的 markdown 文件路径 */
  sourcePath?: string
  /** 当内容为空时的提示文案 */
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

/**
 * 插件运行时生命周期能力
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
    workbench: {
      /** 从插件工作区读取文本文件 */
      readFile: (path: string) => Promise<string>
      /** 调用插件自身已声明 capability */
      invokeCapability: (capabilityKey: string, payload?: Record<string, unknown>) => Promise<unknown>
      /** 调用插件工作台动作钩子 */
      invokeAction: (action: PluginWorkbenchActionTrigger) => Promise<PluginWorkbenchActionInvokeResult>
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
} as const
