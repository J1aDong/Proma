# Wiki 插件使用说明（`wiki-local-repository-plugin`）

本文档介绍内置 Wiki 插件的用途、操作步骤、输出结果和常见问题。

## 1. 插件定位

- 插件 ID：`wiki-local-repository-plugin`
- capability：`wiki:local-repository`
- 版本：`0.2.0`
- 权限：
  - `filesystem:read`
  - `filesystem:write`
  - `llm:invoke`

入口文件：

- `apps/electron/resources/plugins/wiki-local-repository-plugin/index.mjs`

manifest：

- `apps/electron/resources/plugins/wiki-local-repository-plugin/manifest.json`

## 2. 提供的能力

`invokeCapability("wiki:local-repository", payload)` 支持动作：

- `ping`：连通性测试。
- `analyze`：启动宿主 AI 扫描索引任务（可配置模型）。
- `pause-task`：暂停当前扫描任务。
- `resume-task`：继续当前扫描任务。
- `stop-task`：停止当前扫描任务。
- `get-latest`：读取最近一次 Markdown 与索引摘要。

## 3. 快速使用（UI）

1. 启动应用：

```bash
bun run --cwd "/Users/mr.j/myRoom/code/ai/MyProjects/Proma" dev
```

2. 进入设置页 -> 插件管理。
3. 启用 `wiki-local-repository-plugin`。
4. 在 Plugin 工作台选择 Wiki 插件。
5. 在工具栏输入仓库路径、选择模型并点击“开始分析”。
6. 在任务状态区执行暂停/继续/停止控制。
7. 扫描完成后，在“继续聊天（基于文档库）”输入问题并发送。

## 4. 输入与输出

### 4.1 analyze 输入

```json
{
  "action": "analyze",
  "repoPath": "/absolute/path/to/local/repo",
  "model": "claude-sonnet-4-5-20250929",
  "knowledgeBaseId": "optional-kb-id"
}
```

说明：

- `repoPath` 必须存在且是本地目录。
- `model` 可选；为空时由宿主自动选择可用模型。
- `knowledgeBaseId` 可选；为空时按仓库名称自动推导。

### 4.2 主要产物位置

- `~/.proma/plugin-workspaces/wiki-local-repository-plugin/wiki/latest.md`
- `~/.proma/plugin-workspaces/wiki-local-repository-plugin/wiki/latest.json`
- `~/.proma/plugin-workspaces/wiki-local-repository-plugin/wiki/latest-index-summary.json`
- `~/.proma/plugin-workspaces/wiki-local-repository-plugin/wiki/knowledge-bases/<knowledgeBaseId>/metadata.json`
- `~/.proma/plugin-workspaces/wiki-local-repository-plugin/wiki/knowledge-bases/<knowledgeBaseId>/chunks.json`

### 4.3 索引元数据契约（摘要）

- `indexVersion`
- `model`
- `chunkStrategy`
- `repositoryFingerprint`
- `generatedAt`
- `totalFiles` / `totalChunks`
- `reusedChunks` / `rebuiltChunks`

## 5. 继续聊天行为

- 会话通过 `pluginId + knowledgeBaseId + sessionId` 隔离。
- 事件流包含：`delta`、`citation`、`done`、`error`。
- 当文档库缺失或校验失败时，会返回可诊断错误并引导先完成扫描。

## 6. 行为约束与边界

- 仅处理本地路径。
- 扫描流水线由宿主统一实现，插件只负责参数和工作台交互。
- 插件禁用时，扫描与会话能力调用会被宿主拒绝。
- `get-latest` 保持兼容，仍可读取 Markdown，同时补充索引摘要。

## 7. 常见问题

### Q1：继续聊天提示“知识库不可用”

先执行一次 `analyze` 并等待任务完成，再发起聊天。

### Q2：模型不可用

检查渠道配置中是否启用了对应模型；不可用模型会被启动前校验拒绝。

### Q3：暂停后没有立刻停止当前文件处理

扫描采用协作式暂停点，通常会在当前最小处理单元完成后进入 `paused`。

### Q4：为什么还有 `get-latest`

用于兼容旧调用链，同时输出新增索引元数据摘要，便于迁移期间平滑过渡。
