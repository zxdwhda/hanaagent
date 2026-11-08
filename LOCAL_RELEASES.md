# 本地构建与版本管理

当前公开源码没有配套安装包。沿用Node24.15.0/npm与package-lock.json；先 `npm ci`，开发启动为 `npm start`，常规验证为 `npm run typecheck`、`npm run lint`、`npm test`。完整打包涉及服务端签名seed、平台helper与Electron输出，不能用客户端编译通过代替打包验收。

## 本地打包

macOS Apple Silicon的参考步骤：

```sh
npm ci
mkdir -p .local/signing
node scripts/artifact-keygen.mjs --out .local/signing/private.pem --key-id local-build > .local/signing/public-entry.json
node --input-type=module -e 'import fs from "node:fs";const v=JSON.parse(fs.readFileSync(".local/signing/public-entry.json","utf8"));fs.writeFileSync(".local/signing/keyset.json",JSON.stringify([v]));'
export HANA_SIGN_KEY="$PWD/.local/signing/private.pem"
export HANA_SIGN_KEYSET="$PWD/.local/signing/keyset.json"
npm run build:client
npm run build:computer-use-helper
npm run build:server
npm run verify:seed-kit
CSC_IDENTITY_AUTO_DISCOVERY=false SKIP_NOTARIZE=true npm exec --no -- electron-builder --dir --mac --arm64 --publish never -c.mac.identity=null
```

首次生成密钥后请保留，不要每次构建覆盖。私钥与运行数据不得提交。上例为本地ad hoc构建，不是Developer ID签名或公证。管理器要求 `codesign --verify --deep --strict` 通过；打包后应先检查签名，失败时修复/重新签名后再安装，不能绕过校验。

## 固定目录

- 正式应用：`~/Applications/hanaagent.app`。
- 数据：`~/.hanaagent`，开发环境默认独立目录。
- 工作文件：选择应用数据目录之外的位置。
- 管理目录：`~/zxdwhda/hanaagent/`。
- 历史应用：`archives/<treehash>.tar.gz`；`releases/<id>/`仅保存元数据。
- 数据回退快照：`checkpoints/`；临时应用解包：`staging.noindex/`。

不要覆盖作者的 `/Applications/HanaAgent.app` 或直接导入作者新版数据目录。

## 安装、更新、回退

```sh
node scripts/managed-release.mjs install --app /path/hanaagent.app
node scripts/managed-release.mjs pack --app /path/hanaagent.app --output "$HOME/hanaagent-update.tar.gz"
node scripts/managed-release.mjs stop
node scripts/managed-release.mjs update --app "$HOME/hanaagent-update.tar.gz"
node scripts/managed-release.mjs start
node scripts/managed-release.mjs rollback
node scripts/managed-release.mjs start
node scripts/managed-release.mjs status
node scripts/managed-release.mjs recover
```

`pack`输出路径必须位于当前用户目录下且尚不存在。更新支持tar.gz归档及.app。相同内容共用一份归档；应用身份、codesign、压缩文件checksum和还原后树哈希均需通过。不要为了每次演练制造新版本标签；`--release-id`用于确有必要的记录，同包标签不是新产品版本。

安装自动生成 `manage.command`、`start.command`、`status.command`、`rollback.command`。双击入口还需把兼容Node24可执行文件放在管理目录的 `runtime/node`；也可始终从源码目录用Node运行管理脚本。更新和回退完成后保持停止状态，用“启动”重新打开。

回退恢复对应应用与数据快照，先保存回退前的当前数据。工作文件不在home内，不随数据库回退。异常中断用recover；不要删除恢复材料。`compact`可不停现用应用，把旧releases及管理目录incoming里的散装.app迁移为归档；成功导入的managed incoming.app自动整理，外部输入文件不擅自删除。只有正式目录保留可用应用入口。

与作者版不做双向数据同步。迁移、渠道切换和跨epoch转换需单独验收，不由以上命令自动保证。
