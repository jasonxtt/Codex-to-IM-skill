# Codex-to-IM Skill

Bridge Claude Code / Codex to IM platforms — chat with AI coding agents from Telegram, Discord, Feishu/Lark, QQ, or WeChat.

[中文文档](README_CN.md)

> **Want a desktop GUI instead?** Check out [CodePilot](https://github.com/op7418/CodePilot) — a full-featured desktop app with visual chat interface, session management, file tree preview, permission controls, and more. This skill was extracted from CodePilot's IM bridge module for users who prefer a lightweight, CLI-only setup.

This repository is self-contained. You only need `https://github.com/jasonxtt/Codex-to-IM-skill` to install and run it; no extra `Claude-to-IM` repository is required.

---

## How It Works

This skill runs a background daemon that connects your IM bots to Claude Code or Codex sessions. Messages from IM are forwarded to the AI coding agent, and responses (including tool use, permission requests, streaming previews) are sent back to your chat.

```
You (Telegram/Discord/Feishu/QQ/WeChat)
  ↕ Bot API
Background Daemon (Node.js)
  ↕ Claude Agent SDK or Codex SDK (configurable via CTI_RUNTIME)
Claude Code / Codex → reads/writes your codebase
```

## Features

- **Five IM platforms** — Telegram, Discord, Feishu/Lark, QQ, WeChat — enable any combination
- **Interactive setup** — guided wizard collects tokens with step-by-step instructions
- **Permission control** — tool calls require explicit approval via inline buttons (Telegram/Discord) or text `/perm` commands / quick `1/2/3` replies (Feishu/QQ/WeChat)
- **Streaming preview** — see Claude's response as it types (Telegram & Discord)
- **Session persistence** — conversations survive daemon restarts
- **Secret protection** — tokens stored with `chmod 600`, auto-redacted in all logs
- **Zero code required** — install the skill and run `/codex-to-im setup`, or tell Codex `codex-to-im setup`

## Prerequisites

- **Node.js >= 20**
- **Claude Code CLI** (for `CTI_RUNTIME=claude` or `auto`) — installed and authenticated (`claude` command available)
- **Codex CLI** (for `CTI_RUNTIME=codex` or `auto`) — `npm install -g @openai/codex`. Auth: run `codex auth login`, or set `OPENAI_API_KEY` (optional, for API mode)

## Installation

Choose the section that matches the AI agent product you actually use.

### Claude Code

#### Recommended: `npx skills`

```bash
npx skills add jasonxtt/Codex-to-IM-skill
```

After installation, tell Claude Code:

```text
/codex-to-im setup
```

If you want WeChat specifically, you can also say:

```text
帮我接微信
```

#### Alternative: clone directly into Claude Code skills

```bash
git clone https://github.com/jasonxtt/Codex-to-IM-skill.git ~/.claude/skills/codex-to-im
```

Claude Code discovers it automatically.

#### Alternative: symlink for development

```bash
git clone https://github.com/jasonxtt/Codex-to-IM-skill.git ~/code/Codex-to-IM-skill
mkdir -p ~/.claude/skills
ln -s ~/code/Codex-to-IM-skill ~/.claude/skills/codex-to-im
```

### Codex

#### Recommended: use the Codex install script

```bash
git clone https://github.com/jasonxtt/Codex-to-IM-skill.git ~/code/Codex-to-IM-skill
bash ~/code/Codex-to-IM-skill/scripts/install-codex.sh
```

For local development with a live checkout:

```bash
bash ~/code/Codex-to-IM-skill/scripts/install-codex.sh --link
```

The install script places the skill under `~/.codex/skills/codex-to-im`, installs dependencies, and builds the daemon.

`--link` keeps `~/.codex/skills/codex-to-im` as a symlink to your working tree, so edits in your local repo take effect after rebuilds. Without `--link`, the script copies the repo into Codex's skills directory as a standalone install.

After installation, tell Codex:

```text
codex-to-im setup
```

If you want WeChat specifically, you can also say:

```text
帮我接微信桥接
```

#### Alternative: clone directly into Codex skills

```bash
git clone https://github.com/jasonxtt/Codex-to-IM-skill.git ~/.codex/skills/codex-to-im
cd ~/.codex/skills/codex-to-im
npm install
npm run build
```

### Verify installation

**Claude Code:** Start a new session and type `/` — you should see `codex-to-im` in the skill list. Or ask Claude: "What skills are available?"

**Codex:** Start a new session and say `codex-to-im setup`, `start bridge`, or `帮我接微信桥接`.

No second bridge repository should be cloned anywhere during install. If you see references to `Claude-to-IM`, your local install is stale and should be reinstalled from this repo.

## Updating the Skill

Choose the update flow that matches both your AI agent product and your installation method.

### Claude Code

If you installed with `npx skills`, re-run:

```bash
npx skills add jasonxtt/Codex-to-IM-skill
```

If you installed via `git clone` or symlink:

```bash
cd ~/.claude/skills/codex-to-im
git pull
npm install
npm run build
```

Then tell Claude Code:

```text
/codex-to-im doctor
/codex-to-im start
```

### Codex

If you installed with the Codex install script in copy mode:

```bash
rm -rf ~/.codex/skills/codex-to-im
bash ~/code/Codex-to-IM-skill/scripts/install-codex.sh
```

If you installed with `--link` or cloned directly into the Codex skills directory:

```bash
cd ~/.codex/skills/codex-to-im
git pull
npm install
npm run build
```

Then tell Codex:

```text
codex-to-im doctor
start bridge
```

## Quick Start

### 1. Setup

**Claude Code**

```text
/codex-to-im setup
```

**Codex**

```text
codex-to-im setup
```

The wizard will guide you through:

1. **Choose channels** — pick Telegram, Discord, Feishu, QQ, WeChat, or any combination
2. **Enter credentials** — the wizard explains exactly where to get each token, which settings to enable, and what permissions to grant
3. **Set defaults** — working directory, model, and mode
4. **Validate** — tokens are verified against platform APIs immediately

### 2. Start

**Claude Code**

```text
/codex-to-im start
```

**Codex**

```text
start bridge
```

The daemon starts in the background. You can close the terminal — it keeps running.

### 3. Chat

Open your IM app and send a message to your bot. Claude Code / Codex will respond through the bridge.

When Claude needs to use a tool (edit a file, run a command), you'll see a permission prompt with **Allow** / **Deny** buttons right in the chat (Telegram/Discord), or a text `/perm` command prompt / quick `1/2/3` replies (Feishu/QQ/WeChat).

## Commands

All commands are run inside Claude Code or Codex:

| Claude Code | Codex (natural language) | Description |
|---|---|---|
| `/codex-to-im setup` | "codex-to-im setup" / "配置" | Interactive setup wizard |
| `/codex-to-im start` | "start bridge" / "启动桥接" | Start the bridge daemon |
| `/codex-to-im stop` | "stop bridge" / "停止桥接" | Stop the bridge daemon |
| `/codex-to-im status` | "bridge status" / "状态" | Show daemon status |
| `/codex-to-im logs` | "查看日志" | Show last 50 log lines |
| `/codex-to-im logs 200` | "logs 200" | Show last 200 log lines |
| `/codex-to-im reconfigure` | "reconfigure" / "修改配置" | Update config interactively |
| `/codex-to-im doctor` | "doctor" / "诊断" | Diagnose issues |

### Codex Runtime Permissions

When `CTI_RUNTIME=codex`, the following environment variables control sandbox permissions:

| Variable | Values | Default | Risk |
|----------|--------|---------|------|
| `CTI_CODEX_SANDBOX_MODE` | `read-only`, `workspace-write`, `danger-full-access` | SDK default | ⚠️ High |
| `CTI_CODEX_APPROVAL_POLICY` | `untrusted`, `on-request`, `on-failure`, `never` | Derived from `permissionMode` | ⚠️ High |
| `CTI_CODEX_NETWORK_ACCESS` | `true`, `false` | `false` | Medium |
| `CTI_CODEX_ADDITIONAL_DIRECTORIES` | Comma-separated absolute paths | (none) | Medium |

#### Safe Default Configuration

```env
CTI_RUNTIME=codex
CTI_CODEX_SANDBOX_MODE=workspace-write
CTI_CODEX_APPROVAL_POLICY=on-request
CTI_CODEX_NETWORK_ACCESS=false
```

#### ⚠️ Danger Zone

```env
# ONLY for fully trusted private environments!
CTI_CODEX_SANDBOX_MODE=danger-full-access
CTI_CODEX_APPROVAL_POLICY=never
CTI_CODEX_NETWORK_ACCESS=true
```

Never use the danger zone configuration in public or shared environments.

## Platform Setup Guides

The `setup` wizard provides inline guidance for every step. Here's a summary:

### Telegram

1. Message `@BotFather` on Telegram → `/newbot` → follow prompts
2. Copy the bot token (format: `123456789:AABbCc...`)
3. Recommended: `/setprivacy` → Disable (for group use)
4. Find your User ID: message `@userinfobot`

### Discord

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. Bot tab → Reset Token → copy it
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. OAuth2 → URL Generator → scope `bot` → permissions: Send Messages, Read Message History, View Channels → copy invite URL

### Feishu / Lark

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) (or [Lark](https://open.larksuite.com/app))
2. Create Custom App → get App ID and App Secret
3. **Batch-add permissions**: go to "Permissions & Scopes" → use batch configuration to add all required scopes (the `setup` wizard provides the exact JSON)
4. Enable Bot feature under "Add Features"
5. **Events & Callbacks**: select **"Long Connection"** as event dispatch method → add `im.message.receive_v1` event
6. **Publish**: go to "Version Management & Release" → create version → submit for review → approve in Admin Console
7. **Important**: The bot will NOT work until the version is approved and published

### QQ

> QQ currently supports **C2C private chat only**. No group/channel support, no inline permission buttons, no streaming preview. Permissions use text `/perm ...` commands. Image inbound only (no image replies).

1. Go to [QQ Bot OpenClaw](https://q.qq.com/qqbot/openclaw)
2. Create a QQ Bot or select an existing one → get **App ID** and **App Secret** (only two required fields)
3. Configure sandbox access and scan QR code with QQ to add the bot
4. `CTI_QQ_ALLOWED_USERS` takes `user_openid` values (not QQ numbers) — can be left empty initially
5. Set `CTI_QQ_IMAGE_ENABLED=false` if the underlying provider doesn't support image input

### WeChat / Weixin

> WeChat currently uses QR login, single-account mode, text-based permissions, and no streaming preview.

1. Run the local QR helper from your installed skill directory:
   - Claude Code default install: `cd ~/.claude/skills/codex-to-im && npm run weixin:login`
   - Codex default install: `cd ~/.codex/skills/codex-to-im && npm run weixin:login`
2. The helper writes `~/.codex-to-im/runtime/weixin-login.html` and tries to open it in your browser automatically
3. Scan the QR code with WeChat and confirm on your phone
4. On success, the linked account is stored in `~/.codex-to-im/data/weixin-accounts.json`
5. Running the helper again replaces the previously linked WeChat account

Additional notes:

- `CTI_WEIXIN_MEDIA_ENABLED` controls inbound image/file/video downloads only
- Voice messages only use WeChat's own built-in speech-to-text text
- If WeChat does not provide `voice_item.text`, the bridge replies with an error instead of downloading/transcribing raw voice audio
- Permission approvals use text `/perm ...` commands or quick `1/2/3` replies

## Architecture

```
~/.codex-to-im/
├── config.env             ← Credentials & settings (chmod 600)
├── data/                  ← Persistent JSON storage
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   └── messages/          ← Per-session message history
├── logs/
│   └── bridge.log         ← Auto-rotated, secrets redacted
└── runtime/
    ├── bridge.pid          ← Daemon PID file
    └── status.json         ← Current status
```

### Key components

| Component | Role |
|---|---|
| `src/main.ts` | Daemon entry — assembles DI, starts bridge |
| `src/config.ts` | Load/save `config.env`, map to bridge settings |
| `src/store.ts` | JSON file BridgeStore (30 methods, write-through cache) |
| `src/llm-provider.ts` | Claude Agent SDK `query()` → SSE stream |
| `src/codex-provider.ts` | Codex SDK `runStreamed()` → SSE stream |
| `src/sse-utils.ts` | Shared SSE formatting helper |
| `src/permission-gateway.ts` | Async bridge: SDK `canUseTool` ↔ IM buttons |
| `src/logger.ts` | Secret-redacted file logging with rotation |
| `scripts/daemon.sh` | Process management (start/stop/status/logs) |
| `scripts/doctor.sh` | Health checks |
| `SKILL.md` | Claude Code skill definition |

### Permission flow

```
1. Claude wants to use a tool (e.g., Edit file)
2. SDK calls canUseTool() → LLMProvider emits permission_request SSE
3. Bridge sends inline buttons to IM chat: [Allow] [Deny]
4. canUseTool() blocks, waiting for user response (5 min timeout)
5. User taps Allow → bridge resolves the pending permission
6. SDK continues tool execution → result streamed back to IM
```

## Troubleshooting

Run diagnostics:

```
/codex-to-im doctor
```

This checks: Node.js version, config file existence and permissions, token validity (live API calls), log directory, PID file consistency, and recent errors.

| Issue | Solution |
|---|---|
| `Bridge won't start` | Run `doctor`. Check if Node >= 20. Check logs. |
| `Messages not received` | Verify token with `doctor`. Check allowed users config. |
| `Permission timeout` | User didn't respond within 5 min. Tool call auto-denied. |
| `Stale PID file` | Run `stop` then `start`. daemon.sh auto-cleans stale PIDs. |

See [references/troubleshooting.md](references/troubleshooting.md) for more details.

## Security

- All credentials stored in `~/.codex-to-im/config.env` with `chmod 600`
- Tokens are automatically redacted in all log output (pattern-based masking)
- Allowed user/channel/guild lists restrict who can interact with the bot
- The daemon is a local process with no inbound network listeners
- See [SECURITY.md](SECURITY.md) for threat model and incident response

## Development

```bash
npm install        # Install dependencies
npm run dev        # Run in dev mode
npm run typecheck  # Type check
npm test           # Run tests
npm run build      # Build bundle
```

## License

[MIT](LICENSE)
