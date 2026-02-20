# PLUGIN 开发指南（Proma）

> 本文档是 Proma 插件开发的长期规范入口。后续插件系统演进时，请同步维护本文件。

## 1. 目标与定位

Proma 插件系统的核心目标：

- 把复杂、通用、易复用的能力内聚到宿主。
- 把业务扩展能力外化给插件，降低插件开发门槛。
- 保持安全边界和生命周期可控（启用/禁用/卸载无需重启）。
- 在 UI 层保证一致性：插件可扩展，但不破坏整体产品体验。

## 2. 架构总览

典型调用链：

1. 插件 `manifest.json` 声明元数据、权限、capability。
2. 主进程运行时负责扫描、校验、加载、状态维护。
3. `ipc.ts` 暴露插件管理与能力调用通道。
4. `preload/index.ts` 暴露类型安全桥接 API。
5. 渲染进程通过插件工作台/设置页完成安装、启停、调用与展示。

关键模块：

- `apps/electron/src/main/lib/plugins/runtime.ts`
- `apps/electron/src/main/lib/plugins/api-facade.ts`
- `apps/electron/src/main/lib/plugins/registry.ts`
- `apps/electron/src/main/lib/plugins/loader.ts`
- `apps/electron/src/main/lib/plugins/permission-gate.ts`
- `packages/shared/src/types/plugin.ts`

## 3. 生命周期与状态机

状态：

- `installed`
- `active`
- `inactive`
- `error`
- `uninstalled`

语义：

- 启用：动态加载入口并执行 `activate(context)`。
- 禁用：执行 `deactivate()`，触发资源回收与中止信号。
- 卸载：先禁用，再清理安装目录/工作区/索引。
- 异常：插件异常应被隔离，宿主主流程不可被拖垮。

## 4. Manifest 与权限模型

Manifest 建议最小字段：

- `manifestVersion`
- `id`
- `name`
- `version`
- `entry.main`
- `permissions`
- `capabilities`

权限原则：

- 默认拒绝（deny-by-default）。
- 仅申请真实需要的权限。
- capability 是功能声明，不等于权限授权。

当前权限集合（以代码为准）：

- `filesystem:read`
- `filesystem:write`
- `llm:invoke`
- `mcp:access`
- `events:emit`

## 5. 插件运行时上下文约定

插件入口可实现：

- `activate(context)`
- `deactivate()`
- `invokeCapability(capabilityKey, payload)`

`context.lifecycle`：

- `signal`: 宿主禁用/卸载时触发 abort。
- `onCleanup(fn)`: 注册清理逻辑（监听器、定时器、句柄）。
- `throwIfAborted()`: 长流程中主动中止。

`context.api`：

- `llm` / `fs` / `mcp` / `events`（由宿主 facade 提供）
- 插件禁止直接访问宿主内部 service。

## 6. UI 一致性规范（重点）

为保证 Chat / Agent / Plugin 体验一致，插件 UI 必须遵守：

- 优先复用宿主提供的基础组件与布局协议。
- 插件可自定义内容，但基础结构由宿主壳层统一管理。
- 状态表达统一：空态、加载态、错误态、成功反馈样式一致。
- 不在插件中重复造通用控件（分页、工具栏、卡片容器等）。

建议宿主提供的基础能力（持续完善）：

- 页面容器（Page / Panel / Split）
- 基础信息块（Card / Section / StatBlock）
- 交互反馈（Loading / Empty / Error / Toast）
- 文档渲染（Markdown Viewer）
- 操作区（Toolbar / ActionGroup / SearchBar）

## 7. 目录与产物约定

运行时目录：

- `~/.proma/plugins/<plugin-id>/`
- `~/.proma/plugin-workspaces/<plugin-id>/`
- `~/.proma/plugins.json`

约定：

- 插件业务产物统一写入插件工作区。
- 禁止随意写入宿主业务目录。
- 临时文件和最终文件建议分层目录管理。

## 8. 插件开发建议

### 8.1 能力设计

- 一个 capability 只解决一类明确问题。
- 输入/输出结构稳定，避免频繁 breaking。
- 错误信息可诊断（动作 + 原因）。

### 8.2 代码组织

- 先实现最小闭环（ping -> 核心动作 -> get-latest）。
- 通用逻辑抽离为内部函数，避免 `invokeCapability` 过重。
- 所有外部输入做基本校验（路径、动作类型、字段）。

### 8.3 生命周期安全

- 长任务前后都检查 `throwIfAborted()`。
- 所有副作用必须可回收。
- `deactivate` 要幂等，重复调用不应崩溃。

### 8.4 UI 开发

- 先使用宿主组件完成 80% 页面框架。
- 仅在必要场景增加插件自定义组件。
- 插件展示页优先可读性和操作闭环。

## 9. 最短验收清单（开发者）

每个插件至少通过以下检查：

- [ ] 安装成功，列表可见。
- [ ] 启用后 capability 可立即调用。
- [ ] 禁用后 capability 被拒绝。
- [ ] 卸载后索引和目录清理符合预期。
- [ ] 异常不会影响宿主其他功能。
- [ ] 插件 UI 与宿主视觉风格一致。
- [ ] 主要产物可在插件工作区中定位。

## 10. 文档维护规则

维护本文件时请遵循：

- 插件契约变化（类型、权限、生命周期）必须更新本指南。
- 新增宿主基础组件能力时，更新第 6 节和第 8 节。
- 新增代表性插件时，可在附录增加最佳实践案例。
- 文档内容优先反映“当前实现”，避免写未来假设。
