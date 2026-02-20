# Wiki 插件使用说明（`wiki-local-repository-plugin`）

本文档介绍内置 Wiki 插件的用途、操作步骤、输出结果和常见问题。

## 1. 插件定位

- 插件 ID：`wiki-local-repository-plugin`
- capability：`wiki:local-repository`
- 版本：`0.1.0`
- 权限：
  - `filesystem:read`
  - `filesystem:write`

入口文件：

- `apps/electron/resources/plugins/wiki-local-repository-plugin/index.mjs`

manifest：

- `apps/electron/resources/plugins/wiki-local-repository-plugin/manifest.json`

## 2. 提供的能力

`invokeCapability("wiki:local-repository", payload)` 支持动作：

- `ping`：连通性测试。
- `analyze`：分析本地仓库并生成 Wiki。
- `get-latest`：读取最近一次生成结果。

## 3. 快速使用（UI）

1. 启动应用：

```bash
bun run --cwd "/Users/mr.j/myRoom/code/ai/MyProjects/Proma" dev
```

2. 进入设置页 -> 插件管理。
3. 启用 `wiki-local-repository-plugin`。
4. 在 Wiki 区域选择本地仓库目录。
5. 点击“分析并生成”。
6. 点击“读取最新”查看最近报告。

## 4. 输入与输出

### 4.1 analyze 输入

```json
{
  "action": "analyze",
  "repoPath": "/absolute/path/to/local/repo"
}
```

要求：

- `repoPath` 必须存在且是本地目录。
- 不依赖远程仓库凭证。

### 4.2 生成输出位置

- `~/.proma/plugin-workspaces/wiki-local-repository-plugin/wiki/latest.json`
- `~/.proma/plugin-workspaces/wiki-local-repository-plugin/wiki/latest.md`

### 4.3 报告内容（摘要）

- 仓库路径与生成时间
- 目录数量、文件数量、代码文件数量
- 顶层结构（最多 30 条）
- 代码文件样本（最多 20 条）
- 关键文件摘要（如 `README.md`、`package.json`、`go.mod` 等）
- Markdown Wiki 正文

## 5. 行为约束与边界

- 仅处理本地路径。
- 遍历时默认跳过常见大目录（如 `.git`、`node_modules`、`dist` 等）。
- 当前遍历深度上限为 8 层。
- 插件禁用时，能力调用会被宿主拒绝。

## 6. 常见问题

### Q1：点击“读取最新”提示找不到文件

通常是还没执行过“分析并生成”。先生成一次，再读取。

### Q2：提示 `repoPath 不存在或不是目录`

请确认填写的是本地绝对路径，且目录真实存在。

### Q3：插件状态不是 `active`

先在插件列表里点击“启用”，状态变为 `active` 后再调用 Wiki 功能。

### Q4：禁用后为什么不可用

这是预期行为：禁用即立刻失效，避免插件在后台继续占用资源。

## 7. 开发扩展建议

- 新增动作时保持 `action` 清晰、输入输出稳定。
- 长流程中定期调用 `context.lifecycle.throwIfAborted()`。
- 新增文件产物统一写到插件工作区，不写宿主业务目录。
- 错误信息尽量可诊断（包含原因和动作上下文）。
