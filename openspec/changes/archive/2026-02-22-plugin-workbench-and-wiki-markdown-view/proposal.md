## Why

当前插件能力虽已具备启停与 capability 调用，但 UI 入口仍主要在设置页，无法形成“像 Chat/Agent 一样的插件工作台”体验，也缺少插件自定义界面承载能力。需要现在推进插件工作台与 Wiki 可视化界面升级，降低插件开发复杂度，并把通用能力内聚到宿主、把扩展能力外化给插件。

## What Changes

- 新增左侧主导航 `Plugin` 视图，与 `Chat` / `Agent` 同级。
- 在 `Plugin` 视图中提供插件列表区（当前至少展示 Wiki 插件）+ 右侧插件主画布区。
- 为插件系统引入“自定义 UI 画布钩子”能力：插件可声明并渲染自己的右侧界面（由宿主提供容器、生命周期、通信桥接）。
- 为插件开发者提供更易用的宿主 API（文件、事件、能力调用、内容渲染等），减少插件内重复样板代码。
- 宿主提供基础 UI 组件与布局协议（如页面容器、分栏、卡片、工具栏、空态、加载态等），插件优先复用以保证整体视觉与交互一致性。
- 升级 Wiki 插件体验：右侧直接展示生成的 Markdown 文档内容，支持读取最新产物并在插件界面中浏览。
- 将项目根目录 `PLUGIN.md` 维护为插件开发指南，沉淀插件开发约定、宿主组件复用规范与生命周期检查清单。
- 保持插件生命周期、权限边界、异常隔离的既有约束不退化。

## Capabilities

### New Capabilities
- `plugin-workbench-shell`: 定义插件主导航入口、插件列表区与右侧插件画布区的宿主壳层能力。
- `plugin-ui-canvas-hook`: 定义插件可选自定义 UI 渲染钩子、数据通信契约与生命周期对齐机制。
- `plugin-host-api-simplification`: 定义面向插件的高频宿主 API 聚合与易用接口，降低插件开发门槛。
- `plugin-ui-foundation-components`: 定义宿主对插件暴露的基础 UI 组件与布局契约，用于统一视觉语言与交互模式。
- `wiki-markdown-workbench-view`: 定义 Wiki 插件在插件工作台中的 Markdown 产物可视化与交互流程。

### Modified Capabilities
- （无）

## Impact

- 受影响模块：
  - `apps/electron/src/renderer`（导航、布局、plugin view、plugin atoms）
  - `apps/electron/src/preload/index.ts`（插件 UI/宿主桥接 API）
  - `apps/electron/src/main/ipc.ts` 与 `apps/electron/src/main/lib/plugins/*`（插件 UI 钩子与能力扩展）
  - `packages/shared/src/types/plugin.ts`（插件 UI 钩子、宿主 API 与基础 UI 组件契约类型）
  - `apps/electron/resources/plugins/wiki-local-repository-plugin/*`（Wiki 插件界面与交互升级）
  - `PLUGIN.md`（插件开发指南与约定维护）
- 对外行为变化：插件不再仅在设置页操作，新增独立工作台入口与插件右侧画布体验。
- 风险与依赖：需确保导航切换与现有 Chat/Agent 状态隔离；插件 UI 渲染必须保持权限和异常隔离；需保持现有插件启停链路兼容。