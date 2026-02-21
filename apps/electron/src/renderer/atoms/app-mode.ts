/**
 * App Mode Atom - 应用模式状态
 *
 * - chat: 对话模式
 * - agent: Agent 模式（原 Flow）
 * - plugin: 插件工作台模式
 */

import { atomWithStorage } from 'jotai/utils'

export type AppMode = 'chat' | 'agent' | 'plugin'

/** App 模式，自动持久化到 localStorage */
export const appModeAtom = atomWithStorage<AppMode>('proma-app-mode', 'chat')
