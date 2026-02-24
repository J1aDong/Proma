## ADDED Requirements

### Requirement: 插件系统必须提供基于文档库的会话桥接接口
系统 SHALL 提供插件文档会话桥接接口，使插件可在指定 `knowledgeBaseId` 上发起多轮问答并绑定会话上下文。

#### Scenario: 插件发起首轮文档问答
- **WHEN** Wiki 插件以 `pluginId`、`knowledgeBaseId`、`model`、`messages` 发起聊天请求
- **THEN** 系统 SHALL 创建或复用对应插件会话上下文
- **AND** 系统 SHALL 返回可持续对话的会话标识

### Requirement: 文档会话桥接必须支持流式输出协议
系统 MUST 通过统一流式事件协议返回文档问答输出，至少包含文本增量、检索引用、完成与错误事件。

#### Scenario: 聊天请求成功并流式返回
- **WHEN** 插件文档聊天请求开始执行
- **THEN** 系统 SHALL 持续推送文本增量与引用信息
- **AND** 系统 SHALL 在结束时推送 `done` 事件

### Requirement: 文档会话桥接必须隔离插件与知识库上下文
系统 MUST 按 `pluginId + knowledgeBaseId + sessionId` 隔离上下文，禁止跨插件或跨知识库串话。

#### Scenario: 不同插件访问不同知识库
- **WHEN** 两个插件分别在不同 `knowledgeBaseId` 上发起问答
- **THEN** 系统 SHALL 分别维护独立会话上下文
- **AND** 系统 SHALL 不返回其他插件知识库的上下文内容
