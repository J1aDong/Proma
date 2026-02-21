## ADDED Requirements

### Requirement: 本地安装来源约束
系统 MUST 仅支持本地插件安装来源，并拒绝未授权的远程安装来源。

#### Scenario: 用户尝试远程 URL 安装
- **WHEN** 用户提供远程 URL 作为插件安装来源
- **THEN** 系统 SHALL 拒绝安装请求
- **AND** 系统 SHALL 返回“V1 仅支持本地安装”的明确提示

### Requirement: 安装目录与元数据持久化
系统 MUST 将插件安装内容与索引元数据持久化到本地文件系统，并在重启后可恢复插件列表。

#### Scenario: 安装后重启仍可见插件
- **WHEN** 用户完成本地插件安装并重启应用
- **THEN** 系统 SHALL 从本地索引恢复插件清单
- **AND** 系统 SHALL 正确显示插件安装状态

### Requirement: 安装时权限声明校验
系统 MUST 在安装阶段读取并校验插件权限声明，未通过校验的插件不得进入可启用状态。

#### Scenario: 插件声明非法权限
- **WHEN** 插件 manifest 包含未定义或不受支持的权限项
- **THEN** 系统 SHALL 阻止该插件进入可启用列表
- **AND** 系统 SHALL 提供权限校验失败原因