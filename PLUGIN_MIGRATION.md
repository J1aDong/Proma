# 插件迁移指引（旧版扫描插件 -> 新协议）

本文档说明“仅扫描并输出 Markdown”的旧插件如何渐进迁移到插件系统基础能力：AI 索引、任务控制、文档会话桥接。

## 1. 迁移目标

从旧模式：

- 插件内自行遍历仓库
- 直接生成 `latest.md`
- 无暂停/继续/停止
- 无文档库继续聊天

迁移到新模式：

- 使用宿主 `context.api.aiIndexing`
- 使用宿主 `PluginTaskRuntime` 任务状态机
- 使用宿主 `context.api.documentChat`
- 在工作台声明 `task-status` + `document-chat` 区块

## 2. 最小改造步骤（推荐顺序）

1. **升级 manifest 权限**
   - 增加 `llm:invoke`（若要使用扫描索引与文档聊天能力）。

2. **替换 analyze 实现**
   - 旧：插件内直接扫描文件并写 Markdown。
   - 新：调用 `context.api.aiIndexing.startScan({ repositoryPath, model, knowledgeBaseId })`。

3. **接入任务控制动作**
   - 在 `invokeWorkbenchAction` 增加 `pause-task`、`resume-task`、`stop-task`。
   - 调用：`pauseTask/resumeTask/stopTask`。

4. **扩展工作台协议**
   - 添加 `task-status` 节点（显示统一任务状态）。
   - 添加 `document-chat` 节点（继续聊天入口）。

5. **保留 get-latest 兼容**
   - 继续返回 `latest.md`。
   - 同时补充 `latest-index-summary.json` 内容或索引摘要字段。

6. **接入文档会话桥接**
   - 发送消息：`context.api.documentChat.send(...)`。
   - 结束会话：`context.api.documentChat.endSession(...)`。
   - 历史查询：`context.api.documentChat.getHistory(...)`。

## 3. 兼容路径

建议采用“双轨兼容”过渡：

- **阶段 A（兼容阶段）**：
  - 保留旧 `get-latest` 返回结构。
  - 新增索引摘要字段，不破坏旧调用方。

- **阶段 B（默认新能力）**：
  - UI 默认展示任务状态与继续聊天区块。
  - 旧扫描逻辑降级为兜底或删除。

- **阶段 C（完全迁移）**：
  - 插件不再维护独立扫描状态机。
  - 所有长任务和文档会话统一走宿主能力。

## 4. 常见迁移坑

1. **未声明 `llm:invoke` 权限**
   - 现象：扫描/聊天调用被拒绝。

2. **继续聊天未绑定 knowledgeBaseId**
   - 现象：会话无法找到索引。

3. **任务控制仍在插件内部实现**
   - 现象：状态与宿主壳层不一致，难以复用。

4. **遗漏增量复用元数据**
   - 现象：每次全量重建，性能回退。

## 5. 验收清单

- [ ] `analyze` 已调用宿主 AI 扫描标准能力。
- [ ] 工作台已声明 `task-status` 与 `document-chat`。
- [ ] 支持 `pause/resume/stop` 且状态可见。
- [ ] `get-latest` 仍可用，且返回索引摘要。
- [ ] 文档会话按 `pluginId + knowledgeBaseId + sessionId` 隔离。
