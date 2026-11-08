# 目录与材料归属

[文档导航](../README.md) · [本地版本管理](LOCAL_RELEASES.md)

## 源码工作区

源码维护根以实际 Git 仓库为准。源码目录可以迁移，不代表应用、用户数据或另一台设备的部署目录需要同时移动。

| 目录或文件 | 用途与维护方式 |
| --- | --- |
| `core/`、`lib/`、`server/`、`hub/`、`desktop/`、`shared/`、`cli/` | 产品源码，按现有模块维护 |
| `packages/`、`plugins/`、`skills2set/`、`examples/` | SDK 包、内置插件/技能与示例；模块 README 就近保留 |
| `scripts/`、`tools/`、`tests/` | 构建、开发工具与测试 |
| `config/` | Vite、Vitest、ESLint 和辅助 TypeScript 配置；根 tsconfig.json 保留 IDE 与 SDK 包继承入口 |
| `docs/` | 公开的使用、开发和维护文档 |
| `build/` | 包含受版本控制的构建资源与契约清单，不能把整个目录当作临时产物删除 |
| `build/export-manifest.json`、`build/releases/release-digest.v*.json` | 受版本控制的导出清单和发行摘要，按构建脚本和打包清单维护 |
| `TaskFlowDocs/` | 本地任务计划、决策与验收记录，不公开提交 |
| `.local/` | 私有迁移试验、数据副本、备份与验收证据，不公开提交 |
| `.cache/`、`node_modules/`、`dist*`、`desktop/dist-*` | 依赖、缓存和构建输出，沿用构建脚本的现有路径；不公开提交 |
| `.worktrees/` | 本地隔离工作区，不公开提交 |

以上是目录职责，不是删除清单。`.local/` 中的备份与迁移数据、现有验收材料本轮全部保留原位；后续整理应先核对用途、运行引用和恢复需要。可重新生成的内容，也要确认已无使用者后再按明确任务处理。

## 应用与数据

| 对象 | 默认路径或约定 |
| --- | --- |
| 正式 macOS 应用 | `~/Applications/hanaagent.app` |
| 应用数据 | `HANA_HOME` 指定的位置，未指定时为 `~/.hanaagent` |
| 隔离开发数据 | 源码开发启动器（`npm start`、`npm run start:vite`、`npm run server`、`npm run cli`）默认使用 `~/.hanaagent-dev`；`HANA_HOME` 可覆盖 |
| 本地发行管理目录 | `~/zxdwhda/hanaagent/`，由管理脚本约定，与源码根分别判断 |
| 工作文件 | 选择应用数据目录之外的位置，避免随数据回退 |

应用归档、数据快照和恢复材料的具体子目录以[本地版本管理](LOCAL_RELEASES.md)为准。其他设备分别核对实际部署，不随本机源码搬迁修改。

## 新材料如何归位

- 可复用的公开说明进入 `docs/` 对应主题，并更新文档导航。
- 一次任务的计划、结果与证据入口沿用同一个 `TaskFlowDocs/tasks/<任务>/`。
- 私有证据、临时迁移副本和备份关联对应任务，避免混入公开文档。
- 历史记录保留当时路径与语境；新的维护入口指向当前文件。
- 移动文件时同步检查 Markdown 链接、技能/脚手架、测试和导出清单中的引用。
