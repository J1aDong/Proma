## Why

当前 Wiki 插件仅实现“扫描仓库并生成文档”的单点能力，缺少类似 DeepWiki 的可持续知识交互链路（任务控制、基于文档继续对话、模型可选），导致用户在分析后无法在同一工作流内沉淀和复用结果。现在推进该能力可将 Wiki 从一次性工具升级为插件系统可复用的基础能力，服务后续更多插件场景。

## What Changes

- 将 Wiki 插件从“仅扫描”升级为“扫描任务编排 + 文档库问答”闭环：支持开始、暂停、继续、停止以及状态可视化。
- 新增 AI 驱动的扫描与索引协议：在仓库遍历后执行语义分块、Embedding 与可检索索引构建，避免仅产出统计型 Markdown。
- 新增扫描任务运行态控制协议，统一任务状态、进度与中断语义，保证长流程可控。
- 新增扫描模型选择能力（按渠道/模型配置），在发起扫描前可选模型并持久化到会话上下文。
- 新增“基于扫描文档库继续聊天”能力，参考 Agent 模块流式交互模式，通过插件系统对外暴露可复用的会话接口。
- 将通用能力下沉到插件系统：任务控制、流式消息桥接、插件会话上下文与文档库检索调用入口，避免能力仅耦合在 Wiki 插件内部。
- 更新插件文档契约：维护 `PLUGIN.md`（宿主能力边界与可复用能力）与 `PLUGIN_WIKI.md`（Wiki 插件使用与行为说明）。

## Capabilities

### New Capabilities
- `plugin-wiki-ai-indexing`: 定义插件侧 AI 扫描与索引构建能力（分块、Embedding、索引产物与可检索契约）。
- `plugin-wiki-runtime-control`: 定义插件长任务的开始/暂停/继续/停止协议、状态机与事件回传约束。
- `plugin-document-chat-bridge`: 定义插件侧“基于文档库继续对话”的会话桥接能力（流式输出、上下文绑定、会话隔离）。
- `wiki-repository-knowledge-chat`: 定义 Wiki 插件扫描后基于文档库进行问答与连续对话的产品能力。

### Modified Capabilities
- `wiki-markdown-workbench-view`: 从“生成+读取 Markdown”扩展为“任务控制 + 结果阅读 + 文档库问答”一体化画布能力。
- `plugin-workbench-shell`: 增加对插件长任务状态展示与控制动作（暂停/继续/停止）的统一壳层支持。
- `plugin-ui-canvas-hook`: 扩展画布钩子协议，支持任务控制动作、运行态反馈与文档会话入口。
- `plugin-host-api-simplification`: 扩展宿主 API 门面，补充任务控制与文档库会话相关的标准接口。

## Impact

- 主进程插件运行时与 API 门面：`apps/electron/src/main/lib/plugins/*`（AI 扫描/索引、任务控制、会话桥接、能力路由）。
- IPC 与共享类型：`apps/electron/src/main/ipc.ts`、`apps/electron/src/preload/index.ts`、`packages/shared/src/types/plugin.ts`（新增动作、事件与 AI 扫描配置类型）。
- Plugin 工作台与 Wiki 画布：`apps/electron/src/renderer/components/plugin*` 及 Wiki 相关组件（控制按钮、状态展示、对话区）。
- Wiki 插件实现与 manifest：`apps/electron/resources/plugins/wiki-local-repository-plugin/*`（新增动作与会话逻辑）。
- 规范文档：`PLUGIN.md`、`PLUGIN_WIKI.md`、对应 OpenSpec capability 规格文件。