import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginRuntimeContext, PluginTaskSnapshot } from '@proma/shared'

const pluginModulePromise = import('../../../../../resources/plugins/wiki-local-repository-plugin/index.mjs')

describe('wiki-local-repository-plugin workbench flow', () => {
  afterAll(async () => {
    const pluginModule = await pluginModulePromise
    await pluginModule.deactivate()
  })

  it('supports analyze -> pause -> resume -> complete and exposes document-chat block', async () => {
    const pluginModule = await pluginModulePromise
    const repoPath = await mkdtemp(join(tmpdir(), 'proma-wiki-repo-'))
    const workspacePath = await mkdtemp(join(tmpdir(), 'proma-wiki-workspace-'))
    await mkdir(repoPath, { recursive: true })

    const workspaceFiles = new Map<string, string>()

    let currentTask: PluginTaskSnapshot = {
      taskId: 'task-1',
      pluginId: 'wiki-local-repository-plugin',
      taskType: 'ai-indexing-scan',
      state: 'running',
      metadata: {
        knowledgeBaseId: 'repo-kb',
        model: 'test-model',
        language: 'zh',
        analysisDepth: 'standard',
      },
      progress: {
        stage: 'scan',
        percent: 10,
      },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const controller = new AbortController()

    const context: PluginRuntimeContext = {
      pluginId: 'wiki-local-repository-plugin',
      installPath: '/tmp/fake-install',
      workspacePath,
      lifecycle: {
        signal: controller.signal,
        onCleanup: () => {},
        throwIfAborted: () => {
          if (controller.signal.aborted) {
            throw new Error('aborted')
          }
        },
      },
      api: {
        llm: {
          invoke: async () => 'ok',
        },
        fs: {
          readText: async (path: string) => {
            const value = workspaceFiles.get(path)
            if (!value) throw new Error(`missing: ${path}`)
            return value
          },
          writeText: async (path: string, content: string) => {
            workspaceFiles.set(path, content)
          },
        },
        mcp: {
          callTool: async () => ({}),
        },
        events: {
          emit: () => {},
        },
        workbench: {
          readFile: async (path: string) => {
            const value = workspaceFiles.get(path)
            if (!value) throw new Error(`missing: ${path}`)
            return value
          },
          invokeCapability: async () => ({}),
          invokeAction: async () => ({ success: true }),
        },
        aiIndexing: {
          startScan: async () => ({ success: true, task: currentTask }),
          pauseTask: async () => {
            currentTask = {
              ...currentTask,
              state: 'paused',
              updatedAt: new Date().toISOString(),
            }
            return { success: true, task: currentTask }
          },
          resumeTask: async () => {
            currentTask = {
              ...currentTask,
              state: 'completed',
              progress: {
                stage: 'done',
                percent: 100,
              },
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            }
            workspaceFiles.set('wiki/latest.md', '# Latest wiki markdown')
            workspaceFiles.set('wiki/latest-index-summary.json', JSON.stringify({
              knowledgeBaseId: 'repo-kb',
              pages: [
                { id: 'index', title: '首页', path: 'wiki/pages/index.md' },
                { id: 'architecture', title: '架构总览', path: 'wiki/pages/architecture.md' },
              ],
            }))
            workspaceFiles.set('wiki/latest.json', JSON.stringify({
              ok: true,
              activePageId: 'index',
              pages: [
                { id: 'index', title: '首页', path: 'wiki/pages/index.md' },
                { id: 'architecture', title: '架构总览', path: 'wiki/pages/architecture.md' },
              ],
            }))
            workspaceFiles.set('wiki/pages/index.md', '# 首页\\n\\n## 总览')
            workspaceFiles.set('wiki/pages/architecture.md', '# 架构总览\\n\\n## 模块')
            return { success: true, task: currentTask }
          },
          stopTask: async () => ({ success: true, task: currentTask }),
          getTaskStatus: async () => ({ success: true, task: currentTask }),
          getLatestIndexSummary: async () => ({
            knowledgeBaseId: 'repo-kb',
            metadata: {
              indexVersion: 'plugin-ai-index-v1',
              pluginId: 'wiki-local-repository-plugin',
              knowledgeBaseId: 'repo-kb',
              repositoryPath: repoPath,
              repositoryFingerprint: 'fingerprint',
              model: 'test-model',
              language: 'zh',
              analysisDepth: 'standard',
              scanMode: 'smart',
              subagentCount: 4,
              chunkStrategy: {
                maxChunkChars: 1200,
                overlapChars: 120,
              },
              generatedAt: new Date().toISOString(),
              totalFiles: 1,
              totalChunks: 1,
              reusedChunks: 0,
              rebuiltChunks: 1,
              fileFingerprints: {},
            },
            indexPath: '/tmp/index.json',
            markdownPath: '/tmp/latest.md',
            generationMode: 'multi-page',
            pages: [
              { id: 'index', title: '首页', path: 'wiki/pages/index.md' },
              { id: 'architecture', title: '架构总览', path: 'wiki/pages/architecture.md' },
            ],
          }),
        },
        documentChat: {
          send: async () => ({
            success: true,
            pluginId: 'wiki-local-repository-plugin',
            knowledgeBaseId: 'repo-kb',
            sessionId: 'session-1',
          }),
          endSession: async () => ({ success: true }),
          getHistory: async () => ({
            pluginId: 'wiki-local-repository-plugin',
            knowledgeBaseId: 'repo-kb',
            sessionId: 'session-1',
            messages: [],
          }),
        },
        channels: {
          getAvailableModels: async () => [
            { id: 'test-model-1', name: 'Test Model 1', channelName: 'Test Channel 1' },
            { id: 'test-model-2', name: 'Test Model 2', channelName: 'Test Channel 2' },
          ],
        },
      },
    }

    await pluginModule.activate(context)

    const analyze = await pluginModule.invokeWorkbenchAction({
      actionId: 'analyze',
      payload: {
        repoPath,
        model: 'test-model',
        language: 'en',
        analysisDepth: 'standard',
        scanMode: 'smart',
        subagentCount: 4,
      },
    })
    expect(analyze.success).toBe(true)

    const pause = await pluginModule.invokeWorkbenchAction({
      actionId: 'pause-task',
      payload: {},
    })
    expect(pause.success).toBe(true)

    const resume = await pluginModule.invokeWorkbenchAction({
      actionId: 'resume-task',
      payload: {},
    })
    expect(resume.success).toBe(true)

    const latest = await pluginModule.invokeWorkbenchAction({
      actionId: 'get-latest',
      payload: {},
    })
    expect(latest.success).toBe(true)

    const canvasResult = await pluginModule.getWorkbenchCanvas()
    expect(canvasResult.success).toBe(true)
    if (!canvasResult.success || !canvasResult.data || canvasResult.data.root.type !== 'page') {
      throw new Error('画布结构不合法')
    }

    const root = canvasResult.data.root
    const controlsPanel = root.children.find(
      (item: (typeof root.children)[number]) => item.type === 'panel' && item.id === 'wiki-controls-panel',
    )
    expect(controlsPanel).toBeDefined()
    if (controlsPanel && controlsPanel.type === 'panel') {
      expect(controlsPanel.children.some((item: (typeof controlsPanel.children)[number]) => item.type === 'task-status')).toBe(true)
      expect(controlsPanel.children.some((item: (typeof controlsPanel.children)[number]) => item.type === 'document-chat')).toBe(true)
    }

    const mainPanel = root.children.find(
      (item: (typeof root.children)[number]) => item.type === 'panel' && item.id === 'wiki-main-panel',
    )
    expect(mainPanel).toBeDefined()
    if (mainPanel && mainPanel.type === 'panel') {
      const markdownNode = mainPanel.children.find((item) => item.type === 'markdown')
      expect(markdownNode).toBeDefined()
      if (markdownNode && markdownNode.type === 'markdown') {
        expect((markdownNode.pages ?? []).length).toBeGreaterThan(0)
        expect(markdownNode.tocScope).toBe('global')
      }
    }
  })
})
