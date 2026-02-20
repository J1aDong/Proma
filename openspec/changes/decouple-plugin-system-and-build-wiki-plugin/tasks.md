## 1. 插件契约与内核骨架

- [x] 1.1 在 `packages/shared` 新增插件 manifest、权限、capability、生命周期状态等类型定义
- [x] 1.2 在 `packages/shared` 新增插件相关 IPC 通道常量与请求/响应类型
- [x] 1.3 在 `apps/electron/src/main` 建立插件领域模块骨架（registry/loader/runtime/permission-gate/api-facade）
- [x] 1.4 将插件目录与工作区目录路径接入现有配置路径管理，统一到 `~/.proma/` 体系

## 2. 主进程插件运行时实现

- [x] 2.1 实现插件扫描与 manifest 校验流程，失败插件标记为 `error` 并输出可诊断错误
- [x] 2.2 实现插件生命周期状态机（installed/active/inactive/error/uninstalled）
- [x] 2.3 实现插件受控能力注入（llm/fs/mcp/events），并默认拒绝未授权能力
- [x] 2.4 实现插件异常隔离，确保插件异常不影响宿主核心流程

## 3. 热生命周期管理（启用/禁用/卸载）

- [x] 3.1 实现启用流程：动态加载入口并执行 `activate(context)`，状态即时可见
- [x] 3.2 实现禁用流程：执行 `deactivate()`，中止任务并回收 IPC/监听器/资源
- [x] 3.3 实现卸载流程：先禁用再移除安装目录与索引元数据（幂等）
- [x] 3.4 保证启用/禁用/卸载在当前会话中生效，不出现“必须重启”阻断体验

## 4. 本地安装管理闭环

- [x] 4.1 实现本地安装入口与安装流程（仅本地路径来源）
- [x] 4.2 拒绝远程 URL 安装来源并返回明确错误提示
- [x] 4.3 实现插件索引元数据本地持久化与启动恢复
- [x] 4.4 在安装阶段完成权限声明校验，非法权限阻断可启用状态

## 5. IPC / Preload / Renderer 集成

- [x] 5.1 在 `main/ipc.ts` 接入插件管理通道（list/install/enable/disable/uninstall/status）
- [x] 5.2 在 `preload/index.ts` 暴露类型安全插件 API
- [x] 5.3 在 `renderer/atoms` 新增插件管理状态（列表、状态、操作中状态、错误）
- [x] 5.4 在设置或独立插件页面实现插件管理界面与操作反馈

## 6. Wiki 插件实现（V1）

- [x] 6.1 创建 `wiki-local-repository-plugin` 的 manifest 与入口模块，声明所需权限与 capability
- [x] 6.2 实现本地代码仓库选择与基础结构分析流程（不依赖远程仓库凭证）
- [x] 6.3 实现 Wiki 内容生成与基础浏览入口（通过插件系统接入）
- [x] 6.4 确保禁用 Wiki 插件后入口不可用，宿主其余功能保持可用

## 7. 验证与收敛

- [x] 7.1 增加插件生命周期关键路径验证（启用/禁用/卸载/异常隔离）
- [x] 7.2 增加本地安装与恢复验证（重启后插件清单恢复）
- [x] 7.3 增加 Wiki 插件基础流程验证（本地仓库分析与内容生成）
- [x] 7.4 执行 lint/typecheck，修复阻断问题并收敛改动（已执行 `bun run typecheck` 与 `apps/electron` 包 `tsc --noEmit`）