const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-exec-worker-'));
process.env.CODEX_HOME = tmp;
process.env.AGENT_PEERS_HOME = path.join(tmp, 'peers');
const codex = require('../adapters/codex.js');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a running codex exec worker joins its project; only a finished one-shot is hidden', () => {
  const now = new Date(), ts = now.toISOString(), pad = n => String(n).padStart(2, '0');
  const dir = path.join(tmp, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  for (const [i, id] of ids.entries()) {
    const records = [
      { timestamp: ts, type: 'session_meta', payload: { id, timestamp: ts, cwd: tmp, originator: 'codex_exec' } },
      { timestamp: ts, type: 'event_msg', payload: { type: i ? 'task_complete' : 'task_started' } }
    ];
    fs.writeFileSync(path.join(dir, `rollout-test-${id}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  const rows = codex.board();
  const running = rows.find(r => r.id === ids[0]), finished = rows.find(r => r.id === ids[1]);
  assert.equal(running.state, 'working');
  assert.equal(running.oneshot, false, 'a launch with codex exec is not reason to hide a live worker');
  assert.equal(finished.oneshot, true);
});
