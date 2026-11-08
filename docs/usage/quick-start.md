# 运行与首次配置

[文档导航](../README.md) · [English](quick-start_EN.md)

当前版本 0.450.1 公开源码，尚无本项目公开安装包。上游安装包属于不同发行，不能作为本项目下载入口。当前本地验收以 macOS Apple Silicon 为主，其他平台见[维护范围](../maintenance/INDEPENDENT_MAINTENANCE.md)。

## 从源码运行

先安装 Node.js 24（参考版本 24.15.0）、npm、Git，以及[贡献指南](../../CONTRIBUTING.md)要求的平台编译工具。在仓库根目录执行：

```sh
npm ci
HANA_HOME="$HOME/.hanaagent-dev" npm start
```

显式设置开发数据目录可与正式数据隔离。Windows PowerShell 请先运行 `$env:HANA_HOME = "$HOME/.hanaagent-dev"`，再运行 `npm start`。`npm start`、`npm run start:vite`、`npm run server` 和 `npm run cli` 经开发启动器运行，未指定 `HANA_HOME` 时使用 `~/.hanaagent-dev`；正式应用默认使用 `~/.hanaagent`。参见[目录说明](../maintenance/directories.md)。

## 首次配置

首次启动时，引导向导会带你完成配置：选择语言、输入你的名字、连接模型提供商（API key + base URL），并选择三个模型：**对话模型**（主对话）、**小工具模型**（轻量任务）、**大工具模型**（记忆编译和深度分析）。设置页还可以单独选择**视觉模型**，让文本模型通过 Vision Bridge 处理图片附件。HanaAgent 支持 OpenAI 兼容、Anthropic 风格、OAuth Provider 和 Ollama 本地模型等多类接入。


支持的提供商不代表本方已逐一验收。模型配置与密钥保存在应用数据目录，不应提交到源码仓库。

## 后续操作

- 功能入口见[功能概览](features.md)。
- 开发命令与本地调试见[贡献指南](../../CONTRIBUTING.md)。
- 打包、安装、更新和回退见[本地版本管理](../maintenance/LOCAL_RELEASES.md)。
