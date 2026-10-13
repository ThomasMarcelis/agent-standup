# Agent Standup (personal fork)

One live overview of every AI agent on this machine: **Claude Code**, **Codex CLI** and **Hermes** (all profiles), and the **agent-peers** messages they send each other. It reads the files those tools already write, changes nothing, and runs locally.

This is Tom's personal fork of [Atoll92/agent-standup](https://github.com/Atoll92/agent-standup) (MIT). It is not published to npm or the Marketplace and is not meant for upstream as is.

## Run it

Install the command once (it links this clone, so `git pull` updates it), then run it from any folder:

```sh
cd ~/workspace/agent-standup && npm link
agent-standup                 # the server on http://localhost:4747
agent-standup --port 4790     # another port (or PORT=4790)
agent-standup status          # ✋ needs you, ⚙ working, ✓ finished, across all three runtimes
```

`node server.js` in the clone does the same as `agent-standup`. Node 22.5+ (Hermes is read with the built-in `node:sqlite`); there is nothing to install. There is no setup for the voice either: when a Hermes ElevenLabs key exists, it is used.

## What it shows

- **Sessions board**: every recent session, grouped by project, one card each, ranked needs you, working, finished, idle. The top line says *Nobody needs you* or *N need you*.
- **One call per project**: every live session placed in a project joins that project's call, whatever its runtime, with all its sub-agents, each session's agents under their own lead.
  - Claude Code and Codex sessions are placed by their repository: the git root of their folder, with worktrees and local-origin worker clones grouped under the owning repository. Nested local clones follow their origin chain; unrelated repositories are not merged merely because they share a remote URL.
  - A Hermes thread with no folder is placed by the sessions it messages and the repositories its tools work in.
  - *On the line* is only for sessions of other projects that messaged in during the last 10 minutes.
- **The call's screen**:
  - **Centre**: up to four shared screens at once (one fills the view, two side by side, three or four in a 2×2). They are the agents with real activity now: a command running, or their last event within 20 s. Each is labelled with who shares it ("Fatigue build, sub-agent of gladiator lead") and its model. With nothing active, the last screen stays up, dimmed.
  - **Side panel**: the project's workers as a graph. Each worker is a dot sized by its tokens and coloured by its state. Lines link a sub-agent to whoever started it, and message lines get thicker the more two workers talk; a dot runs along one when a message is sent. Other projects' guests sit at the rim. Hover a dot for its model; click it to open its detail.
  - **Bottom**: the team as a compact bar of tiles. Each tile has its project's shirt with its role, its model and its status dot, and the speaker is highlighted.
  - The **transcript** is closed by default, behind the *Transcript ▸* tab, ☰ or L.
- **Header**:
  - The project switcher always says what the call follows: *Following everything*, *Following gladiator-game* or *Pinned: <call>*. *Everything* goes to whoever needs you, else to the busiest project: the agents at work across all its sessions and sub-agents. It moves only when another project is clearly busier, after a 20 s hold. Every automatic switch says why, in a toast and a line in the transcript.
  - In *Everything*, the voice narrates every live project, not only the call on screen. A line about another project starts with its name ("MarketSimulator: …").
  - The sound control, below.
- **Calls rail** (left): only what is live, *Needs you* on top, then the calls by project; every session of the call on screen is marked. Each row has a dot and a plain word: *Running tests*, *Needs you: …*, *Waiting on …*, *Finished*, *Idle 10 min*. Click a call to pin it, and use *📌 unpin* to follow again.
- **Tree** (T), **agent detail** (click a tile, a dot or a screen), **replay and recap** (R), **Ctrl/Cmd+K** to jump to any session, **J/K** for the next agent that needs you, **?** for all shortcuts.

**Names are functional**:
- Codex: a root by its thread name or first prompt; a sub-agent by its `agent_path` leaf.
- Claude: a sub-agent by its task.
- Hermes: a delegate by its goal.
- Every tile, row and card says the model it runs on.
- A sub-agent stays in the call until 10 minutes after its own last event, and comes back whenever it acts again; silent for 10 minutes, it is finished, whatever it did last.
- A lead whose sub-agents are working is *waiting on* them, never *finished*.
- Scheduled one-shot reports stay out of calls and the rail. Active `codex exec` workers are included while working, waiting or blocked; finished one-offs are hidden. A project call includes every live session on the board, without a six-session cutoff.

## Sound and voice

**One sound control** in the header, always in words:

| State | Means |
|---|---|
| 🔊 *Sound on* | lit; level bars while a line plays |
| 🔇 *Muted* | M to unmute; the mute is remembered |
| ⚠ *Click anywhere for sound* | the browser holds sound back until a click |
| ⚠ *ElevenLabs: <why>* | ElevenLabs cannot speak right now |
| 🔈 *Sound in another window* | click to play it here |
| 🔇 *Voice off* | only from an older window's saved settings |

A silent state also prefixes the tab's title. One click, or M, goes from any silent state to sound on.

**ElevenLabs is automatic**:
- The key is `ELEVENLABS_API_KEY` from `$HERMES_HOME/.env` when `HERMES_HOME` is set; otherwise from `~/.hermes/profiles/gaming/.env`, then `~/.hermes/.env`.
- The model and the lead's voice come from the same folder's `config.yaml` (`tts.elevenlabs`).
- While a key exists, no other voice ever speaks: a line ElevenLabs cannot make is skipped and marked *not read aloud*.

**What you hear**: a sound plays when an agent newly needs you. In a live call, a voice director chooses the lines:
- **Batches**: the lines waiting to be said go in batches to a small model (`gpt-6-luna` through the local codex-lb, effort `AGENT_STANDUP_LUNA_EFFORT`, medium by default).
- **Narration**: it says almost everything, up to 4 short lines a batch while the queue is short, and thins out only under a real backlog.
- **Sources**: reports and messages, what an agent is doing (from the real command, its purpose, the file and the task it serves), sub-agents starting and finishing, commits and test results. After 20 s of quiet while agents work, one line on what is going on now.
- **Banned lines**: generic ones such as *running a script* are never said.
- **Hard rules**: needs-you is never dropped, nothing stale is said (45 s, 2 min for reports), one voice at a time, never cut mid-sentence.
- **Routes**: messages between agents start with a short spoken route ("Gladiator lead, from Codex").
- **Debugging**: `?debug=voice` logs every line's start and stop.

**One voice per project**:
- Every agent of a project speaks in the project's voice: leads and sub-agents, Claude, Codex and Hermes alike. In *Everything*, a line about another project is heard in that project's voice.
- A project keeps the voice it got first, across restarts (saved in the settings). A new project gets a voice no other live project has, while there are enough voices.
- The voice's name is shown small next to the project: in the header (*voice Roger*), the switcher and the rail's project headers.
- To change it: ⚙ › Sound › *Voice of <project>*. The choice sticks.

**Even loudness**: each clip is measured once when it is decoded (RMS over its non-silent 50 ms blocks) and brought to -20 dBFS. The gain is capped so the peak stays under -1 dBFS and never goes past 18 dB up. A gentle compressor on the voice output catches the rest. On ten real ElevenLabs voices, the spread went from 10.3 dB to 1.7 dB.

## Where the data comes from

All read-only; nothing is written to any agent store.

| Source | Read from |
|---|---|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` and its `subagents/` (`CLAUDE_CONFIG_DIR` honoured); live sessions from `~/.claude/sessions/<pid>.json` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` of the last 7 days (`CODEX_HOME` honoured), thread names from `~/.codex/session_index.jsonl`; native sub-agents are their own rollouts linked by `parent_thread_id`. Encrypted agent-to-agent bodies are never decrypted. |
| Hermes | `~/.hermes/state.db` and `~/.hermes/profiles/*/state.db`, opened read-only; `delegate_task` children are the sub-agents |
| agent-peers | Claude `SendMessage` to `uds:` addresses and `<cross-session-message>` arrivals, Codex/Hermes `send_peer` calls and `<peer_message>` arrivals, joined by address and message id |

The server listens on `127.0.0.1` only and refuses non-local Host/Origin headers. Nothing leaves the machine except, while unmuted:
- the lines to be spoken, to codex-lb, which chooses them;
- the chosen lines, to ElevenLabs.

## Checks

Browser QA should run its own server with `AGENT_STANDUP_PREFS=<a scratch file>` so that it does not change Tom's settings, and a muted page so that it plays nothing aloud.

```sh
npm test                  # adapters, peers, project calls, director, sound, graph, server
npm run i18n              # locale files complete
npm run check:placement   # every busy session on this machine's board has a project (exit 1 if not)
```

## Known limits

- "Needs you" is a heuristic: no runtime records permission prompts.
- Codex messages sent before the agent-peers `msg_id` change pair with the other end by address, time and text only.
- A Claude session that exited resolves by name only while an arrival from it is in the transcript being viewed. A Hermes inbox outside the recent sessions' own `send_peer` rows stays unresolved, and is labelled so.
- Hermes has no per-message token usage: only one session total, which is kept out of the context gauge.
- Live Codex "finished" vs "idle" relies on the thread lock file in `~/.codex/thread-writer-locks`.

The upstream features (VS Code extension, desktop build, video export, characters, other voices, office music) are still in the code; see the [upstream README](https://github.com/Atoll92/agent-standup#readme). Changes in this fork are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, © Atoll92 and contributors.
