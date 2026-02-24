import { randomUUID } from 'node:crypto'
import type {
  PluginTaskEvent,
  PluginTaskEventType,
  PluginTaskOperationResult,
  PluginTaskProgress,
  PluginTaskSnapshot,
  PluginTaskState,
} from '@proma/shared'

interface TaskExecutionContext {
  taskId: string
  signal: AbortSignal
  checkpoint: () => Promise<void>
  throwIfStopped: () => void
  reportProgress: (progress: PluginTaskProgress) => void
}

interface TaskRecord {
  snapshot: PluginTaskSnapshot
  controller: AbortController
  resumeWaiters: Set<() => void>
}

export interface StartPluginTaskInput {
  pluginId: string
  taskType: string
  metadata?: Record<string, unknown>
}

export type PluginTaskExecutor = (context: TaskExecutionContext) => Promise<Record<string, unknown> | void>

type TaskEventListener = (event: PluginTaskEvent) => void

function nowIso(): string {
  return new Date().toISOString()
}

function cloneSnapshot(task: PluginTaskSnapshot): PluginTaskSnapshot {
  return {
    ...task,
    progress: task.progress ? { ...task.progress } : undefined,
    metadata: task.metadata ? { ...task.metadata } : undefined,
    result: task.result ? { ...task.result } : undefined,
  }
}

function isTerminalState(state: PluginTaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'stopped'
}

export class PluginTaskRuntime {
  private readonly taskMap = new Map<string, TaskRecord>()
  private readonly listeners = new Set<TaskEventListener>()

  onEvent(listener: TaskEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  startTask(input: StartPluginTaskInput, executor: PluginTaskExecutor): PluginTaskOperationResult {
    const taskId = randomUUID()
    const timestamp = nowIso()

    const snapshot: PluginTaskSnapshot = {
      taskId,
      pluginId: input.pluginId,
      taskType: input.taskType,
      state: 'running',
      metadata: input.metadata,
      startedAt: timestamp,
      updatedAt: timestamp,
    }

    const record: TaskRecord = {
      snapshot,
      controller: new AbortController(),
      resumeWaiters: new Set(),
    }

    this.taskMap.set(taskId, record)
    this.emit('started', record)

    void this.runTask(record, executor)

    return {
      success: true,
      task: cloneSnapshot(record.snapshot),
    }
  }

  getTask(taskId: string): PluginTaskSnapshot | null {
    const record = this.taskMap.get(taskId)
    return record ? cloneSnapshot(record.snapshot) : null
  }

  getTaskForPlugin(pluginId: string, taskId: string): PluginTaskSnapshot | null {
    const record = this.taskMap.get(taskId)
    if (!record || record.snapshot.pluginId !== pluginId) {
      return null
    }

    return cloneSnapshot(record.snapshot)
  }

  getLatestTaskForPlugin(pluginId: string, taskType?: string): PluginTaskSnapshot | null {
    const tasks = this.listTasksForPlugin(pluginId, taskType)
    if (tasks.length === 0) {
      return null
    }

    return tasks.reduce((latest, current) => {
      return current.updatedAt > latest.updatedAt ? current : latest
    })
  }

  listTasksForPlugin(pluginId: string, taskType?: string): PluginTaskSnapshot[] {
    const snapshots: PluginTaskSnapshot[] = []

    for (const record of this.taskMap.values()) {
      if (record.snapshot.pluginId !== pluginId) {
        continue
      }

      if (taskType && record.snapshot.taskType !== taskType) {
        continue
      }

      snapshots.push(cloneSnapshot(record.snapshot))
    }

    return snapshots.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  }

  pauseTask(pluginId: string, taskId: string): PluginTaskOperationResult {
    const record = this.taskMap.get(taskId)
    if (!record || record.snapshot.pluginId !== pluginId) {
      return {
        success: false,
        error: `任务不存在: ${taskId}`,
      }
    }

    const state = record.snapshot.state
    if (state === 'paused') {
      return {
        success: true,
        task: cloneSnapshot(record.snapshot),
      }
    }

    if (state !== 'running') {
      return {
        success: false,
        task: cloneSnapshot(record.snapshot),
        error: `当前状态不允许 pause: ${state}`,
      }
    }

    this.updateState(record, 'paused')
    this.emit('paused', record)

    return {
      success: true,
      task: cloneSnapshot(record.snapshot),
    }
  }

  resumeTask(pluginId: string, taskId: string): PluginTaskOperationResult {
    const record = this.taskMap.get(taskId)
    if (!record || record.snapshot.pluginId !== pluginId) {
      return {
        success: false,
        error: `任务不存在: ${taskId}`,
      }
    }

    const state = record.snapshot.state
    if (state === 'running') {
      return {
        success: true,
        task: cloneSnapshot(record.snapshot),
      }
    }

    if (state !== 'paused') {
      return {
        success: false,
        task: cloneSnapshot(record.snapshot),
        error: `当前状态不允许 resume: ${state}`,
      }
    }

    this.updateState(record, 'running')
    this.emit('resumed', record)

    for (const resolve of record.resumeWaiters) {
      resolve()
    }
    record.resumeWaiters.clear()

    return {
      success: true,
      task: cloneSnapshot(record.snapshot),
    }
  }

  stopTask(pluginId: string, taskId: string): PluginTaskOperationResult {
    const record = this.taskMap.get(taskId)
    if (!record || record.snapshot.pluginId !== pluginId) {
      return {
        success: false,
        error: `任务不存在: ${taskId}`,
      }
    }

    if (record.snapshot.state === 'stopped') {
      return {
        success: true,
        task: cloneSnapshot(record.snapshot),
      }
    }

    if (isTerminalState(record.snapshot.state)) {
      return {
        success: false,
        task: cloneSnapshot(record.snapshot),
        error: `当前状态不允许 stop: ${record.snapshot.state}`,
      }
    }

    record.controller.abort('stopped')
    this.updateState(record, 'stopped')
    record.snapshot.completedAt = nowIso()
    this.emit('stopped', record)

    for (const resolve of record.resumeWaiters) {
      resolve()
    }
    record.resumeWaiters.clear()

    return {
      success: true,
      task: cloneSnapshot(record.snapshot),
    }
  }

  stopTasksForPlugin(pluginId: string): void {
    const tasks = this.listTasksForPlugin(pluginId)
    for (const task of tasks) {
      if (task.state === 'running' || task.state === 'paused') {
        this.stopTask(pluginId, task.taskId)
      }
    }
  }

  private async runTask(record: TaskRecord, executor: PluginTaskExecutor): Promise<void> {
    const context: TaskExecutionContext = {
      taskId: record.snapshot.taskId,
      signal: record.controller.signal,
      checkpoint: async (): Promise<void> => {
        this.throwIfStopped(record)

        if (record.snapshot.state !== 'paused') {
          return
        }

        await new Promise<void>((resolve) => {
          record.resumeWaiters.add(resolve)
        })

        this.throwIfStopped(record)
      },
      throwIfStopped: (): void => {
        this.throwIfStopped(record)
      },
      reportProgress: (progress: PluginTaskProgress): void => {
        if (isTerminalState(record.snapshot.state)) {
          return
        }

        record.snapshot.progress = {
          ...progress,
          percent: Math.max(0, Math.min(100, progress.percent)),
        }
        record.snapshot.updatedAt = nowIso()
        this.emit('progress', record)
      },
    }

    try {
      const result = await executor(context)
      if (record.snapshot.state === 'stopped') {
        return
      }

      record.snapshot.result = result ?? {}
      this.updateState(record, 'completed')
      record.snapshot.completedAt = nowIso()
      this.emit('completed', record)
    } catch (error) {
      if (record.snapshot.state === 'stopped') {
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      record.snapshot.error = message
      this.updateState(record, 'failed')
      record.snapshot.completedAt = nowIso()
      this.emit('failed', record)
    }
  }

  private throwIfStopped(record: TaskRecord): void {
    if (record.controller.signal.aborted || record.snapshot.state === 'stopped') {
      throw new Error('任务已停止')
    }
  }

  private updateState(record: TaskRecord, state: PluginTaskState): void {
    record.snapshot.state = state
    record.snapshot.updatedAt = nowIso()
  }

  private emit(type: PluginTaskEventType, record: TaskRecord): void {
    const event: PluginTaskEvent = {
      type,
      task: cloneSnapshot(record.snapshot),
      timestamp: nowIso(),
    }

    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 保持任务主流程稳定，不让监听器异常反向影响执行。
      }
    }
  }
}

export const pluginTaskRuntime = new PluginTaskRuntime()
