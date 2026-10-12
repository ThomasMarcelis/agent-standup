// test/peers.test.js: a Claude Code session that messages other sessions (agent-peers) and its own background agent, through the real server
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-peers-'));
process.env.AGENT_STANDUP_PREFS = path.join(tmp, 'prefs.json'); process.env.AGENT_STANDUP_KOKORO_DIR = path.join(tmp, 'kokoro'); process.env.AGENT_STANDUP_PROJECTS = path.join(tmp, 'projects');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude'); process.env.CODEX_HOME = path.join(tmp, 'codex'); process.env.AGENT_STANDUP_HERMES = path.join(tmp, 'hermes'); process.env.AGENT_PEERS_HOME = path.join(tmp, 'peers');
const get = (port, p) => new Promise((res, rej) => http.get({ port, path: p }, (x) => { let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const CODEX = 'uds:/run/user/1000/cc-socks/codex-9f73ec26c5009ae5.sock', HERMES = 'uds:/run/user/1000/cc-socks/hermes-d84d104eebf44fa0aafc6e7cbaa85e5e.sock';
const BASE = Date.now() - 8 * 60e3, t = (s) => new Date(BASE + +s.split(':')[0] * 60e3 + parseFloat(s.split(':')[1]) * 1000).toISOString();   // minutes ago: its contacts are current
const rec = (o) => JSON.stringify(o) + '\n';
const lines = [
  rec({ type: 'user', timestamp: t('00:00.000'), message: { role: 'user', content: 'Review the plan with Astra' } }),
  // an arrival, framed by Claude Code; origin carries the wire message id
  rec({ type: 'user', isMeta: true, timestamp: t('01:00.000'), origin: { kind: 'peer', from: HERMES, msg_id: 'f4fc7b29-bc08-46c4-8245-3614c17977af', name: 'hermes:gaming:cb050161' }, message: { role: 'user', content: `Another Claude session sent a message:\n<cross-session-message from="${HERMES}" from-name="hermes:gaming:cb050161">\nScope update from Tom.\n\n(From hermes:gaming:cb050161, a Hermes profile with a private reply inbox. Use your peer messaging tool to reply to the sender address.)\n</cross-session-message>\n\nThis came from another Claude session` } }),
  // a send to a Codex session (by address) and its result; the same input is also a "tool" in Claude's eyes but shown as a message here
  rec({ type: 'assistant', timestamp: t('02:00.000'), message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'toolu_send1', name: 'SendMessage', input: { to: CODEX, summary: 'Plan for challenge', message: 'Fable here. Plan + findings; please challenge.' } }] } }),
  rec({ type: 'user', timestamp: t('02:01.000'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_send1', content: [{ type: 'text', text: JSON.stringify({ success: true, message: `“Plan for challenge” → ${CODEX}; in that session's inbox, not yet read by its Claude`, msg_id: '77498bf7-df71-4867-b2fb-100349758a96' }) }] }] } }),
  // a message to a background agent of this very session, and a failed send
  rec({ type: 'assistant', timestamp: t('03:00.000'), message: { id: 'm2', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Codex rollout research', prompt: 'Document the format', run_in_background: true } }] } }),
  rec({ type: 'user', timestamp: t('03:00.500'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'Async agent launched successfully. agentId: a1685c1dd9cf8f419' }] } }),
  rec({ type: 'assistant', timestamp: t('03:01.000'), message: { id: 'm3', content: [{ type: 'tool_use', id: 'toolu_send2', name: 'SendMessage', input: { to: 'a1685c1dd9cf8f419', message: 'Also check token_count' } }] } }),
  rec({ type: 'user', timestamp: t('03:02.000'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_send2', content: 'Message queued for agent' }] } }),
  rec({ type: 'assistant', timestamp: t('04:00.000'), message: { id: 'm4', content: [{ type: 'tool_use', id: 'toolu_send3', name: 'SendMessage', input: { to: 'uds:/run/user/1000/cc-socks/999999.sock', message: 'anyone there?' } }] } }),
  rec({ type: 'user', timestamp: t('04:01.000'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_send3', is_error: true, content: 'No live session owns that inbox' }] } }),
  // an arrival while the session was busy: Claude Code records it in its queue (twice) and as an attachment; it is one message
  ...(() => { const frame = `<cross-session-message from="${HERMES}" from-name="hermes:gaming:cb050161">\nTom approves.\n</cross-session-message>`, o = { kind: 'peer', from: HERMES, msg_id: '0b0b0b0b-1111-2222-3333-444444444444', name: 'hermes:gaming:cb050161', body: 'Tom approves.' };
    return [rec({ type: 'queue-operation', operation: 'enqueue', timestamp: t('04:30.000'), content: frame }), rec({ type: 'attachment', timestamp: t('04:30.001'), rendered: [{ content: '<system-reminder>\n' + frame + '\n</system-reminder>' }], attachment: { type: 'queued_command', prompt: frame, origin: o, isMeta: true } }), rec({ type: 'queue-operation', operation: 'remove', timestamp: t('04:31.000'), content: frame })]; })(),
  rec({ type: 'assistant', timestamp: t('05:00.000'), message: { id: 'm5', content: [{ type: 'text', text: 'Sent the plan; waiting for the review.' }] } }),
];
const dir = path.join(tmp, 'projects', '-home-user-proj'); fs.mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.join(''));
fs.writeFileSync(path.join(dir, 's1', 'subagents', 'agent-a1685c1dd9cf8f419.jsonl'), rec({ type: 'assistant', timestamp: t('03:30.000'), message: { content: [{ type: 'text', text: 'Found 12 record types.' }] } }));
fs.writeFileSync(path.join(dir, 's1', 'subagents', 'agent-a1685c1dd9cf8f419.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Codex rollout research', toolUseId: 'toolu_agent' }));

test('peer messages of a Claude Code session: edges in and out, states, peers as participants, and the board', async () => {
  const srv = require('../server.js').start(0); await new Promise((r) => srv.once('listening', r)); const port = srv.address().port;
  try {
    const tl = await get(port, '/api/session?proj=-home-user-proj&id=s1');
    assert.equal(tl.rev, 1);
    const msgs = tl.events.filter((e) => e.kind === 'msg'); assert.equal(msgs.length, 5);
    assert.deepEqual([msgs[4].state, msgs[4].text, msgs[4].msgId], ['received', 'Tom approves.', '0b0b0b0b-1111-2222-3333-444444444444']);   // the queued one, once
    const [inn, out, nat, bad] = msgs;
    assert.deepEqual([inn.to, inn.state, inn.msgId, inn.text], ['main', 'received', 'f4fc7b29-bc08-46c4-8245-3614c17977af', 'Scope update from Tom.']);
    const hermes = tl.agents.find((a) => a.id === inn.agent); assert.deepEqual([hermes.type, hermes.name, hermes.role, hermes.link, hermes.group], ['peer', 'hermes:gaming:cb050161', 'Hermes gaming', null, { key: 'hermes:gaming', name: 'Hermes gaming', hermes: true }]);   // the profile is in the name even when the conversation is not on this machine
    assert.deepEqual([out.agent, out.state, out.msgId, out.text, out.ts], ['main', 'accepted', '77498bf7-df71-4867-b2fb-100349758a96', 'Fable here. Plan + findings; please challenge.', Date.parse(t('02:01.000'))]);   // dated by the result, so the event never changes once sent
    const codex = tl.agents.find((a) => a.id === out.to); assert.deepEqual([codex.type, codex.name, codex.role], ['peer', 'codex-9f73ec26c5009ae5', 'Codex']);
    assert.deepEqual([nat.agent, nat.to, nat.native, nat.state], ['main', 'a1685c1dd9cf8f419', true, 'accepted']);   // to this session's own background agent: no peer tile
    assert.deepEqual([bad.state, bad.detail], ['failed', 'No live session owns that inbox']);
    assert.ok(!tl.events.some((e) => e.kind === 'tools' && e.tools.some((x) => x.name === 'SendMessage')), 'a send is a message, not a tool call');
    assert.ok(tl.events.some((e) => e.kind === 'order' && e.to === 'a1685c1dd9cf8f419') && tl.events.some((e) => e.kind === 'say' && /waiting for the review/.test(e.text)));
    assert.equal(tl.agents.filter((a) => a.type === 'peer').length, 3);
    const after = await get(port, '/api/session?proj=-home-user-proj&id=s1&after=' + (tl.events.length - 1)); assert.equal(after.rev, 1); assert.equal(after.events.length, 1);
    const rows = await get(port, '/api/sessions'); assert.deepEqual(rows.map((r) => [r.source, r.id]), [['claude', 's1']]);
    const board = await get(port, '/api/board'); assert.equal(board.length, 1); assert.equal(board[0].source, 'claude'); assert.equal(board[0].msgs, 4); assert.deepEqual(board[0].peers, ['hermes:gaming:cb050161', 'codex-9f73ec26c5009ae5', 'Claude session (ended)']);   // messages with other sessions, from the tail of the transcript; a dead pid is named by its runtime
    assert.equal((await get(port, '/api/session?proj=_codex&id=01a129a4-0000-7000-8000-000000000000')).error, 'session not found');
    assert.equal((await get(port, '/api/session?proj=_hermes-gaming&id=x')).error, 'session not found');
  } finally { srv.close(); require('../server.js').shutdown(); }
});

test('round 5: a send to a name or agent id nobody answers to is an edge to a placeholder, never a guest, and a dead pid is found by message id', async () => {
  const dir2 = path.join(tmp, 'projects', '-home-user-proj2'); fs.mkdirSync(dir2, { recursive: true });
  const MID = 'c4c4c4c4-0000-4000-8000-0000000000aa', HM = 'uds:/run/user/1000/cc-socks/hermes-d84d104eebf44fa0aafc6e7cbaa85e5e.sock';
  fs.writeFileSync(path.join(dir2, 's2.jsonl'), [
    rec({ type: 'user', timestamp: t('00:00.000'), message: { role: 'user', content: 'Check the other crews' } }),
    rec({ type: 'assistant', timestamp: t('01:00.000'), message: { id: 'a1', content: [{ type: 'tool_use', id: 'toolu_x1', name: 'SendMessage', input: { to: 'gladiator-fight', message: 'status?' } }] } }),
    rec({ type: 'user', timestamp: t('01:01.000'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x1', is_error: true, content: 'No agent named "gladiator-fight" is reachable' }] } }),
    rec({ type: 'assistant', timestamp: t('02:00.000'), message: { id: 'a2', content: [{ type: 'tool_use', id: 'toolu_x2', name: 'SendMessage', input: { to: 'a93572cf6481710ba', message: 'go on' } }] } }),
    rec({ type: 'user', timestamp: t('02:01.000'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x2', content: JSON.stringify({ success: true, message: 'queued' }) }] } }),
    // a message from a Hermes inbox whose Claude session (a pid long gone) is known only by the wire id carried on both sides
    rec({ type: 'assistant', timestamp: t('03:00.000'), message: { id: 'a3', content: [{ type: 'tool_use', id: 'toolu_x3', name: 'SendMessage', input: { to: HM, message: 'result is in' } }] } }),
    rec({ type: 'user', timestamp: t('03:01.000'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x3', content: JSON.stringify({ success: true, msg_id: MID, message: 'delivered' }) }] } }),
  ].join(''));
  const peersMod = require('../adapters/peers.js');
  const srv = require('../server.js').start(0); await new Promise((r) => srv.once('listening', r)); const port = srv.address().port;
  try {
    const tl = await get(port, '/api/session?proj=-home-user-proj2&id=s2');
    const names = Object.fromEntries(tl.agents.filter((a) => a.type === 'peer').map((a) => [a.name, a]));
    assert.deepEqual([names['gladiator-fight'].role, names['gladiator-fight'].absent, names['gladiator-fight'].link], ['not reachable', true, null]);   // a failed send to a name: not a peer of this call
    assert.deepEqual([names['agent 10ba'].role], ['not in view']);   // an agent id with no file here: a placeholder, not "unknown peer"
    assert.ok(!tl.agents.some((a) => a.name === 'unknown peer'));
    // the board's tails index the wire ids: another runtime's log naming this session's dead pid then resolves
    await new Promise((r) => setTimeout(r, 1300));   // the board is memoised for 1.2 s
    const rows = await get(port, '/api/board'); assert.ok(rows.some((r) => r.id === 's2'));
    const link = peersMod.peerAgent('uds:/run/user/1000/cc-socks/424242.sock', '', null, { msgId: MID, not: { proj: '_hermes-gaming', id: 'h' } }).link;
    assert.deepEqual(link, { proj: '-home-user-proj2', id: 's2' });
  } finally { srv.close(); require('../server.js').shutdown(); }
});

test('round 5: a Claude session is running only while a live process owns its registry file (a crash can leave the file behind)', () => {
  const peers = require('../adapters/peers.js'), dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: 'live-1', cwd: '/w' }));
  fs.writeFileSync(path.join(dir, '2147480000.json'), JSON.stringify({ pid: 2147480000, sessionId: 'gone-1', cwd: '/w' }));   // no such process
  try {
    assert.deepEqual([...peers.liveClaude()], ['live-1']);
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f)); assert.deepEqual([...peers.liveClaude()], [], 'every session ended: an empty set, so the board marks them stopped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(peers.liveClaude(), null, 'no registry on this machine: nothing is marked stopped');
});

test("claude: each agent's model is the latest its own transcript records; a board row has its session's", async () => {
  const dir = path.join(process.env.AGENT_STANDUP_PROJECTS, '-home-user-models'), sub = path.join(dir, 'm1', 'subagents'); fs.mkdirSync(sub, { recursive: true });
  const at = (s) => new Date(Date.now() - s * 1000).toISOString(), a = (id, model, s) => JSON.stringify({ type: 'assistant', timestamp: at(s), cwd: '/w', message: { id, role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 2 } } });
  fs.writeFileSync(path.join(dir, 'm1.jsonl'), [JSON.stringify({ type: 'user', timestamp: at(60), cwd: '/w', message: { role: 'user', content: 'go' } }), a('msg_1', 'claude-sonnet-5-5', 50), a('msg_2', 'claude-opus-5-5', 40), a('msg_3', '<synthetic>', 30)].join('\n') + '\n');
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), a('msg_s', 'claude-haiku-5-5', 35) + '\n'); fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Check the logs' }));
  const srv = require('../server.js').start(0); await new Promise((r) => srv.once('listening', r)); const port = srv.address().port;
  try {
    const tl = await get(port, '/api/session?proj=-home-user-models&id=m1');
    assert.deepEqual(tl.agents.filter((x) => x.id === 'main' || x.id === 'a1').map((x) => [x.id, x.model]), [['main', 'claude-opus-5-5'], ['a1', 'claude-haiku-5-5']]);   // changed mid-session: the latest; a <synthetic> line is not a model
    await new Promise((r) => setTimeout(r, 1300));   // past the board's 1.2 s memo from the test before
    const row = (await get(port, '/api/board')).find((r) => r.id === 'm1'); assert.ok(row, 'the session is on the board'); assert.equal(row.model, 'claude-opus-5-5');
  } finally { srv.close(); require('../server.js').shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('claude: a sub-agent silent for 10 min that acted after its last words is finished, not working for ever; a lead whose turn ended while its sub-agents work is waiting on the board', async () => {
  const t20h = () => (Date.now() - 1300000) / 1000, at = (s) => new Date(Date.now() - s * 1000).toISOString(), say = (s, text) => JSON.stringify({ type: 'assistant', timestamp: at(s), cwd: '/w', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] } });
  const tool = (s, id) => JSON.stringify({ type: 'assistant', timestamp: at(s), cwd: '/w', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } });
  const dir = path.join(process.env.AGENT_STANDUP_PROJECTS, '-home-user-liveness'), sub = path.join(dir, 'q1', 'subagents'); fs.mkdirSync(sub, { recursive: true });
  const task = JSON.stringify({ type: 'assistant', timestamp: at(1500), cwd: '/w', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_task_back', name: 'Task', input: { description: 'Research the 2D fight view', prompt: 'Research it', subagent_type: 'general-purpose' } }] } });
  const done = JSON.stringify({ type: 'user', timestamp: at(1420), cwd: '/w', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_task_back', content: [{ type: 'text', text: 'Done.' }] }] } });   // the lead records the task's result
  fs.writeFileSync(path.join(dir, 'q1.jsonl'), [JSON.stringify({ type: 'user', timestamp: at(3600), cwd: '/w', message: { role: 'user', content: 'go' } }), say(3500, 'All started; waiting on the workers.'), task, done].join('\n') + '\n');
  const old = path.join(sub, 'agent-aold.jsonl'); fs.writeFileSync(old, [say(1300, 'The armour page is built.'), tool(1250, 'toolu_after')].join('\n') + '\n');
  const handback = path.join(sub, 'agent-aback.jsonl'); fs.writeFileSync(handback, [say(1400, 'Report: the decision page is done.'), tool(1350, 'toolu_handback')].join('\n') + '\n'); fs.writeFileSync(path.join(sub, 'agent-aback.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Research the 2D fight view', toolUseId: 'toolu_task_back' })); fs.utimesSync(handback, t20h(), t20h()); fs.writeFileSync(path.join(sub, 'agent-aold.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Build the armour decision page' }));
  const t20 = (Date.now() - 1200000) / 1000; fs.utimesSync(old, t20, t20);   // its file last written 20 min ago
  fs.writeFileSync(path.join(sub, 'agent-anew.jsonl'), say(5, 'Season run 3 of 10.') + '\n'); fs.writeFileSync(path.join(sub, 'agent-anew.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Why our band never lost' }));
  const t5 = (Date.now() - 600000) / 1000; fs.utimesSync(path.join(dir, 'q1.jsonl'), t5, t5);   // the lead itself last wrote 10 min ago: its turn ended
  const srv = require('../server.js').start(0); await new Promise((r) => srv.once('listening', r)); const port = srv.address().port;
  try {
    const tl = await get(port, '/api/session?proj=-home-user-liveness&id=q1'), mine = tl.events.filter((e) => e.agent === 'aold').map((e) => e.kind);
    assert.deepEqual(mine.slice(-3), ['report', 'tools', 'finish'], 'its last words are its report, and a closing finish follows what it did after');
    assert.equal(tl.events.filter((e) => e.agent === 'aback').pop().kind, 'finish', 'a hand-back call after its report: closed too (gladiator: two such tiles stayed working for hours)');
    await new Promise((r) => setTimeout(r, 1300));
    const row = (await get(port, '/api/board')).find((r) => r.id === 'q1'); assert.deepEqual([row.state, row.subActive], ['waiting', 1], 'its turn ended, one sub-agent wrote 5 s ago: waiting, not finished');
  } finally { srv.close(); require('../server.js').shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});
