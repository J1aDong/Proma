## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Plugin 壳层必须统一展示插件长任务运行态
系统 SHALL 在插件画布壳层统一展示插件长任务状态（运行、暂停、完成、失败）与进度，不要求每个插件重复实现状态条。

#### Scenario: 插件任务状态变化时壳层更新
- **WHEN** 插件任务事件从主进程推送到渲染层
- **THEN** 系统 SHALL 在壳层状态区域更新对应任务状态与进度
- **AND** 系统 SHALL 保持插件画布主体区域可继续交互

### Requirement: Plugin 壳层必须提供标准控制动作入口
系统 MUST 在声明支持任务控制的插件画布中提供统一的暂停、继续、停止控制入口。

#### Scenario: 用户在壳层点击暂停
- **WHEN** 用户点击壳层统一暂停按钮
- **THEN** 系统 SHALL 调用对应插件任务的 `pause` 控制命令
- **AND** 系统 SHALL 在结果返回后更新按钮可用态与状态文案
