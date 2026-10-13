// test/project.test.js: where a session belongs, derived from its own logs: a git root from the cwd (a worktree lands in its main repo),
// a Hermes profile for the Claude SDK scratch folders, "other" outside any repo, and the parent links of each runtime.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-project-'));
const project = require('../adapters/project.js');
const { execFileSync } = require('node:child_process');
function git(dir, ...args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function repo(name, origin) {
  const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('local worker clones share their owning project and voice key, including nested relative origins', () => {
  const main = repo('main-game', 'git@github.com:owner/game.git');
  const worker = repo('worker-look', main), nested = repo('worker-render', '../worker-look');
  fs.mkdirSync(path.join(nested, 'src'), { recursive: true });
  const expected = { key: main, name: 'main-game' };
  assert.deepEqual(project.groupOf(worker), expected);
  assert.deepEqual(project.groupOf(path.join(nested, 'src')), expected);
  assert.equal(project.groupOf(main).key, project.groupOf(nested).key);
});

test('clone identity is safe for file URLs, worktrees, missing origins, cycles and unrelated upstreams', () => {
  const { pathToFileURL } = require('node:url');
  const main = repo('safe-main'), fileClone = repo('file-clone', pathToFileURL(main).href);
  const worktree = path.join(tmp, 'real-worktree');
  git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  git(main, 'worktree', 'add', '--detach', worktree);
  assert.equal(project.groupOf(worktree).key, main);
  assert.equal(project.groupOf(fileClone).key, main);
  const worker = repo('worktree-clone', worktree);
  assert.equal(project.groupOf(worker).key, main);
  const broken = repo('broken-origin', '../missing');
  assert.equal(project.groupOf(broken).key, broken);
  const a = repo('cycle-a', '../cycle-b'), b = repo('cycle-b', '../cycle-a');
  assert.equal(project.groupOf(a).key, a); assert.equal(project.groupOf(b).key, b);
  const x = repo('independent-a', 'https://example.invalid/game.git'), y = repo('independent-b', 'https://example.invalid/game.git');
  assert.notEqual(project.groupOf(x).key, project.groupOf(y).key);
});

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
  assert.deepEqual(project.groupOf(scratch), { key: 'hermes:gaming', name: 'Hermes gaming', hermes: true });
  assert.deepEqual(project.groupOf('/home/u/.hermes/cache/scratch/claude-directsdk-cwd-1000/x'), { key: 'hermes:default', name: 'Hermes default', hermes: true });
  assert.deepEqual(project.hermesGroup('gaming', '155598', 'Plan gladiator roguelike autobattler'), { key: 'hermes:gaming:155598', name: 'Hermes gaming, Plan gladiator roguelike autobattler', hermes: true });
  assert.deepEqual(project.hermesGroup('gaming'), { key: 'hermes:gaming', name: 'Hermes gaming', hermes: true });
});
