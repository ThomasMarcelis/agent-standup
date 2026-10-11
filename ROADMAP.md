# Roadmap and research notes

What exists today, what was investigated, and what is deliberately not built yet.

## Works today
| Where | How |
|---|---|
| **VS Code** | Extension from the Marketplace (panel, side bar, status bar, localised commands). |
| **Cursor, Windsurf, VSCodium, other VS Code forks** | Install `agent-standup-<version>.vsix` from the GitHub release with *Extensions → … → Install from VSIX*. (Open VSX publication is wired up in `.github/workflows/publish.yml` and only needs an account token.) |
| **Any terminal** | `agent-standup` (npm package `@double_geste/agent-standup`): the local page in your browser, plus `status` and `statusline` for status bars (Claude Code status line, tmux, Neovim…). |
| **Desktop** | Small app for macOS (Apple Silicon and Intel, unsigned): window + menu bar indicator + notification when an agent may need you. Windows and Linux builds are set up in CI but untested. |
| **JetBrains IDEs** | Not native yet. Recipe: *Settings → Tools → External Tools → +*, program `npx`, arguments `-y @double_geste/agent-standup --open`, working directory `$ProjectFileDir$`; the call opens in your browser. |

## Other agent tools
Agent Standup reads Claude Code's transcripts, and since this fork also **Codex CLI** (`adapters/codex.js`, verified against codex-cli 0.162.1 rollouts: `session_meta`, `item_completed` items for commands, patches and MCP calls, `SubAgentActivity` for native sub-agents, `token_usage_record` deduplicated by response) and **Hermes Agent** (`adapters/hermes.js`, read-only SQLite per profile: `sessions`, `messages` with `active=1 or compacted=1`, `delegate_task` children by `parent_session_id`). Each adapter turns its store into the common event list (`say`, `tools`, `results`, `order`, `finish`, `usage`, `msg`…) and is chosen by the `proj` prefix (`_codex`, `_hermes[-profile]`); `adapters/peers.js` reads the messages agents send each other through agent-peers. Fixtures in `test/fixtures` are trimmed, anonymised real logs.

Remaining candidates, researched but not built (sources are third-party; verify against a real install first):

| Tool | Where logs live (per sources) | Fit |
|---|---|---|
| Gemini CLI | `~/.gemini/tmp/<project_hash>/chats/` | Official docs confirm the folder, tool I/O and tokens; file format to confirm on a real install. |
| OpenCode | `~/.local/share/opencode/` | Has explicit parent/child sessions and full token/cost data, but storage changed between versions (SQLite, then JSON, then SQLite again). |
| Amp | `~/.local/share/amp/threads/T-<uuid>.json` (community sources) | One JSON file per thread; small adapter, small user base. |
| Cline / Roo | VS Code `globalStorage/.../tasks/<id>/*.json` | Medium; no sub-agents found. |
| Aider, Cursor, Copilot agent mode | Markdown history / SQLite / undocumented | Poor fit: no structured tool calls, or undocumented databases. |

A good adapter design: one small module per tool turning its log into the common event list the UI already uses (`say`, `tools`, `results`, `order`, `finish`, `usage`…), selected by folder. Contributions are welcome; please attach a few anonymised sample logs.

## Rive characters (researched, not built)
Rive's web runtime is MIT-licensed and supports state machines (inputs like `isTalking`), but it ships WASM (needs `'wasm-unsafe-eval'` in the webview CSP), and, according to Rive's current pricing, **exporting `.riv` files needs a paid plan**, which limits who could author characters. The pixel-art feature (drop PNGs in `~/.agent-standup/characters`) covers the same need at zero cost. A Rive loader could be added later as an opt-in setting that takes a local `.riv` file.

## Other ideas
Voxtral (Mistral) voices with your own API key; a "corporate jargon" style for the little banter lines; cloud sessions; a native JetBrains plugin (needs JDK 17 and the IntelliJ Platform Gradle plugin).
