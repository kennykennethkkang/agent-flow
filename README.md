<!-- Switchboard: a VS Code hub to start, watch and talk to Claude Code and Codex chats, built on Agent Flow's live agent visualization. -->
# Switchboard

Switchboard is a VS Code hub for running and watching Claude Code and Codex chats across all your code projects. You start chats from one place, give each a role (lead, researcher, engineer and so on) so work can be delegated, and see what every chat is doing without switching windows.

## Credit

Switchboard is based on [Agent Flow](https://github.com/patoles/agent-flow) by Simon Patole, used under the Apache License 2.0. Agent Flow is a trademark of Simon Patole. Switchboard is not affiliated with or endorsed by the Agent Flow project. See [NOTICE](NOTICE) and [TRADEMARK.md](TRADEMARK.md).

## What it does

- **Always one click away.** An Activity Bar icon opens a sidebar view labeled Switchboard, with an Open in editor button. There is also a status bar button, and `Cmd+Option+A` opens it from anywhere, including a focused terminal.
- **New chat and roles.** Pick a project, pick a role (lead, researcher, engineer, qa, designer, ops, growth), and start a Claude Code or Codex chat. Both runtimes are supported.
- **Live chat map.** Every running chat shows as a bubble with its role and its tool calls as they happen.
- **Today card.** What ran today, at a glance.
- **Changes panel.** Files a chat changed, with inline diffs and an Open in VS Code diff button. Symlinks and paths outside the project are never shown.
- **Quick switcher.** `Cmd+K` jumps to any chat.
- **Full chats continue.** When a chat fills up, work continues in a new chat named "<name> v2", then "v3". The old one closes when idle and moves to History.
- **History.** Chains of versions, search over handoff notes, and resume.
- **Remote Control.** Servers per repo, and at startup.
- **Settings gear** in the app, and a link to the browser version.

## Coming next

In progress, not shipped yet:

- Sign-ins per project: AWS profiles with a default, rename, add, and a per-window override.
- Jev bubbles.

## Run it locally

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs the event relay on port 3001 and the web app on port 3010. http://localhost:3010 shows sample data only, for working on the page. Switchboard never uses port 3000.

The browser version with your real chats is the standalone app. VS Code's browser link finds it on any port:

```bash
pnpm build:app
node app/dist/app.js
```

Build and install the extension:

```bash
cd extension
pnpm run build:all && npx @vscode/vsce package --no-dependencies && code --install-extension switchboard-<version>.vsix --force
```

Then run **Developer: Reload Window** in VS Code.

Requirements: Node 20+, pnpm, VS Code 1.85+ (or a compatible editor), and the Claude Code CLI and/or Codex CLI.

## Moving to another computer

The [claude-mods](../claude-mods) repo carries a kit that sets up plugins, skills, rules, role agents, settings and the Switchboard VSIX on a new machine. Clone it next to this repo and run `node kit/setup.mjs`. Its README has a five step list. Keys and sign-ins never travel.

## What changed from Agent Flow

- The Hub and Switchboard UI replaced the canvas visualizer.
- Roles for delegating work between chats.
- Versions and History for chats that fill up.
- Remote Control.
- A settings gear in the app.
- The web app runs on port 3010.

## Commands and settings

| Command | What it does |
|---------|--------------|
| `Switchboard: Open` | Open Switchboard |
| `Switchboard: Open to the Side` | Open in a side editor column |
| `Switchboard: Connect to Running Agent` | Connect to a running session by hand |
| `Switchboard: Configure Claude Code Hooks` | Set up hooks for live streaming |

Setting ids keep the upstream `agentVisualizer.` prefix:

| Setting | Default | Description |
|---------|---------|-------------|
| `agentVisualizer.runtime` | `"auto"` | `"auto"` (both), `"claude"` or `"codex"` |
| `agentVisualizer.devServerPort` | `0` | Development server port (0 = production mode) |
| `agentVisualizer.eventLogPath` | `""` | JSONL event log file to watch |
| `agentVisualizer.autoOpen` | `false` | Open when an agent session starts |

For a non-default Codex install, set `CODEX_HOME`.

## About Agent Flow

Agent Flow is real-time visualization of Claude Code and Codex agent orchestration, created by [Simon Patole](https://github.com/patoles) for [Antics](https://antics.gg). Its hook server and Codex rollout reader are still the base of Switchboard's live data. The upstream project is at https://github.com/patoles/agent-flow.

## License

Apache 2.0. See [LICENSE](LICENSE).

The name "Agent Flow" and its logos are trademarks of Simon Patole. See [TRADEMARK.md](TRADEMARK.md).
