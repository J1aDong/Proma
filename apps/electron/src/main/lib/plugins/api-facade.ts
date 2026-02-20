/**
 * 插件 API Facade
 *
 * 仅向插件暴露受控能力，避免插件直接依赖宿主内部实现。
 */

import { dirname, resolve, sep } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  PluginManifest,
  PluginRuntimeContext,
} from '@proma/shared'
import { assertPluginPermission } from './permission-gate'

/**
 * 解析插件工作区内路径，禁止越界访问。
 */
function resolveWorkspaceFilePath(workspacePath: string, targetPath: string): string {
  const workspaceRoot = resolve(workspacePath)
  const resolvedTarget = resolve(workspaceRoot, targetPath)

  if (resolvedTarget !== workspaceRoot && !resolvedTarget.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error('插件文件访问越界')
  }

  return resolvedTarget
}

/** 创建插件运行时上下文 */
export function createPluginRuntimeContext(
  manifest: PluginManifest,
  installPath: string,
  workspacePath: string,
  options: {
    abortSignal: AbortSignal
    registerCleanup: (cleanup: () => void | Promise<void>) => void
  },
): PluginRuntimeContext {
  return {
    pluginId: manifest.id,
    installPath,
    workspacePath,
    lifecycle: {
      signal: options.abortSignal,
      onCleanup: options.registerCleanup,
      throwIfAborted: (): void => {
        if (options.abortSignal.aborted) {
          throw new Error(`插件已终止: ${manifest.id}`)
        }
      },
    },
    api: {
      llm: {
        invoke: async (_input: Record<string, unknown>): Promise<string> => {
          assertPluginPermission(manifest, 'llm:invoke')
          if (options.abortSignal.aborted) {
            throw new Error(`插件已终止: ${manifest.id}`)
          }
          throw new Error('插件 LLM 能力暂未实现')
        },
      },
      fs: {
        readText: async (targetPath: string): Promise<string> => {
          assertPluginPermission(manifest, 'filesystem:read')
          if (options.abortSignal.aborted) {
            throw new Error(`插件已终止: ${manifest.id}`)
          }
          const safePath = resolveWorkspaceFilePath(workspacePath, targetPath)
          return readFileSync(safePath, 'utf-8')
        },
        writeText: async (targetPath: string, content: string): Promise<void> => {
          assertPluginPermission(manifest, 'filesystem:write')
          if (options.abortSignal.aborted) {
            throw new Error(`插件已终止: ${manifest.id}`)
          }
          const safePath = resolveWorkspaceFilePath(workspacePath, targetPath)
          mkdirSync(dirname(safePath), { recursive: true })
          writeFileSync(safePath, content, 'utf-8')
        },
      },
      mcp: {
        callTool: async (
          _serverName: string,
          _toolName: string,
          _args: Record<string, unknown>,
        ): Promise<unknown> => {
          assertPluginPermission(manifest, 'mcp:access')
          if (options.abortSignal.aborted) {
            throw new Error(`插件已终止: ${manifest.id}`)
          }
          throw new Error('插件 MCP 能力暂未实现')
        },
      },
      events: {
        emit: (_event: string, _payload?: Record<string, unknown>): void => {
          assertPluginPermission(manifest, 'events:emit')
          if (options.abortSignal.aborted) {
            throw new Error(`插件已终止: ${manifest.id}`)
          }
        },
      },
    },
  }
}
