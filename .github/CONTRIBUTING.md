# Contributing to hanaagent

感谢你对 HanaAgent 的关注！

## 开发环境

### 前置条件

- Node.js >= 24.12 且 < 25（参考版本 24.15.0，见 package.json engines）
- npm (latest compatible with your Node.js version)
- C/C++ 编译工具链（编译 `better-sqlite3` native module 需要）：
  - **macOS**：`xcode-select --install`（安装 Command Line Tools）
  - **Linux**：`sudo apt install build-essential python3`（Debian/Ubuntu）
  - **Windows**：安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（选择 "Desktop development with C++" 工作负载）

### 本地运行

```bash
# 安装依赖
npm ci

# 启动 Electron（自动构建前端）
HANA_HOME="$HOME/.hanaagent-dev" npm start

# 或者用 Vite HMR 开发前端
npm run dev:renderer
# 另一个终端
npm run start:vite
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm start` | 构建前端 + 启动 Electron |
| `npm run start:vite` | Vite HMR 模式启动 |
| `npm test` | 运行测试（Vitest） |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint 检查 |
| `npm run server` | 仅启动开发服务端 |
| `npm run cli` | server-first CLI |
| `npm run build:renderer` | 单独构建前端 |
| `npm run build:packages` | 构建插件 SDK 包 |

### Native Module 注意事项

Server 以独立 Node.js 进程运行（`spawn`，非 `fork`），不在 Electron 主进程内，因此 `better-sqlite3` **不需要 `electron-rebuild`**。`build-server.mjs` 在目标 Node.js runtime 下执行 `npm install --omit=dev`，native addon 的 ABI 自动匹配。

## Pull Request 与 Issue

这是由 zxdwhda 独立维护的 hanaagent，欢迎 Issue、修复和 Pull Request；不会自动关闭外部贡献。

- Bug：提供系统和版本、复现步骤、期望与实际行为。日志和截图先移除密钥、聊天内容和个人信息。
- 功能：说明需求和使用场景；涉及数据格式、更新或跨平台的大改动，建议先开 Issue 讨论。
- PR：聚焦一个问题，说明改动与验证结果，保留现有用户数据和兼容性；按改动运行适用测试与类型检查。
- 不要求使用指定 Agent，也允许提供修复建议、补丁和实现讨论。
- 安全漏洞按 [SECURITY.md](SECURITY.md) 私密报告，不在公开 Issue 中贴凭据或可利用细节。

当前主要验证 macOS Apple Silicon。Windows/Linux 的代码仍在，但贡献跨平台改动时请提供目标平台验证结果。

完整文档见[文档导航](../docs/README.md)，首次配置与 Windows PowerShell 的环境变量设置见[运行指南](../docs/usage/quick-start.md)。打包、安装、更新与回退见[本地版本管理](../docs/maintenance/LOCAL_RELEASES.md)。

## 项目结构

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

## License

提交贡献即表示你同意你的代码以 [Apache License 2.0](../LICENSE) 授权。
