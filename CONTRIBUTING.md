# Contributing to hanaagent

感谢你对 HanaAgent 的关注！

## 开发环境

### 前置条件

- Node.js >= 24.12 (see package.json engines)
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
npm start

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
| `npm run build:renderer` | 单独构建前端 |

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

## 项目结构

```
core/           # Engine 编排层 + Manager
lib/            # 核心库（bridge、sandbox、memory、tools、providers）
server/         # Hono HTTP + WebSocket 服务
hub/            # 后台任务（调度器、频道路由、Agent 通信、DM 路由）
desktop/        # Electron 应用 + React 前端
shared/         # 跨层共享工具（config schema、error bus、模型引用等）
plugins/        # 内置系统插件（随应用打包）
skills2set/     # 内置技能定义
scripts/        # 构建工具（server 打包、启动器、签名）
tests/          # Vitest 测试
```

## License

提交贡献即表示你同意你的代码以 [Apache License 2.0](LICENSE) 授权。
