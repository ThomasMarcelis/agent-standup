// adapters/project.js — which project a session belongs to: the owning git repository (worktrees and local-origin worker clones share their parent project),
// a Hermes profile and thread for Hermes conversations, and "Hermes <profile>" for the Claude SDK sessions Hermes runs in its own scratch folder.
// A group is { key, name }: the key is stable (the repo path, or hermes:<profile>[:<thread>]), the name is what the page shows.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { fileURLToPath } = require('url');

const memo = new Map();
function rootOf(cwd) {
  for (let dir = path.resolve(cwd), i = 0; i < 32 && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
    if (dir === os.homedir()) break;   // dotfiles in the home folder are not a project
    const g = path.join(dir, '.git'); let st; try { st = fs.statSync(g); } catch { continue; }
    if (st.isDirectory()) return dir;
    try {
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8'));
      const gd = m && path.resolve(dir, m[1].trim()), wt = gd && /^(.*)[\\/]\.git[\\/]worktrees[\\/]/.exec(gd);
      return wt ? wt[1] : dir;
    } catch { return dir; }
  }
  return null;
}
function localOrigin(repo) {
  try {
    // Read only this repository's config: no network, hooks, includes or shell interpolation.
    const url = execFileSync('git', ['config', '--no-includes', '--file', path.join(repo, '.git', 'config'), '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 1000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!url || (!url.startsWith('file://') && !path.isAbsolute(url) && /:/.test(url))) return null;   // ssh/https origins do not establish local ownership
    const target = fs.realpathSync(url.startsWith('file://') ? fileURLToPath(url) : path.resolve(repo, url));
    const root = rootOf(target);
    return root && (fs.existsSync(path.join(target, '.git')) || target === path.join(root, '.git')) ? root : null;
  } catch { return null; }
}
function repoOf(cwd) {   // worktrees and local worker clones belong to the owning repository
  if (!cwd || typeof cwd !== 'string') return null;
  const hit = memo.get(cwd); if (hit && Date.now() - hit.at < 30000) return hit.out;
  let out = rootOf(cwd); const start = out, seen = new Set();
  for (let i = 0; out && i < 16; i++) {
    if (seen.has(out)) { out = start; break; }   // a cycle is not evidence of ownership
    seen.add(out); const next = localOrigin(out); if (!next) break;
    out = next;
    if (i === 15) out = start;   // bounded traversal; keep ambiguous chains separate
  }
  memo.set(cwd, { out, at: Date.now() }); if (memo.size > 2000) memo.delete(memo.keys().next().value); return out;
}
const HERMES_SCRATCH = /[\\/]\.hermes[\\/](?:profiles[\\/]([\w.-]+)[\\/])?cache[\\/]scratch[\\/]claude-directsdk-cwd-/;   // where Hermes runs its Claude SDK sessions
function groupOf(cwd) {   // for a folder: the repo, a Hermes profile, or "other" outside any repo; null when the folder is unknown (an unplaced session)
  const h = HERMES_SCRATCH.exec(cwd || ''); if (h) return { key: 'hermes:' + (h[1] || 'default'), name: 'Hermes ' + (h[1] || 'default'), hermes: true };
  const repo = repoOf(cwd); if (repo) return { key: repo, name: path.basename(repo) };
  return cwd ? { key: '_other', name: path.basename(cwd) || cwd, other: true } : null;
}
const hermesGroup = (profile, threadId, title) => (threadId ? { key: 'hermes:' + profile + ':' + threadId, name: 'Hermes ' + profile + ', ' + String(title || threadId).slice(0, 48), hermes: true } : { key: 'hermes:' + profile, name: 'Hermes ' + profile, hermes: true });
module.exports = { repoOf, groupOf, hermesGroup };
