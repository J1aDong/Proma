/**
 * 插件权限门禁
 *
 * 提供统一的权限判断与拒绝错误，默认拒绝未声明权限。
 */

import type { PluginManifest, PluginPermission } from '@proma/shared'

/** 插件权限拒绝错误 */
export class PluginPermissionDeniedError extends Error {
  constructor(pluginId: string, permission: PluginPermission) {
    super(`插件 ${pluginId} 缺少权限: ${permission}`)
    this.name = 'PluginPermissionDeniedError'
  }
}

/** 判断插件是否声明了指定权限 */
export function hasPluginPermission(manifest: PluginManifest, permission: PluginPermission): boolean {
  return manifest.permissions.includes(permission)
}

/**
 * 断言插件具备指定权限
 *
 * 未声明权限时抛出错误，调用方应在边界处捕获并转换为可诊断错误。
 */
export function assertPluginPermission(manifest: PluginManifest, permission: PluginPermission): void {
  if (!hasPluginPermission(manifest, permission)) {
    throw new PluginPermissionDeniedError(manifest.id, permission)
  }
}
