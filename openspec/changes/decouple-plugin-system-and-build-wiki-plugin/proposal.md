## Why

Proma 当前的能力主要以内建模块形态存在，业务功能与宿主进程耦合较深，导致功能扩展和演进成本高。为支持可持续扩展，需要先抽离稳定、可控的插件系统内核，并以 Wiki 作为首个真实插件进行验证，且满足本地优先与低感知启停体验。

## What Changes

- 新增插件系统内核（主进程）：插件发现、清单校验、生命周期管理、权限控制、能力注入与状态管理。
- 抽离并标准化宿主-插件契约：manifest 规范、生命周期钩子、能力边界（LLM/文件系统/MCP/UI 扩展点）。
- 新增本地插件管理能力：安装、启用、禁用、卸载，仅支持本地安装来源（V1 不做插件市场）。
- 实现低感知热生命周期：启用/禁用/卸载操作不要求用户主动重启宿主程序，至少用户体感上无明显重启中断。
- 在插件系统上实现 Wiki 插件（V1）：仅面向本地代码仓库，提供代码结构分析与 Wiki 内容生成/浏览能力。
- 参考 deepwiki-open 与 claude wiki 的设计思路，落地为 Proma 插件化架构与本地 Wiki 插件实现。

## Capabilities

### New Capabilities

- `plugin-runtime-kernel`: 提供插件运行时内核与宿主-插件能力边界，支持插件加载、激活、停用与隔离执行。
- `plugin-lifecycle-hot-management`: 提供插件启用/禁用/卸载的低感知热生命周期管理，不依赖用户可感知的应用重启。
- `plugin-local-installation`: 提供本地插件安装与清单校验流程，管理插件安装目录与元数据持久化。
- `wiki-local-repository-plugin`: 提供基于本地代码仓库的 Wiki 插件能力（索引、内容生成、浏览入口）。

### Modified Capabilities

- 无（当前仓库尚未定义可复用的现有 OpenSpec capability，需要本次新增）。

## Impact

- `packages/shared/`：新增或扩展插件契约类型、manifest schema、IPC 通道常量与能力接口定义。
- `apps/electron/src/main/`：新增插件内核模块（运行时、生命周期、安装管理），并在 IPC 层集成插件管理通道。
- `apps/electron/src/preload/`：暴露插件管理 API（安装/启用/禁用/卸载/查询状态）。
- `apps/electron/src/renderer/`：新增插件管理状态与界面入口；接入 Wiki 插件页面与交互。
- `~/.proma/` 本地数据目录：新增插件安装与运行相关目录/配置（本地优先，不引入本地数据库）。
- 测试与验证：补充插件生命周期与 Wiki 插件基础流程的测试用例与验证步骤。