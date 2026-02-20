## ADDED Requirements

### Requirement: 插件运行时内核边界
系统 MUST 提供独立的插件运行时内核，并通过稳定契约向插件暴露受控能力，插件不得直接依赖宿主内部业务服务实现。

#### Scenario: 插件通过受控 API 获取能力
- **WHEN** 插件在激活过程中请求 LLM、文件系统或 MCP 能力
- **THEN** 宿主 SHALL 仅通过插件 API Facade 返回已授权能力对象
- **AND** 宿主 SHALL 拒绝插件直接访问未暴露的内部 service 实例

### Requirement: 插件清单校验与加载约束
系统 MUST 在加载插件前对 manifest 进行结构与字段校验，校验失败时不得进入激活流程。

#### Scenario: manifest 缺失关键字段
- **WHEN** 插件 manifest 缺失 `id`、`version` 或 `entry` 等关键字段
- **THEN** 系统 SHALL 将插件状态标记为 `error` 或 `invalid`
- **AND** 系统 SHALL 返回可诊断的错误信息

### Requirement: 插件异常隔离
插件运行异常 MUST 不得导致宿主主流程中断，系统 SHALL 进行错误隔离并支持后续恢复操作。

#### Scenario: 插件激活时抛出异常
- **WHEN** 插件 `activate` 执行中抛出未处理错误
- **THEN** 系统 SHALL 将该插件状态设置为 `error`
- **AND** 系统 SHALL 保持宿主其余功能可用