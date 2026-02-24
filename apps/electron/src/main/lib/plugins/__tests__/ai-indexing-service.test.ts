import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const capturedSummaryPrompts: string[] = []

mock.module('@proma/core', () => {
  return {
    getAdapter: () => ({
      providerType: 'openai',
      buildStreamRequest: (input: { userMessage: string }) => ({
        userMessage: input.userMessage,
      }),
    }),
    streamSSE: async (args: {
      request: { userMessage?: string }
      onEvent: (event: { type: string; delta?: string }) => void
    }) => {
      const prompt = args.request.userMessage ?? ''
      capturedSummaryPrompts.push(prompt)

      const delta = prompt.includes('English')
        ? '## Repository Insight\n\n```mermaid\ngraph TD\nRepo-->Module\n```'
        : '## 仓库洞察\n\n```mermaid\ngraph TD\n仓库-->模块\n```'

      args.onEvent({ type: 'chunk', delta })
      args.onEvent({ type: 'done' })
    },
  }
})

mock.module('electron', () => {
  return {
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (str: string) => Buffer.from(str),
      decryptString: (buf: Buffer) => buf.toString(),
    },
    app: {
      getPath: () => '/tmp',
    },
  }
})

const { loadKnowledgeBaseIndex, startAiIndexingTask } = await import('../ai-indexing-service')
const { pluginTaskRuntime } = await import('../task-runtime')

let workspaceRoot = ''
let repositoryRoot = ''

async function waitForTaskCompletion(taskId: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const task = pluginTaskRuntime.getTask(taskId)
    if (task?.state === 'completed') {
      return
    }
    if (task?.state === 'failed' || task?.state === 'stopped') {
      throw new Error(`任务未完成: ${task.state} ${task.error ?? ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(`等待任务超时: ${taskId}`)
}

describe('ai-indexing-service', () => {
  beforeAll(async () => {
    process.env.PROMA_PLUGIN_MODEL_VALIDATION_BYPASS = '1'

    workspaceRoot = await mkdtemp(join(tmpdir(), 'proma-plugin-workspace-'))
    repositoryRoot = await mkdtemp(join(tmpdir(), 'proma-plugin-repo-'))

    await mkdir(join(repositoryRoot, 'src'), { recursive: true })
    await writeFile(
      join(repositoryRoot, 'README.md'),
      '# Demo Repo\n\nThis repository is used for AI indexing integration tests.\n',
      'utf-8',
    )
    await writeFile(
      join(repositoryRoot, 'src', 'index.ts'),
      'export const hello = () => "hello"\n'.repeat(80),
      'utf-8',
    )
    await writeFile(
      join(repositoryRoot, 'src', 'worker.ts'),
      'export function sum(a:number,b:number){ return a + b }\n'.repeat(60),
      'utf-8',
    )
  })

  afterAll(() => {
    delete process.env.PROMA_PLUGIN_MODEL_VALIDATION_BYPASS
  })

  it('builds index and supports incremental reuse', async () => {
    const pluginId = 'plugin-ai-index-test'

    const firstRun = await startAiIndexingTask({
      pluginId,
      workspacePath: workspaceRoot,
      payload: {
        repositoryPath: repositoryRoot,
        knowledgeBaseId: 'kb-incremental',
        model: 'test-model',
        language: 'zh',
        analysisDepth: 'standard',
      },
    })

    expect(firstRun.success).toBe(true)
    expect(firstRun.task).toBeDefined()

    await waitForTaskCompletion(firstRun.task!.taskId)

    const firstIndex = await loadKnowledgeBaseIndex(pluginId, workspaceRoot, 'kb-incremental', 'test-model')
    expect(firstIndex.metadata.totalFiles).toBeGreaterThan(0)
    expect(firstIndex.metadata.totalChunks).toBeGreaterThan(0)
    expect(firstIndex.metadata.reusedChunks).toBe(0)

    await writeFile(
      join(repositoryRoot, 'src', 'worker.ts'),
      'export function sum(a:number,b:number){ return a + b + 1 }\n'.repeat(60),
      'utf-8',
    )

    const secondRun = await startAiIndexingTask({
      pluginId,
      workspacePath: workspaceRoot,
      payload: {
        repositoryPath: repositoryRoot,
        knowledgeBaseId: 'kb-incremental',
        model: 'test-model',
        language: 'zh',
        analysisDepth: 'standard',
      },
    })

    expect(secondRun.success).toBe(true)
    expect(secondRun.task).toBeDefined()

    await waitForTaskCompletion(secondRun.task!.taskId)

    const secondIndex = await loadKnowledgeBaseIndex(pluginId, workspaceRoot, 'kb-incremental', 'test-model')
    expect(secondIndex.metadata.reusedChunks).toBeGreaterThan(0)
    expect(secondIndex.metadata.rebuiltChunks).toBeGreaterThan(0)

    // 验证 metadata 中包含新增的 language / analysisDepth
    expect(secondIndex.metadata.language).toBe('zh')
    expect(secondIndex.metadata.analysisDepth).toBe('standard')
  })

  it('fails compatibility check on model mismatch', () => {
    const pluginId = 'plugin-ai-index-test'

    return expect(
      loadKnowledgeBaseIndex(pluginId, workspaceRoot, 'kb-incremental', 'another-model'),
    ).rejects.toThrow('索引模型不匹配')
  })
})
