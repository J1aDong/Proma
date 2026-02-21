## Purpose
TBD

## Requirements

### Requirement: Plugin 作为一级导航模式
系统 SHALL 在应用左侧主导航中提供 `Plugin` 入口，并与 `Chat`、`Agent` 保持同级可切换关系。

#### Scenario: 用户切换到 Plugin 模式
- **WHEN** 用户在主导航点击 `Plugin`
- **THEN** 系统 SHALL 激活插件工作台主视图
- **AND** 系统 SHALL 保持 `Chat` 与 `Agent` 入口可见且可再次切换

### Requirement: Plugin 工作台采用固定双栏壳层
系统 MUST 在 Plugin 模式中提供左侧插件列表区与右侧插件画布区，并由宿主统一管理布局壳层与容器行为。

#### Scenario: 进入 Plugin 工作台
- **WHEN** 用户进入 `Plugin` 视图
- **THEN** 系统 SHALL 在左侧展示可用插件列表
- **AND** 系统 SHALL 在右侧展示当前插件画布或默认占位画布

### Requirement: Plugin 模式与 Chat/Agent 状态隔离
系统 MUST 保证 Plugin 模式状态与 Chat/Agent 模式状态相互隔离，模式切换不得造成其他模式的上下文丢失。

#### Scenario: 多模式来回切换
- **WHEN** 用户在 `Chat`、`Agent` 与 `Plugin` 之间切换
- **THEN** 系统 SHALL 保留各模式已存在的会话与界面状态
- **AND** 系统 SHALL 不因切换到 `Plugin` 而重置 `Chat` 或 `Agent` 的当前上下文
