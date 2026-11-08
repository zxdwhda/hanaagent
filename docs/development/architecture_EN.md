# Architecture

[文档导航 / Documentation](../README.md) · [中文](architecture.md) · [English](architecture_EN.md)

```text
apps/                 Desktop, server and CLI entry points
packages/engine/      Existing core, lib and hub modules
packages/shared/      Shared runtime code and contracts
packages/plugin-*/    Existing SDK workspace packages
extensions/           Built-in plugins, skills and examples
tooling/              Config, scripts, build resources and tools
docs/                 Documentation
tests/                Integration and cross-module tests
```

The engine layer coordinates multiple managers (Agent, Session, Model, Preferences, Skill, Channel, BridgeSession, Plugin, etc.) and exposes them through a unified facade. The Hub handles background tasks (heartbeat, automation / cron, channel routing, agent messaging, DM routing) independently of the active chat session.

User-visible files inside a session are registered through `SessionFile` sidecars. Desktop, Bridge, Mobile PWA, and other remote frontends consume the same file identity according to their own capabilities. Each Bridge adapter explicitly declares its supported media kinds, delivery modes, and size limits; plugin file contribution rules live in [Plugin development guide](PLUGINS_EN.md).

Local staged files are uploaded directly by platform adapters when possible: Telegram / Feishu / WeChat use their native upload flows, and QQ uses the official bot chunked-upload flow before sending `msg_type: 7` rich media. `preferences.bridge.mediaPublicBaseUrl` / `HANA_BRIDGE_PUBLIC_BASE_URL` are only for consumers or fallback paths that still require an internet-reachable URL.

The server runs as a standalone Node.js process (spawned by Electron or independently), bundled via Vite with @vercel/nft for dependency tracing. It communicates with the Electron renderer through WebSocket.
User data is rooted at `HANA_HOME` (production default `~/.hanaagent`, development launcher default `~/.hanaagent-dev`, both explicitly overridable). Hana-managed Pi SDK runtime resources live under `${HANA_HOME}/runtime/pi-sdk/`; Hana does not rely on Pi's global agent directory or `PI_CODING_AGENT_DIR`. Legacy `fd` / `rg` binaries under `${HANA_HOME}/.pi/agent/bin/` are copied into the new directory on first use of the corresponding search tool, while the legacy files remain untouched.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron 42 |
| Frontend | React 19 + Zustand 5 + CSS Modules |
| Build | Vite 7 |
| Server | Hono + @hono/node-server |
| Agent Runtime | [Pi SDK](https://github.com/badlogic/pi-mono) |
| Database | better-sqlite3 (WAL mode) |
| Testing | Vitest |
| i18n | 5 languages (zh / en / ja / ko / zh-TW) |
