# 架构

[文档导航 / Documentation](../README.md) · [中文](architecture.md) · [English](architecture_EN.md)

```text
apps/                         # desktop、server、cli 三个应用入口
packages/engine/              # core、lib、hub 引擎内部模块
packages/shared/              # 跨应用共享代码
packages/plugin-*/            # 已有插件 SDK workspace 包
extensions/                   # plugins、skills、examples
tooling/                      # config、scripts、build、tools
docs/                         # 使用、开发和维护文档
tests/                        # 跨模块测试
```

引擎层协调多个 Manager（Agent、Session、Model、Preferences、Skill、Channel、BridgeSession、Plugin 等），通过统一的 facade 暴露。Hub 负责后台任务（心跳巡检、自动化 / 定时任务、频道路由、Agent 间通信、DM 路由），独立于当前聊天会话运行。

Session 内的用户可见文件通过 `SessionFile` sidecar 统一登记，桌面端、Bridge、Mobile PWA 和其它远程前端按各自能力消费同一份文件身份。各 Bridge adapter 显式声明自己的媒体类型、投递方式与大小限制；插件文件贡献规则见 [插件开发指南](PLUGINS.md)。

本机 staged 文件优先由各平台 adapter 直接上传：Telegram / 飞书 / 微信走各自上传接口，QQ 走官方 Bot 分片上传接口，再发送 `msg_type: 7` 富媒体消息。`preferences.bridge.mediaPublicBaseUrl` / `HANA_BRIDGE_PUBLIC_BASE_URL` 只用于仍需公网 URL 的平台或远程 fallback；该 URL 作为 `/api/bridge/media/:token` 临时文件路由的 origin，文件本身仍由短期 token、下载次数和本地路径白名单保护。Hana 不会自动开启公网 tunnel，公网入口必须由用户显式提供。

Server 以独立 Node.js 进程运行（由 Electron spawn 或独立启动），通过 Vite 打包，@vercel/nft 追踪依赖。与 Electron 渲染进程通过 WebSocket 通信。
用户数据目录由 `HANA_HOME` 决定（正式应用默认 `~/.hanaagent`，源码开发启动器默认 `~/.hanaagent-dev`，均可显式覆盖）。Hana 管理的 Pi SDK 运行时资源位于 `${HANA_HOME}/runtime/pi-sdk/`；Hana 不依赖 Pi 的全局 agent 目录或 `PI_CODING_AGENT_DIR`。旧版本遗留在 `${HANA_HOME}/.pi/agent/bin/` 的 `fd` / `rg` 只会在首次使用相应搜索工具时复制到新目录，旧文件会原样保留。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面端 | Electron 42 |
| 前端 | React 19 + Zustand 5 + CSS Modules |
| 构建 | Vite 7 |
| 服务端 | Hono + @hono/node-server |
| Agent 运行时 | [Pi SDK](https://github.com/badlogic/pi-mono) |
| 数据库 | better-sqlite3（WAL 模式） |
| 测试 | Vitest |
| 国际化 | 5 语言（zh / en / ja / ko / zh-TW） |
