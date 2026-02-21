## 1. 共享契约与类型扩展

- [x] 1.1 在 `packages/shared/src/types/plugin.ts` 新增插件工作台 UI 契约（画布钩子、基础组件协议、宿主 API 响应结构）
- [x] 1.2 在 `packages/shared/src/types/index.ts` 导出新增插件工作台相关类型
- [x] 1.3 为插件工作台相关 IPC 通道补充请求/响应类型定义并保证与现有插件生命周期类型兼容

## 2. 主进程工作台能力与 IPC 接入

- [x] 2.1 在 `apps/electron/src/main/lib/plugins/runtime.ts` 增加插件画布元数据读取与动作调用入口（保持权限与状态校验）
- [x] 2.2 在 `apps/electron/src/main/lib/plugins/api-facade.ts` 扩展插件可用宿主 API（文件读取、能力调用、画布动作）
- [x] 2.3 在 `apps/electron/src/main/ipc.ts` 新增 Plugin 工作台 IPC 通道（列表、选中插件画布、画布动作调用）
- [x] 2.4 确保插件画布钩子异常时降级为统一错误响应，不影响插件管理主流程

## 3. Preload 聚合桥接层

- [x] 3.1 在 `apps/electron/src/preload/index.ts` 暴露类型安全的插件工作台聚合 API
- [x] 3.2 保持现有插件管理 API（install/enable/disable/uninstall）兼容，避免破坏设置页流程

## 4. Renderer 插件工作台壳层实现

- [x] 4.1 在 `apps/electron/src/renderer` 的应用模式中新增 `plugin` 一级入口（与 Chat/Agent 同级）
- [x] 4.2 新增 Plugin 工作台视图组件，实现左侧插件列表 + 右侧画布壳层结构
- [x] 4.3 在 `apps/electron/src/renderer/atoms` 新增插件工作台状态 atoms（选中插件、画布加载态、错误态）
- [x] 4.4 保证 Plugin 模式与 Chat/Agent 状态隔离，切换时不丢失既有上下文

## 5. 宿主基础组件协议与统一状态表达

- [x] 5.1 在渲染层实现插件画布基础组件映射（Page/Panel/Split/Card/Toolbar/Markdown Viewer）
- [x] 5.2 统一插件画布空态、加载态、错误态组件与交互文案
- [x] 5.3 为未声明画布钩子的插件提供默认占位画布（能力列表 + 状态提示）

## 6. Wiki 插件右侧 Markdown 体验落地

- [x] 6.1 在 `apps/electron/resources/plugins/wiki-local-repository-plugin` 增加画布钩子定义，接入右侧插件画布
- [x] 6.2 在 Wiki 画布中提供本地仓库分析生成与读取最新文档的操作闭环
- [x] 6.3 在右侧画布渲染 `wiki/latest.md`，并在插件未启用时显示明确不可用提示

## 7. 验证与文档维护

- [x] 7.1 执行插件工作台关键链路验证（入口切换、插件列表、画布渲染、异常降级）
- [x] 7.2 执行 Wiki 插件流程验证（analyze -> latest.md 渲染 -> disabled 拒绝调用）
- [x] 7.3 运行 `bun run typecheck` 收敛类型问题
- [x] 7.4 同步维护根目录 `PLUGIN.md`，更新宿主组件复用与插件 UI 画布开发约定
