## MODIFIED Requirements

### Requirement: Wiki 插件必须出现在 Plugin 工作台列表并可打开右侧画布
系统 SHALL 在 Plugin 工作台的插件列表中展示 `wiki-local-repository-plugin`，并支持用户选择后在右侧显示其界面。

#### Scenario: 用户在插件列表选择 Wiki
- **WHEN** 用户在 Plugin 工作台点击 Wiki 插件
- **THEN** 系统 SHALL 在右侧加载 Wiki 插件画布
- **AND** 系统 SHALL 展示该插件当前可执行的主操作入口

### Requirement: Wiki 画布必须支持 Markdown 产物展示
系统 MUST 允许用户在 Wiki 插件右侧画布直接查看最近生成的 Markdown 文档内容，并可在文档区与问答区之间切换。

#### Scenario: 读取并展示最近 Markdown 产物
- **WHEN** 用户在 Wiki 画布触发读取最近结果
- **THEN** 系统 SHALL 从插件工作区读取 `wiki/latest.md`
- **AND** 系统 SHALL 在右侧画布以 Markdown 方式渲染内容

### Requirement: Wiki 画布必须提供生成与读取闭环操作
系统 SHALL 在 Wiki 画布中提供本地仓库分析生成、运行控制与最近结果读取能力，形成完整操作闭环。

#### Scenario: 用户执行分析并查看结果
- **WHEN** 用户输入本地仓库路径并触发分析生成
- **THEN** 系统 SHALL 调用 `wiki:local-repository` 的 `analyze` 动作生成文档
- **AND** 系统 SHALL 支持随后读取并展示最新 Markdown 结果

#### Scenario: 用户控制扫描任务运行状态
- **WHEN** 用户在扫描过程中触发暂停、继续或停止操作
- **THEN** 系统 SHALL 将动作映射为对应任务控制命令
- **AND** 系统 SHALL 在画布中展示最新任务状态与进度

### Requirement: Wiki 插件未启用时必须明确不可用状态
系统 MUST 在 Wiki 插件未启用或不可用时提供明确状态提示，并拒绝相关 capability 调用。

#### Scenario: Wiki 插件处于 inactive 状态
- **WHEN** 用户在 Plugin 工作台尝试使用 Wiki 能力
- **THEN** 系统 SHALL 展示“插件未启用”提示
- **AND** 系统 SHALL 返回被拒绝调用的错误结果而不执行生成流程

## ADDED Requirements

### Requirement: Wiki 画布必须提供文档库继续聊天入口
系统 SHALL 在 Wiki 画布中提供“继续聊天”入口，使用户可基于当前仓库文档库发起多轮问答。

#### Scenario: 用户在 Wiki 画布发起继续聊天
- **WHEN** 用户在 Wiki 画布输入问题并点击发送
- **THEN** 系统 SHALL 调用文档会话桥接能力执行问答
- **AND** 系统 SHALL 在同一画布展示流式回答与引用信息
