# Running and first setup

[Documentation](../README.md) · [中文](quick-start.md)

Version 0.450.1 is source-only; this project has no public installer yet. Upstream installers are a different distribution. Local validation has focused on macOS Apple Silicon; see the [maintenance scope (Chinese)](../maintenance/INDEPENDENT_MAINTENANCE.md).

## Run from source

Install Node.js 24 (reference version 24.15.0), npm, Git and the platform build tools listed in [Contributing](../../CONTRIBUTING.md). From the repository root:

```sh
npm ci
HANA_HOME="$HOME/.hanaagent-dev" npm start
```

The explicit development directory isolates this run from production data. In Windows PowerShell, set `$env:HANA_HOME = "$HOME/.hanaagent-dev"` before `npm start`. The development launcher used by `npm start`, `npm run start:vite`, `npm run server` and `npm run cli` defaults to `~/.hanaagent-dev` when `HANA_HOME` is unset. The production application defaults to `~/.hanaagent`. See the [directory guide (Chinese)](../maintenance/directories.md).

## First setup

On first launch, an onboarding wizard will guide you through setup: choose a language, enter your name, connect a model provider (API key + base URL), and select three models — a **chat model** (main conversation), a **utility model** (lightweight tasks), and a **utility large model** (memory compilation and deep analysis). In settings you can also choose a **vision model** that lets text-only chat models work with image attachments through Vision Bridge. HanaAgent supports OpenAI-compatible providers, Anthropic-style providers, OAuth providers, and local models via Ollama.


Provider support does not mean every integration has been validated by this maintainer. Keys and model configuration belong in the data directory, outside version control.

## Next steps

- [Features](features_EN.md)
- [Development and contributing](../../CONTRIBUTING.md)
- [Local builds, updates and rollback (Chinese)](../maintenance/LOCAL_RELEASES.md)
