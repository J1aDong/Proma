import { existsSync, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'

/** @type {import('@proma/shared').PluginRuntimeContext | null} */
let runtimeContext = null

/** @type {(() => void) | null} */
let abortListener = null

const CAPABILITY_KEY = 'wiki:local-repository'
const LATEST_JSON_PATH = 'wiki/latest.json'
const LATEST_MD_PATH = 'wiki/latest.md'

const WORKBENCH_ERROR_CODE = {
  pluginNotActive: 'PLUGIN_NOT_ACTIVE',
  hookFailed: 'WORKBENCH_HOOK_FAILED',
  actionInvalid: 'WORKBENCH_ACTION_INVALID',
}

const WORKBENCH_ACTION_ID = {
  analyze: 'analyze',
  getLatest: 'get-latest',
}

/**
 * @param {string} code
 * @param {string} message
 */
function createWorkbenchError(code, message) {
  return {
    success: false,
    error: {
      code,
      message,
    },
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function readWorkspaceFileIfExists(filePath) {
  if (!runtimeContext) {
    return null
  }

  try {
    return await runtimeContext.api.workbench.readFile(filePath)
  } catch {
    return null
  }
}
/**
 * @typedef {{
 *   rootPath: string
 *   generatedAt: string
 *   stats: {
 *     directories: number
 *     files: number
 *     codeFiles: number
 *   }
 *   topLevelEntries: Array<{ name: string, type: 'dir' | 'file' }>
 *   sampleCodeFiles: string[]
 *   keyFiles: Array<{ path: string, preview: string }>
 *   markdown: string
 * }} WikiReport
 */

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.turbo', '.idea', '.vscode'])
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.rs', '.py', '.java', '.kt', '.swift',
  '.dart', '.vue', '.svelte', '.css', '.scss',
  '.json', '.yaml', '.yml', '.md', '.toml', '.sh'
])

const KEY_FILES = [
  'README.md',
  'package.json',
  'bun.lock',
  'pnpm-lock.yaml',
  'yarn.lock',
  'go.mod',
  'Cargo.toml',
  'pubspec.yaml',
  'tsconfig.json',
]

/**
 * 插件激活
 * @param {import('@proma/shared').PluginRuntimeContext} context
 */
export async function activate(context) {
  runtimeContext = context

  abortListener = () => {}
  context.lifecycle.signal.addEventListener('abort', abortListener)

  context.lifecycle.onCleanup(() => {
    if (abortListener) {
      context.lifecycle.signal.removeEventListener('abort', abortListener)
      abortListener = null
    }
  })
}

/**
 * 插件禁用
 */
export async function deactivate() {
  if (runtimeContext && abortListener) {
    runtimeContext.lifecycle.signal.removeEventListener('abort', abortListener)
    abortListener = null
  }

  runtimeContext = null
}

/**
 * 插件能力调用入口
 * @param {string} capabilityKey
 * @param {Record<string, unknown> | undefined} payload
 * @returns {Promise<unknown>}
 */
async function runCapabilityAction(payload) {
  if (!runtimeContext) {
    throw new Error('插件尚未激活')
  }

  const action = typeof payload?.action === 'string' ? payload.action : WORKBENCH_ACTION_ID.analyze

  if (action === 'ping') {
    return {
      success: true,
      action: 'ping',
      pluginId: runtimeContext.pluginId,
      message: 'wiki 插件可用',
    }
  }

  if (action === WORKBENCH_ACTION_ID.analyze) {
    runtimeContext.lifecycle.throwIfAborted()

    const repoPath = normalizeRepoPath(payload)
    const report = await analyzeRepository(repoPath)

    runtimeContext.lifecycle.throwIfAborted()

    await runtimeContext.api.fs.writeText(LATEST_JSON_PATH, JSON.stringify(report, null, 2))
    await runtimeContext.api.fs.writeText(LATEST_MD_PATH, report.markdown)

    return {
      success: true,
      action: WORKBENCH_ACTION_ID.analyze,
      report,
    }
  }

  if (action === WORKBENCH_ACTION_ID.getLatest) {
    runtimeContext.lifecycle.throwIfAborted()

    const stored = await runtimeContext.api.fs.readText(LATEST_JSON_PATH)
    return {
      success: true,
      action: WORKBENCH_ACTION_ID.getLatest,
      report: JSON.parse(stored),
    }
  }

  throw new Error(`不支持的 action: ${action}`)
}

/**
 * 插件能力调用入口
 * @param {string} capabilityKey
 * @param {Record<string, unknown> | undefined} payload
 * @returns {Promise<unknown>}
 */
export async function invokeCapability(capabilityKey, payload) {
  if (!runtimeContext) {
    throw new Error('插件尚未激活')
  }

  if (capabilityKey !== CAPABILITY_KEY) {
    throw new Error(`不支持的 capability: ${capabilityKey}`)
  }

  return runCapabilityAction(payload)
}

/**
 * 插件工作台画布入口
 * @returns {Promise<import('@proma/shared').PluginWorkbenchResponse<import('@proma/shared').PluginWorkbenchCanvas>>}
 */
export async function getWorkbenchCanvas() {
  if (!runtimeContext) {
    return createWorkbenchError(WORKBENCH_ERROR_CODE.pluginNotActive, '插件尚未激活')
  }

  try {
    const latestMarkdown = await readWorkspaceFileIfExists(LATEST_MD_PATH)

    return {
      success: true,
      data: {
        version: 1,
        root: {
          id: 'wiki-root',
          type: 'page',
          title: '本地仓库 Wiki 工作台',
          description: '先分析仓库，再查看最新 Markdown 结果。',
          children: [
            {
              id: 'wiki-toolbar',
              type: 'toolbar',
              title: '操作',
              actions: [
                {
                  id: WORKBENCH_ACTION_ID.analyze,
                  label: '分析仓库',
                  description: '扫描本地仓库并生成 wiki/latest.md',
                  variant: 'primary',
                  payload: {
                    action: WORKBENCH_ACTION_ID.analyze,
                    repoPath: '',
                  },
                  inputs: [
                    {
                      key: 'repoPath',
                      label: '仓库路径',
                      type: 'path',
                      required: true,
                      placeholder: '请输入本地仓库绝对路径，例如 /Users/me/project',
                    },
                  ],
                },
                {
                  id: WORKBENCH_ACTION_ID.getLatest,
                  label: '读取最新结果',
                  variant: 'secondary',
                  payload: {
                    action: WORKBENCH_ACTION_ID.getLatest,
                  },
                },
              ],
            },
            {
              id: 'wiki-markdown',
              type: 'markdown',
              title: '最新 Wiki Markdown',
              sourcePath: LATEST_MD_PATH,
              content: latestMarkdown ?? '',
              emptyText: '还没有分析结果，请先执行「分析仓库」。',
            },
          ],
        },
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return createWorkbenchError(WORKBENCH_ERROR_CODE.hookFailed, message)
  }
}

/**
 * 插件工作台动作入口
 * @param {import('@proma/shared').PluginWorkbenchActionTrigger} action
 * @returns {Promise<import('@proma/shared').PluginWorkbenchResponse<import('@proma/shared').PluginWorkbenchActionResult>>}
 */
export async function invokeWorkbenchAction(action) {
  if (!runtimeContext) {
    return createWorkbenchError(WORKBENCH_ERROR_CODE.pluginNotActive, '插件尚未激活')
  }

  const actionId = action?.actionId
  if (actionId !== WORKBENCH_ACTION_ID.analyze && actionId !== WORKBENCH_ACTION_ID.getLatest) {
    return createWorkbenchError(WORKBENCH_ERROR_CODE.actionInvalid, `不支持的工作台动作: ${String(actionId)}`)
  }

  try {
    const payload = {
      ...(action?.payload ?? {}),
      action: actionId,
    }

    const result = await runCapabilityAction(payload)

    return {
      success: true,
      data: {
        type: 'toast',
        level: 'success',
        message: actionId === WORKBENCH_ACTION_ID.analyze ? '仓库分析完成，已生成最新 Markdown。' : '已读取最新分析结果。',
        data: result,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return createWorkbenchError(WORKBENCH_ERROR_CODE.hookFailed, message)
  }
}

/**
 * @param {Record<string, unknown> | undefined} payload
 * @returns {string}
 */
function normalizeRepoPath(payload) {
  const repoPath = typeof payload?.repoPath === 'string' ? payload.repoPath.trim() : ''
  if (!repoPath) {
    throw new Error('缺少 repoPath 参数')
  }

  const resolved = resolve(repoPath)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error('repoPath 不存在或不是目录')
  }

  return resolved
}

/**
 * @param {string} rootPath
 * @returns {Promise<WikiReport>}
 */
async function analyzeRepository(rootPath) {
  if (!runtimeContext) {
    throw new Error('插件尚未激活')
  }

  runtimeContext.lifecycle.throwIfAborted()

  let directories = 0
  let files = 0
  let codeFiles = 0

  /** @type {string[]} */
  const sampleCodeFiles = []

  /** @type {Array<{ name: string, type: 'dir' | 'file' }>} */
  const topLevelEntries = []

  await walkDirectory(rootPath, async (entryPath, dirent, depth) => {
    if (depth === 1) {
      topLevelEntries.push({
        name: relative(rootPath, entryPath),
        type: dirent.isDirectory() ? 'dir' : 'file',
      })
    }

    if (dirent.isDirectory()) {
      directories += 1
      return
    }

    files += 1
    const ext = extname(entryPath).toLowerCase()
    if (CODE_EXTENSIONS.has(ext)) {
      codeFiles += 1
      if (sampleCodeFiles.length < 20) {
        sampleCodeFiles.push(relative(rootPath, entryPath))
      }
    }
  })

  const keyFiles = await collectKeyFiles(rootPath)

  const report = {
    rootPath,
    generatedAt: new Date().toISOString(),
    stats: {
      directories,
      files,
      codeFiles,
    },
    topLevelEntries: topLevelEntries.slice(0, 30),
    sampleCodeFiles,
    keyFiles,
    markdown: buildMarkdown({
      rootPath,
      directories,
      files,
      codeFiles,
      topLevelEntries,
      sampleCodeFiles,
      keyFiles,
    }),
  }

  return report
}

/**
 * @param {string} rootPath
 * @param {(entryPath: string, dirent: import('node:fs').Dirent, depth: number) => Promise<void>} onEntry
 */
async function walkDirectory(rootPath, onEntry) {
  /** @type {Array<{ dir: string, depth: number }>} */
  const queue = [{ dir: rootPath, depth: 0 }]

  while (queue.length > 0) {
    if (!runtimeContext) {
      throw new Error('插件尚未激活')
    }

    runtimeContext.lifecycle.throwIfAborted()

    const current = queue.shift()
    if (!current) continue

    const entries = await readdir(current.dir, { withFileTypes: true })
    for (const dirent of entries) {
      const entryPath = resolve(current.dir, dirent.name)

      if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) {
        continue
      }

      const depth = current.depth + 1
      await onEntry(entryPath, dirent, depth)

      if (dirent.isDirectory() && depth < 8) {
        queue.push({ dir: entryPath, depth })
      }
    }
  }
}

/**
 * @param {string} rootPath
 */
async function collectKeyFiles(rootPath) {
  /** @type {Array<{ path: string, preview: string }>} */
  const keyFiles = []

  for (const fileName of KEY_FILES) {
    const filePath = resolve(rootPath, fileName)
    if (!existsSync(filePath)) {
      continue
    }

    const fileInfo = await stat(filePath)
    if (!fileInfo.isFile()) {
      continue
    }

    const content = await readFile(filePath, 'utf-8')
    const preview = content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6)
      .join('\n')

    keyFiles.push({
      path: relative(rootPath, filePath),
      preview: preview.slice(0, 1000),
    })
  }

  return keyFiles
}

/**
 * @param {{
 *   rootPath: string
 *   directories: number
 *   files: number
 *   codeFiles: number
 *   topLevelEntries: Array<{ name: string, type: 'dir' | 'file' }>
 *   sampleCodeFiles: string[]
 *   keyFiles: Array<{ path: string, preview: string }>
 * }} input
 */
function buildMarkdown(input) {
  const { rootPath, directories, files, codeFiles, topLevelEntries, sampleCodeFiles, keyFiles } = input

  const topLevelLines = topLevelEntries
    .slice(0, 20)
    .map((entry) => `- [${entry.type === 'dir' ? 'DIR' : 'FILE'}] ${entry.name}`)
    .join('\n')

  const sampleLines = sampleCodeFiles
    .slice(0, 20)
    .map((path) => `- ${path}`)
    .join('\n')

  const keyFileLines = keyFiles
    .map((item) => {
      return `### ${item.path}\n\n\`\`\`\n${item.preview}\n\`\`\``
    })
    .join('\n\n')

  return [
    '# 本地仓库 Wiki（V1）',
    '',
    `- 目标仓库：\`${rootPath}\``,
    `- 目录数量：${directories}`,
    `- 文件数量：${files}`,
    `- 代码文件数量：${codeFiles}`,
    '',
    '## 顶层结构',
    topLevelLines || '- (空)',
    '',
    '## 代码文件样本',
    sampleLines || '- (无)',
    '',
    '## 关键文件摘要',
    keyFileLines || '暂无关键文件',
  ].join('\n')
}
