# Agent Standup (personal fork)

One live overview of every AI agent on this machine: **Claude Code**, **Codex CLI** and **Hermes** (all profiles), and the **agent-peers** messages they send each other. It reads the files those tools already write, changes nothing, and runs locally.

This is Tom's personal fork of [Atoll92/agent-standup](https://github.com/Atoll92/agent-standup) (MIT). It is not published to npm or the Marketplace and is not meant for upstream as is.

## Run it

```sh
cd ~/workspace/agent-standup && node server.js
```

Then open <http://localhost:4747>. `PORT=4790 node server.js` picks another port. Node 22.5+ (Hermes is read with the built-in `node:sqlite`); there is nothing to install.

## What it shows

- **Sessions board** (the default view): every recent session across the three runtimes, one card each, ranked blocked → busy → your turn → done. Cards are grouped by **project**: the git root of the session's folder (a worktree counts as its parent repo), or for Hermes the profile plus the Discord thread. One colour per project, one-off and non-repo runs last under *Other*. Each card shows the session's functional name, its state, the tool it is running and on what, its age, active sub-agents and who it talks to. Click a card to open its call.
- **Call**: one session as a team call. The header names the project in its colour. Every agent wears its project's colour with the project's name on its shirt (a peer from another project wears its own); your shirt says `Tom` (`OWNER` in `public/index.html`). Each tile says what the agent is doing right now; the shared screen shows the real command and output, the file read or the diff applied. Agents from other sessions that exchanged messages join as participants, with the message and its delivery state (📨 taken by the inbox, ✋ held, ✗ refused, 📥 received).
- **Tree** (T): the lead and its sub-agents at every depth, with status, tool counts and current action. Sub-agents always sit under their root.
- **Agent detail** (click a tile or a tree row): the task it was given, its tools, recent activity, its messages, and *Open this session* for a peer that lives elsewhere on this machine.
- **Transcript** (L), **replay and recap** (R), **Ctrl/Cmd+K** to jump to any session, **J/K** for the next agent that needs you, **?** for all shortcuts.

**Names are functional**: a Codex root is named by its thread name (or its first prompt without the model/effort boilerplate), a Codex sub-agent by its `agent_path` leaf ("escape stair") with its kind (worker, explorer) as the role, a Claude sub-agent by the task it was given, a Hermes delegate by its goal. Its full path and Codex's invented nickname only appear in the detail header.

**Sound and voice**: a sound plays only when an agent newly needs you. The voice is ElevenLabs by default and reads content only (no names, labels, routing, delivery state or "From X:" openers), in whole sentences. When activity outpaces it, it never reads a line more than 12 s behind the newest event: it jumps to the freshest lines instead. Invented chatter is off (⚙ to turn it on). Mute with M.

## Where the data comes from

All read-only; nothing is written to any agent store.

| Source | Read from |
|---|---|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` and its `subagents/` (`CLAUDE_CONFIG_DIR` honoured); live sessions from `~/.claude/sessions/<pid>.json` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` of the last 7 days (`CODEX_HOME` honoured), thread names from `~/.codex/session_index.jsonl`; native sub-agents are their own rollouts linked by `parent_thread_id`. Encrypted agent-to-agent bodies are never decrypted. |
| Hermes | `~/.hermes/state.db` and `~/.hermes/profiles/*/state.db`, opened read-only; `delegate_task` children are the sub-agents |
| agent-peers | Claude `SendMessage` to `uds:` addresses and `<cross-session-message>` arrivals, Codex/Hermes `send_peer` calls and `<peer_message>` arrivals, joined by address and message id |
| ElevenLabs | key `ELEVENLABS_API_KEY` from the environment or `~/.hermes/profiles/gaming/.env` (`HERMES_HOME` names another profile); model and lead voice from that profile's `config.yaml` (`tts.elevenlabs`). Server-side only; audio cached on disk per voice and text; system voices if there is no key. |

The server listens on `127.0.0.1` only and refuses non-local Host/Origin headers. Nothing leaves the machine except ElevenLabs speech while unmuted (and the optional upstream extras: French translation through your `claude` CLI, the FIP radio).

## Checks

```sh
npm test                  # adapters, peers, project grouping, speech, server
npm run i18n              # locale files complete
npm run check:placement   # every busy session on this machine's board has a project (exit 1 if not)
```

## Known limits

- "Needs you" is a heuristic: no runtime records permission prompts.
- Codex messages sent before the agent-peers `msg_id` change is installed pair with the other end by address, time and text only.
- A Claude session that exited resolves by name only while an arrival from it is in the viewed transcript; a Hermes inbox outside the recent sessions' own `send_peer` rows stays unresolved (labelled so).
- Hermes has no per-message token usage: one session total, kept out of the context gauge.
- Live Codex "turn" vs "idle" relies on the thread lock file in `~/.codex/thread-writer-locks`.

The upstream features (VS Code extension, CLI and desktop builds, video export, characters, other voices, office music) are still in the code and work as upstream documents them; see the [upstream README](https://github.com/Atoll92/agent-standup#readme). Changes in this fork are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, © Atoll92 and contributors.
