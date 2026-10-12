# Agent Standup (personal fork)

One live overview of every AI agent on this machine: **Claude Code**, **Codex CLI** and **Hermes** (all profiles), and the **agent-peers** messages they send each other. It reads the files those tools already write, changes nothing, and runs locally.

This is Tom's personal fork of [Atoll92/agent-standup](https://github.com/Atoll92/agent-standup) (MIT). It is not published to npm or the Marketplace and is not meant for upstream as is.

## Run it

```sh
cd ~/workspace/agent-standup && node server.js
```

Or install the command once (it links this clone, so `git pull` updates it):

```sh
cd ~/workspace/agent-standup && npm link
agent-standup
```

Then open <http://localhost:4747>. `PORT=4790 node server.js` picks another port. Node 22.5+ (Hermes is read with the built-in `node:sqlite`); there is nothing to install.

## What it shows

- **Sessions board** (the default view): every recent session across the three runtimes, one card each, the top line says *Nobody needs you* or *N need you*, then cards ranked needs you → working → finished → idle. Cards are grouped by **project**: the git root of the session's folder (a worktree counts as its parent repo), or for Hermes the profile plus the Discord thread. One colour per project, one-off and non-repo runs last under *Other*. Each card shows the session's functional name, one status dot with plain words (what it is doing now), active sub-agents and *Talks to …* (the last 10 minutes). No raw commands or ids. Click a card to open its call.
- **Call**: one session as a team call. The header names the project in its colour. Every agent wears its project's colour as a tee: the project's name across the chest with the agent's role under it (lead, its task or path leaf), a badge with its initials, sleeve stripes; a peer from another project wears its own); your shirt says `Tom` with a gold collar and a star (`OWNER` in `public/index.html`). Each tile says what the agent is doing right now; the shared screen shows the real command and output, the file read or the diff applied. Only the session's own team has desks; an agent of another session in a current exchange (a message either way in the last 10 minutes) is a chip on the *On the line* strip, in its project's colour, with its message count, lit up when its message plays; click it to open its session. Every message is in the transcript with its delivery state (📨 taken by the inbox, ✋ held, ✗ refused, 📥 received).
- **Project switcher** (click the project name in the call header): *Everything* or one project, each with its live counts (calls, agents working, needs you). *Everything* (the default) goes to a call that needs you, else the most active one, with a 20 s hold; a project stays in that project. A short toast says why it switched.
- **Calls rail** (left of the call): only what is live (working or active in the last 5 minutes, needing you, or the call you are in). *Needs you* on top, then calls by project, each row its full title and a plain status (*Working: running tests*, *Waiting on …*, *Finished*, *Idle 10 min*); the rest folds into one *+N quiet*. Click a call to join and pin it; *📌 unpin* on the pinned row.
- **Shared screen**: the centre of the call shows what an agent is doing (command and output, the page or image, the diff). A call opened in a quiet moment shows its last screen, dimmed, with the time it was shared.
- **Tree** (T): the lead and its sub-agents at every depth, with status, tool counts and current action. Sub-agents always sit under their root.
- **Agent detail** (click a tile or a tree row): the task it was given, its tools, recent activity, its messages, and *Open this session* for a peer that lives elsewhere on this machine.
- **Transcript** (L), **replay and recap** (R), **Ctrl/Cmd+K** to jump to any session, **J/K** for the next agent that needs you, **?** for all shortcuts.

**Names are functional**: a Codex root is named by its thread name (or its first prompt without the model/effort boilerplate), a Codex sub-agent by its `agent_path` leaf ("escape stair") with its kind (worker, explorer) as the role, a Claude sub-agent by the task it was given, a Hermes delegate by its goal. Its full path and Codex's invented nickname only appear in the detail header.

**Sound and voice**: a sound plays only when an agent newly needs you. In a live call the picture stays current and a *voice director* decides what you hear: the lines waiting to be heard go in one batch to a small model (`gpt-6-luna` through the local codex-lb proxy, reasoning effort pinned, `AGENT_STANDUP_LUNA_EFFORT`), with what was already said and the session on screen; it drops what is not worth saying and writes at most two short neutral sentences, merging related lines. Rules it cannot break: a line that needs you is never dropped, nothing older than 45 s (2 min for reports and needs-you) is sent or said, one voice at a time, never cut mid-sentence; on an error or after 20 s a local pick (needs-you, then reports, then messages, whole sentences) is used. Replays read each line, a long one as a one-sentence summary. ElevenLabs reads only the chosen lines. Messages between agents start with a short spoken route ("Gladiator lead, from Codex"); everything else is content only. There is no verbosity setting: it narrates everything it can keep up with. Switching calls lets the line being said finish; only pause, mute, seek or a language change stops it. With ElevenLabs a line that fails (busy after one retry, quota, no key) is skipped and marked *not read aloud*, never said in a system voice, and the voice button says why. The first click or key anywhere turns sound on (browsers block it until then). `?debug=voice` logs every start and stop with its reason. Mute with M.

## Where the data comes from

All read-only; nothing is written to any agent store.

| Source | Read from |
|---|---|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` and its `subagents/` (`CLAUDE_CONFIG_DIR` honoured); live sessions from `~/.claude/sessions/<pid>.json` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` of the last 7 days (`CODEX_HOME` honoured), thread names from `~/.codex/session_index.jsonl`; native sub-agents are their own rollouts linked by `parent_thread_id`. Encrypted agent-to-agent bodies are never decrypted. |
| Hermes | `~/.hermes/state.db` and `~/.hermes/profiles/*/state.db`, opened read-only; `delegate_task` children are the sub-agents |
| agent-peers | Claude `SendMessage` to `uds:` addresses and `<cross-session-message>` arrivals, Codex/Hermes `send_peer` calls and `<peer_message>` arrivals, joined by address and message id |
| ElevenLabs | key `ELEVENLABS_API_KEY` from the environment or `~/.hermes/profiles/gaming/.env` (`HERMES_HOME` names another profile); model and lead voice from that profile's `config.yaml` (`tts.elevenlabs`). Currently `eleven_v4_turbo`. Server-side only; audio cached on disk per model, voice and text. |

The server listens on `127.0.0.1` only and refuses non-local Host/Origin headers. Nothing leaves the machine except, while unmuted, the lines to be spoken (to codex-lb for the triage, and the chosen ones to ElevenLabs) (and the optional upstream extras: French translation through your `claude` CLI, the FIP radio).

## Checks

Browser QA should run its own server with `AGENT_STANDUP_PREFS=<a scratch file>` so it does not change Tom's settings.


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
