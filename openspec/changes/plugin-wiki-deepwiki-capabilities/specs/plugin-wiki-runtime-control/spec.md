## ADDED Requirements

### Requirement: 插件长任务必须支持开始暂停继续停止的统一控制协议
系统 SHALL 为插件长任务提供统一控制命令集合（start、pause、resume、stop）与状态查询接口，且状态机必须覆盖 `idle`、`running`、`paused`、`stopped`、`completed`、`failed`。

#### Scenario: 用户暂停运行中的扫描任务
- **WHEN** 用户对 `running` 状态的 Wiki 扫描任务发送 `pause` 命令
- **THEN** 系统 SHALL 将任务状态流转到 `paused`
- **AND** 系统 SHALL 返回当前进度快照用于后续恢复

### Requirement: 插件长任务控制必须保证幂等与非法状态拒绝
系统 MUST 对重复命令和非法状态转换执行一致的拒绝或幂等处理，避免任务进入不可预期状态。

#### Scenario: 对已暂停任务重复执行 pause
- **WHEN** 用户对 `paused` 任务再次发送 `pause` 命令
- **THEN** 系统 SHALL 返回幂等成功或显式无操作结果
- **AND** 系统 SHALL 保持任务状态为 `paused`

### Requirement: 插件长任务必须推送可诊断运行事件
系统 SHALL 推送任务生命周期事件（开始、进度、暂停、继续、停止、完成、失败）并包含任务标识、插件标识与时间戳。

#### Scenario: 任务执行过程中产生进度事件
- **WHEN** 扫描任务处理到新的阶段或进度百分比变化
- **THEN** 系统 SHALL 推送结构化进度事件
- **AND** 系统 SHALL 使渲染层可基于事件更新统一运行态 UI
