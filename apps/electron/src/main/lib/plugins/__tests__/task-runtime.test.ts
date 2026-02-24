import { describe, expect, it, mock } from 'bun:test'
import type { PluginTaskSnapshot } from '@proma/shared'
import { PluginTaskRuntime } from '../task-runtime'

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

async function waitForTaskState(
  runtime: PluginTaskRuntime,
  taskId: string,
  states: PluginTaskSnapshot['state'] | PluginTaskSnapshot['state'][],
  timeoutMs = 3000,
): Promise<PluginTaskSnapshot> {
  const accepted = new Set(Array.isArray(states) ? states : [states])
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const task = runtime.getTask(taskId)
    if (task && accepted.has(task.state)) {
      return task
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(`等待任务状态超时: ${taskId}`)
}

describe('PluginTaskRuntime', () => {
  it('pushes ordered lifecycle events', async () => {
    const runtime = new PluginTaskRuntime()
    const eventTypes: string[] = []

    runtime.onEvent((event) => {
      eventTypes.push(event.type)
    })

    const start = runtime.startTask(
      {
        pluginId: 'plugin-a',
        taskType: 'scan',
      },
      async (context) => {
        context.reportProgress({
          stage: 'scan',
          percent: 10,
          detail: 'collect files',
        })
        await context.checkpoint()

        context.reportProgress({
          stage: 'embed',
          percent: 70,
          detail: 'build vectors',
        })
        await context.checkpoint()

        return {
          ok: true,
        }
      },
    )

    expect(start.success).toBe(true)
    expect(start.task).toBeDefined()

    const completedTask = await waitForTaskState(runtime, start.task!.taskId, 'completed')
    expect(completedTask.result?.ok).toBe(true)
    expect(eventTypes[0]).toBe('started')
    expect(eventTypes).toContain('progress')
    expect(eventTypes[eventTypes.length - 1]).toBe('completed')
  })

  it('handles pause/resume/stop with idempotency and rejects illegal transitions', async () => {
    const runtime = new PluginTaskRuntime()

    const start = runtime.startTask(
      {
        pluginId: 'plugin-b',
        taskType: 'scan',
      },
      async (context) => {
        while (true) {
          await context.checkpoint()
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      },
    )

    const taskId = start.task!.taskId

    const paused = runtime.pauseTask('plugin-b', taskId)
    expect(paused.success).toBe(true)
    expect(paused.task?.state).toBe('paused')

    const pausedAgain = runtime.pauseTask('plugin-b', taskId)
    expect(pausedAgain.success).toBe(true)
    expect(pausedAgain.task?.state).toBe('paused')

    const resumed = runtime.resumeTask('plugin-b', taskId)
    expect(resumed.success).toBe(true)
    expect(resumed.task?.state).toBe('running')

    const stopped = runtime.stopTask('plugin-b', taskId)
    expect(stopped.success).toBe(true)
    expect(stopped.task?.state).toBe('stopped')

    const stoppedAgain = runtime.stopTask('plugin-b', taskId)
    expect(stoppedAgain.success).toBe(true)
    expect(stoppedAgain.task?.state).toBe('stopped')

    const resumedAfterStop = runtime.resumeTask('plugin-b', taskId)
    expect(resumedAfterStop.success).toBe(false)

    await waitForTaskState(runtime, taskId, 'stopped')
  })
})
