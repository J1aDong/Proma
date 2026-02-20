## ADDED Requirements

### Requirement: 宿主提供聚合且类型安全的插件 API
系统 SHALL 为插件工作台提供聚合 API，以统一覆盖插件列表、状态读取、能力调用与画布动作调用等高频能力。

#### Scenario: 渲染层调用插件工作台 API
- **WHEN** 渲染进程请求插件列表、状态和动作调用
- **THEN** 系统 SHALL 通过统一 API Facade 返回类型安全的响应数据
- **AND** 系统 SHALL 避免要求插件开发者直接拼装多个底层 IPC 通道

### Requirement: 宿主 API 调用必须经过权限与状态校验
系统 MUST 在执行插件动作与能力调用前校验插件状态与权限声明，未通过校验时必须拒绝执行。

#### Scenario: 未授权能力调用
- **WHEN** 插件尝试调用未声明权限或未声明 capability 的宿主能力
- **THEN** 系统 SHALL 拒绝调用并返回可诊断错误
- **AND** 系统 SHALL 不执行任何越权副作用

### Requirement: 宿主 API 错误语义必须一致
系统 MUST 对插件相关 API 返回统一的成功/失败语义与错误结构，以便插件界面统一处理反馈。

#### Scenario: 插件动作调用失败
- **WHEN** 插件动作在主进程执行失败
- **THEN** 系统 SHALL 返回结构化错误响应
- **AND** 系统 SHALL 使渲染层可统一映射为加载态、错误态或重试态
