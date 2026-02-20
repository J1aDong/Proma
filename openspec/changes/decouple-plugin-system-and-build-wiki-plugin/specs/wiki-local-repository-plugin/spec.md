## ADDED Requirements

### Requirement: Wiki 插件仅支持本地代码库
Wiki 插件 MUST 仅处理本地文件系统中的代码库，不得依赖远程托管平台作为 V1 前置条件。

#### Scenario: 选择本地仓库进行 Wiki 处理
- **WHEN** 用户为 Wiki 插件选择本地代码仓库路径
- **THEN** 插件 SHALL 基于该本地路径执行仓库分析与内容生成
- **AND** 插件 SHALL 不要求用户配置远程仓库凭证

### Requirement: 本地仓库结构分析与文档生成
Wiki 插件 MUST 提供面向本地仓库的结构分析和 Wiki 内容生成能力。

#### Scenario: 触发仓库分析后生成 Wiki 内容
- **WHEN** 用户在 Wiki 插件中发起分析与生成操作
- **THEN** 插件 SHALL 产出可浏览的 Wiki 页面内容
- **AND** 插件 SHALL 将生成过程中的失败状态明确反馈给用户

### Requirement: Wiki 作为插件独立运行
Wiki 功能 MUST 通过插件系统提供，不得以宿主内建模块方式绕过插件契约。

#### Scenario: 禁用 Wiki 插件后 Wiki 功能不可用
- **WHEN** 用户禁用 Wiki 插件
- **THEN** 系统 SHALL 在当前会话中隐藏或禁用 Wiki 插件功能入口
- **AND** 宿主其余功能 SHALL 保持可用