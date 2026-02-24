# DeepWiki Plugin Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 DeepWiki 本地仓库插件从 demo 级升级为可稳定生产使用的“深度分析 + 双语输出 + 主阅读区优先”的工作台体验。

**Architecture:** 在不新增 workbench 节点类型的前提下，沿用既有 `page/panel/split/toolbar/markdown/task-status/document-chat` 协议；主链路为 `index.mjs` 参数归一化 -> `runtime.ts` 透传 -> `ai-indexing-service.ts` 深度洞察与 markdown 生成 -> `PluginWorkbenchRenderer.tsx` 交互与布局呈现。模型解析继续集中在 `model-resolution.ts`，索引与聊天都复用该入口。

**Tech Stack:** Bun test、TypeScript、Electron 主进程服务、React + Shadcn UI + Tailwind、Proma 插件工作台协议。

---

### Task 1: 深度分析提示词与 Mermaid 输出回归（RED -> GREEN）

**Files:**
- Modify: `apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts`
- Modify: `apps/electron/src/main/lib/plugins/ai-indexing-service.ts`
- Test: `apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts`

**Step 1: Write the failing test**

```ts
it('generates deep zh report with mermaid blocks', async () => {
  const run = await startAiIndexingTask({
    pluginId,
    workspacePath: workspaceRoot,
    payload: {
      repositoryPath: repositoryRoot,
      knowledgeBaseId: 'kb-deep-zh',
      model: 'test-model',
      language: 'zh',
      analysisDepth: 'deep',
    },
  })

  await waitForTaskCompletion(run.task!.taskId)
  const latest = await Bun.file(join(workspaceRoot, 'wiki/latest.md')).text()

  expect(latest).toContain('架构')
  expect(latest).toContain('模块关系')
  expect(latest).toContain('关键能力')
  expect(latest).toContain('```mermaid')
})
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts -t "deep zh report"`
Expected: FAIL，缺少 Mermaid 或深度章节断言失败。

**Step 3: Write minimal implementation**

```ts
const requireMermaid = analysisDepth === 'deep'
const mermaidInstruction = requireMermaid
  ? '请至少输出 1 个 mermaid 图（模块依赖或架构图）'
  : ''

// 在提示词中拼接 mermaidInstruction 与深度章节硬性约束
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts -t "deep zh report"`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts apps/electron/src/main/lib/plugins/ai-indexing-service.ts
git commit -m "feat: enforce deep zh insight sections with mermaid output"
```

---

### Task 2: 英文 standard 模式输出收敛（RED -> GREEN）

**Files:**
- Modify: `apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts`
- Modify: `apps/electron/src/main/lib/plugins/ai-indexing-service.ts`
- Test: `apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts`

**Step 1: Write the failing test**

```ts
it('generates concise english report in standard mode', async () => {
  const run = await startAiIndexingTask({
    pluginId,
    workspacePath: workspaceRoot,
    payload: {
      repositoryPath: repositoryRoot,
      knowledgeBaseId: 'kb-standard-en',
      model: 'test-model',
      language: 'en',
      analysisDepth: 'standard',
    },
  })

  await waitForTaskCompletion(run.task!.taskId)
  const latest = await Bun.file(join(workspaceRoot, 'wiki/latest.md')).text()

  expect(latest).toContain('Indexing Statistics')
  expect(latest).toContain('AI Repository Insight')
  expect(latest).not.toContain('架构')
})
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts -t "standard mode"`
Expected: FAIL，英文章节或中文混入断言失败。

**Step 3: Write minimal implementation**

```ts
const labels = isEn
  ? { repositoryPath: 'Repository Path', model: 'Model', ... }
  : { repositoryPath: '仓库路径', model: '扫描模型', ... }

// renderLatestMarkdown 统一按 labels 输出，避免英文化场景仍出现中文标签
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts -t "standard mode"`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts apps/electron/src/main/lib/plugins/ai-indexing-service.ts
git commit -m "feat: normalize english standard wiki output labels"
```

---

### Task 3: 模型解析稳健性与复用链路回归（RED -> GREEN）

**Files:**
- Create: `apps/electron/src/main/lib/plugins/__tests__/model-resolution.test.ts`
- Modify: `apps/electron/src/main/lib/plugins/model-resolution.ts`
- Modify: `apps/electron/src/main/lib/plugins/ai-indexing-service.ts`
- Modify: `apps/electron/src/main/lib/plugins/document-chat-bridge.ts`
- Test: `apps/electron/src/main/lib/plugins/__tests__/model-resolution.test.ts`

**Step 1: Write the failing test**

```ts
it('parses scoped model id with channel prefix', () => {
  const resolved = resolveChannelAndModel('channel-a:model-x')
  expect(resolved.channelId).toBe('channel-a')
  expect(resolved.modelId).toBe('model-x')
})

it('throws clear error for malformed scoped model', () => {
  expect(() => resolveChannelAndModel('channel-only:')).toThrow('模型标识不合法')
})
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/main/lib/plugins/__tests__/model-resolution.test.ts`
Expected: FAIL（当前异常信息或解析细节不满足断言）。

**Step 3: Write minimal implementation**

```ts
function parseScopedModel(model: string): { channelId: string; modelId: string } {
  const idx = model.indexOf(':')
  if (idx <= 0 || idx === model.length - 1) {
    throw new Error(`模型标识不合法: ${model}`)
  }
  return {
    channelId: model.slice(0, idx),
    modelId: model.slice(idx + 1),
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/electron/src/main/lib/plugins/__tests__/model-resolution.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/plugins/__tests__/model-resolution.test.ts apps/electron/src/main/lib/plugins/model-resolution.ts apps/electron/src/main/lib/plugins/ai-indexing-service.ts apps/electron/src/main/lib/plugins/document-chat-bridge.ts
git commit -m "refactor: harden scoped model resolution across plugin services"
```

---

### Task 4: 工具栏高级参数折叠（language/depth）交互重构（RED -> GREEN）

**Files:**
- Modify: `apps/electron/resources/plugins/wiki-local-repository-plugin/index.mjs`
- Modify: `apps/electron/src/renderer/components/plugin-workbench/PluginWorkbenchRenderer.tsx`
- Test: `apps/electron/src/main/lib/plugins/__tests__/wiki-workbench-flow.test.ts`

**Step 1: Write the failing test**

```ts
expect(toolbarAction.inputs?.some((i) => i.key === 'language')).toBe(true)
expect(toolbarAction.inputs?.some((i) => i.key === 'analysisDepth')).toBe(true)
// 断言默认值存在，作为折叠前提
expect(toolbarAction.inputs?.find((i) => i.key === 'language')?.defaultValue).toBe('zh')
expect(toolbarAction.inputs?.find((i) => i.key === 'analysisDepth')?.defaultValue).toBe('deep')
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/main/lib/plugins/__tests__/wiki-workbench-flow.test.ts`
Expected: FAIL（若 defaultValue、输入定义或结构不稳定）。

**Step 3: Write minimal implementation**

```tsx
const advancedKeys = new Set(['language', 'analysisDepth'])
const coreInputs = action.inputs?.filter((i) => !advancedKeys.has(i.key)) ?? []
const advancedInputs = action.inputs?.filter((i) => advancedKeys.has(i.key)) ?? []

// coreInputs 默认渲染，advancedInputs 放入 CollapsibleContent
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/electron/src/main/lib/plugins/__tests__/wiki-workbench-flow.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/electron/resources/plugins/wiki-local-repository-plugin/index.mjs apps/electron/src/renderer/components/plugin-workbench/PluginWorkbenchRenderer.tsx apps/electron/src/main/lib/plugins/__tests__/wiki-workbench-flow.test.ts
git commit -m "feat: add collapsible advanced controls in wiki workbench toolbar"
```

---

### Task 5: 文档聊天链路回归（引用、done/error、会话隔离）

**Files:**
- Modify: `apps/electron/src/main/lib/plugins/__tests__/document-chat-bridge.test.ts`
- Modify: `apps/electron/src/main/lib/plugins/document-chat-bridge.ts` (仅在测试失败时)
- Test: `apps/electron/src/main/lib/plugins/__tests__/document-chat-bridge.test.ts`

**Step 1: Write the failing test**

```ts
expect(events.some((item) => item === 'session-a:citation')).toBe(true)
expect(events.some((item) => item === 'session-b:citation')).toBe(true)
expect(historyA.messages.at(-1)?.role).toBe('assistant')
expect(historyB.messages.at(-1)?.role).toBe('assistant')
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/main/lib/plugins/__tests__/document-chat-bridge.test.ts`
Expected: FAIL（若引用事件或末尾消息状态不稳定）。

**Step 3: Write minimal implementation**

```ts
if (references.length > 0) {
  this.emit({ type: 'citation', ... })
}
// 确保 done 前 assistantMessage 已落入 session.messages
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/electron/src/main/lib/plugins/__tests__/document-chat-bridge.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/plugins/__tests__/document-chat-bridge.test.ts apps/electron/src/main/lib/plugins/document-chat-bridge.ts
git commit -m "test: stabilize document chat event and session assertions"
```

---

### Task 6: 全链路验证（类型检查 + 插件测试集）

**Files:**
- Modify: `apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts` (仅当总测修正需要)
- Modify: `apps/electron/src/main/lib/plugins/__tests__/wiki-workbench-flow.test.ts` (仅当总测修正需要)
- Modify: `apps/electron/src/main/lib/plugins/__tests__/document-chat-bridge.test.ts` (仅当总测修正需要)

**Step 1: Write/adjust failing assertions from integration run**

```ts
// 仅补充最小必要断言，禁止改业务代码掩盖问题
expect(metadata.language).toBeDefined()
expect(metadata.analysisDepth).toBeDefined()
```

**Step 2: Run test suite to verify current failures**

Run: `bun test apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts apps/electron/src/main/lib/plugins/__tests__/document-chat-bridge.test.ts apps/electron/src/main/lib/plugins/__tests__/task-runtime.test.ts apps/electron/src/main/lib/plugins/__tests__/wiki-workbench-flow.test.ts`
Expected: 全部 PASS；若 FAIL，仅定位并最小修复。

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Final sanity rerun**

Run: `bun test apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/plugins/__tests__/ai-indexing-service.test.ts apps/electron/src/main/lib/plugins/__tests__/document-chat-bridge.test.ts apps/electron/src/main/lib/plugins/__tests__/wiki-workbench-flow.test.ts apps/electron/src/main/lib/plugins/ai-indexing-service.ts apps/electron/src/main/lib/plugins/model-resolution.ts apps/electron/src/renderer/components/plugin-workbench/PluginWorkbenchRenderer.tsx apps/electron/resources/plugins/wiki-local-repository-plugin/index.mjs
git commit -m "feat: complete deepwiki plugin ux and deep analysis refactor"
```

---

## 执行说明（本会话）

- 默认采用 **Subagent-Driven (this session)** 路径执行：按任务顺序逐个落地，每完成一个任务立即跑对应测试。
- 遵循 YAGNI：仅实现本计划中与“深度分析、双语、UX 主阅读区、聊天回归”直接相关内容。
- 按用户偏好：本会话只执行测试与 typecheck，不自动执行 commit/push。
