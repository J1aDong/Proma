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
} as const
