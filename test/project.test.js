// test/project.test.js: where a session belongs, derived from its own logs: a git root from the cwd (a worktree lands in its main repo),
// a Hermes profile for the Claude SDK scratch folders, "other" outside any repo, and the parent links of each runtime.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-project-'));
const project = require('../adapters/project.js');

test('a folder maps to its git repository; a worktree to the main repository; outside git to "other"; unknown to nothing', () => {
  const repo = path.join(tmp, 'repos', 'gladiator-game'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  assert.deepEqual(project.groupOf(repo), { key: repo, name: 'gladiator-game' });
  assert.deepEqual(project.groupOf(path.join(repo, 'src', 'deep')), { key: repo, name: 'gladiator-game' });
  const wt = path.join(repo, '.claude', 'worktrees', 'feat-x'); fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ' + path.join(repo, '.git', 'worktrees', 'feat-x') + '\n');   // what `git worktree add` writes
  assert.deepEqual(project.groupOf(wt), { key: repo, name: 'gladiator-game' }); assert.deepEqual(project.groupOf(path.join(wt, 'src')), { key: repo, name: 'gladiator-game' });
  const codexWt = path.join(tmp, 'elsewhere', 'wt2'); fs.mkdirSync(codexWt, { recursive: true }); fs.writeFileSync(path.join(codexWt, '.git'), 'gitdir: ' + path.join(repo, '.git', 'worktrees', 'wt2'));   // a worktree outside the repo folder (Codex style)
  assert.equal(project.groupOf(codexWt).key, repo);
  const plain = path.join(tmp, 'notes'); fs.mkdirSync(plain, { recursive: true });
  assert.deepEqual(project.groupOf(plain), { key: '_other', name: 'notes', other: true });
  assert.equal(project.groupOf(''), null); assert.equal(project.groupOf(undefined), null);
  const scratch = '/home/u/.hermes/profiles/gaming/cache/scratch/claude-directsdk-cwd-1000';   // Hermes runs its Claude SDK sessions here: they belong to Hermes, not to a mystery project
  assert.deepEqual(project.groupOf(scratch), { key: 'hermes:gaming', name: 'Hermes · gaming', hermes: true });
  assert.deepEqual(project.groupOf('/home/u/.hermes/cache/scratch/claude-directsdk-cwd-1000/x'), { key: 'hermes:default', name: 'Hermes · default', hermes: true });
  assert.deepEqual(project.hermesGroup('gaming', '155598', 'Plan gladiator roguelike autobattler'), { key: 'hermes:gaming:155598', name: 'Hermes · gaming · Plan gladiator roguelike autobattler', hermes: true });
  assert.deepEqual(project.hermesGroup('gaming'), { key: 'hermes:gaming', name: 'Hermes · gaming', hermes: true });
});
