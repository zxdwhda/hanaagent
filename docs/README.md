# 文档导航 / Documentation

[项目首页](../README.md) · [English home](README_EN.md)

hanaagent 由 zxdwhda 独立维护，来自 openhanako 公开 0.450.0 源码。当前版本 0.450.1；功能介绍、独立修改和实际验证范围分别在下列入口维护。

| 你想做什么 / Goal | 从这里开始 / Start here |
| --- | --- |
| 运行和首次配置 / Run and configure | [运行指南](usage/quick-start.md) · [English](usage/quick-start_EN.md) |
| 了解已有功能 / Explore features | [功能概览](usage/features.md) · [English](usage/features_EN.md) |
| 看代码结构 / Understand architecture | [架构与技术栈](development/architecture.md) · [English](development/architecture_EN.md) |
| 开发和贡献 / Develop and contribute | [贡献指南](../.github/CONTRIBUTING.md) |
| 编写插件 / Build plugins | [插件开发指南](development/PLUGINS.md) · [English](development/PLUGINS_EN.md) |
| 使用插件 SDK / Use plugin SDKs | [Plugin SDK](development/PLUGIN_SDK.md) |
| 了解来源和独立改动 / Check provenance and scope | [独立维护说明](maintenance/INDEPENDENT_MAINTENANCE.md) · [来源基线](maintenance/FORK_BASELINE.md) |
| 构建、安装、更新和回退 / Build and manage local releases | [本地版本管理](maintenance/LOCAL_RELEASES.md) |
| 找源码、数据和维护材料 / Locate source, data and records | [目录与材料归属](maintenance/directories.md) |
| 报告问题或漏洞 / Report a bug or vulnerability | [Issues](https://github.com/zxdwhda/hanaagent/issues) · [安全政策](../.github/SECURITY.md) |

维护说明目前以中文为准；已有英文使用、架构和插件文档保留独立入口。

## 文档放在哪里

- `usage/`：使用与配置。
- `development/`：架构、插件与 SDK。
- `maintenance/`：来源、独立维护范围、版本管理与目录约定。
- 根目录：中文首页、许可证、NOTICE 与必要工程入口；英文首页位于 `docs/README_EN.md`，贡献、安全和行为准则位于 `.github/`，配置集中在 `tooling/config/`。
- 模块内 README：SDK 包、示例、测试等内容继续靠近对应源码维护。

本地任务记录位于 `TaskFlowDocs/`，迁移试验、备份和验收材料位于 `.local/`，两者不随公开源码提交。公开文档只描述可复用的操作和约定，不包含这些私有材料。
