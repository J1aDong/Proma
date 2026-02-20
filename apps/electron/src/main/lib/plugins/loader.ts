/**
 * 插件加载器
 *
 * 负责按 manifest.entry.main 动态加载插件入口模块。
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginManifest, PluginModule } from '@proma/shared'

/**
 * 加载插件主入口模块
 *
 * 说明：esbuild 构建产物在 Node 环境运行，这里使用 file:// URL 触发动态导入。
 */
export async function loadPluginModule(
  installPath: string,
  manifest: PluginManifest,
): Promise<PluginModule> {
  const entryPath = resolve(installPath, manifest.entry.main)
  const moduleUrl = pathToFileURL(entryPath).href
  const module = await import(moduleUrl)

  const pluginModule = module as PluginModule
  if (!pluginModule || (typeof pluginModule !== 'object' && typeof pluginModule !== 'function')) {
    throw new Error(`插件 ${manifest.id} 入口模块无效: ${entryPath}`)
  }

  return pluginModule
}
