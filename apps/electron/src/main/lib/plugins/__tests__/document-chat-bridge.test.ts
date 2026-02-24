import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAiIndexingTask } from '../ai-indexing-service'
import { PluginDocumentChatBridge } from '../document-chat-bridge'
import { pluginTaskRuntime } from '../task-runtime'

mock.module('@proma/core', () => {
  return {
    getAdapter: () => ({
      buildStreamRequest: (input: { userMessage?: string }) => ({
        userMessage: input.userMessage ?? '',
      }),
      providerType: 'openai',
    }),
    streamSSE: async (args: { request: { userMessage?: string }; onEvent: (event: { type: string; delta?: string }) => void }) => {
      const prompt = args.request.userMessage ?? ''
      if (prompt.includes('输出 JSON schema') || prompt.includes('output JSON schema')) {
        args.onEvent({
          type: 'chunk',
          delta: JSON.stringify({
            core: ['README.md', 'src/feature.ts'],
            supporting: [],
            peripheral: [],
            modules: [{ name: 'feature-module', files: ['src/feature.ts'] }],
          }),
        })
      } else if (prompt.includes('"summary": string')) {
        args.onEvent({
          type: 'chunk',
          delta: JSON.stringify({
            summary: 'feature 模块提供核心能力。',
            keyFlows: ['输入 -> feature 处理 -> 输出'],
            risks: [],
            evidence: ['src/feature.ts'],
          }),
        })
      } else if (prompt.includes('主文档 Agent') && prompt.includes('"pages"')) {
        args.onEvent({
          type: 'chunk',
          delta: JSON.stringify({
            pages: [
              { id: 'index', content: '# 仓库 Wiki\n\n## 覆盖范围\n- core: 2' },
              { id: 'architecture', content: '# 架构总览\n\n## 核心模块\n- feature-module' },
              { id: 'runtime', content: '# 运行链路\n\n## 关键执行流\n- 输入 -> 输出' },
              { id: 'modules', content: '# 模块明细\n\n- feature-module' },
              { id: 'data-risks', content: '# 数据与风险\n\n- 风险较低' },
            ],
          }),
        })
      } else {
        args.onEvent({ type: 'chunk', delta: 'ok' })
      }
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

describe('PluginDocumentChatBridge', () => {
  beforeAll(async () => {
    process.env.PROMA_PLUGIN_MODEL_VALIDATION_BYPASS = '1'

    workspaceRoot = await mkdtemp(join(tmpdir(), 'proma-plugin-chat-workspace-'))
    repositoryRoot = await mkdtemp(join(tmpdir(), 'proma-plugin-chat-repo-'))

    await mkdir(join(repositoryRoot, 'src'), { recursive: true })
    await writeFile(
      join(repositoryRoot, 'README.md'),
      '# Chat Repo\n\nThis repository is used for chat bridge integration tests.\n',
      'utf-8',
    )
    await writeFile(
      join(repositoryRoot, 'src', 'feature.ts'),
      'export const feature = "chat"\n'.repeat(80),
      'utf-8',
    )

    const scan = await startAiIndexingTask({
      pluginId: 'plugin-chat-test',
      workspacePath: workspaceRoot,
      payload: {
        repositoryPath: repositoryRoot,
        knowledgeBaseId: 'kb-chat',
        model: 'test-model',
        language: 'zh',
        analysisDepth: 'standard',
      },
    })

    await waitForTaskCompletion(scan.task!.taskId)
  })

  it('isolates sessions and emits complete event sequence', async () => {
    const bridge = new PluginDocumentChatBridge()
    const events: string[] = []

    const dispose = bridge.onEvent((event) => {
      events.push(`${event.sessionId}:${event.type}`)
    })

    const first = await bridge.sendMessage({
      pluginId: 'plugin-chat-test',
      workspacePath: workspaceRoot,
      payload: {
        knowledgeBaseId: 'kb-chat',
        sessionId: 'session-a',
        model: 'test-model',
        messages: [{ role: 'user', content: '请总结仓库中和 feature 相关的内容。' }],
      },
    })

    const second = await bridge.sendMessage({
      pluginId: 'plugin-chat-test',
      workspacePath: workspaceRoot,
      payload: {
        knowledgeBaseId: 'kb-chat',
        sessionId: 'session-b',
        model: 'test-model',
        messages: [{ role: 'user', content: '请告诉我这个仓库的用途。' }],
      },
    })

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)

    const historyA = bridge.getHistory({
      pluginId: 'plugin-chat-test',
      knowledgeBaseId: 'kb-chat',
      sessionId: 'session-a',
    })

    const historyB = bridge.getHistory({
      pluginId: 'plugin-chat-test',
      knowledgeBaseId: 'kb-chat',
      sessionId: 'session-b',
    })

    expect(historyA.messages.some((msg) => msg.role === 'assistant')).toBe(true)
    expect(historyB.messages.some((msg) => msg.role === 'assistant')).toBe(true)
    expect(historyA.messages).not.toEqual(historyB.messages)

    expect(events.some((item) => item === 'session-a:delta')).toBe(true)
    expect(events.some((item) => item === 'session-a:done')).toBe(true)
    expect(events.some((item) => item === 'session-b:delta')).toBe(true)
    expect(events.some((item) => item === 'session-b:done')).toBe(true)

    const endResult = bridge.endSession({
      pluginId: 'plugin-chat-test',
      knowledgeBaseId: 'kb-chat',
      sessionId: 'session-a',
    })
    expect(endResult.success).toBe(true)

    dispose()
  })

  it('returns diagnostic error when knowledge base is unavailable', async () => {
    const bridge = new PluginDocumentChatBridge()

    const result = await bridge.sendMessage({
      pluginId: 'plugin-chat-test',
      workspacePath: workspaceRoot,
      payload: {
        knowledgeBaseId: 'missing-kb',
        sessionId: 'missing-session',
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('知识库不可用')
  })
})
