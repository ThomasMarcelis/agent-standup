// adapters/project.js — which project a session belongs to: the git repository its folder is in (a worktree belongs to its main repository),
// a Hermes profile and thread for Hermes conversations, and "Hermes <profile>" for the Claude SDK sessions Hermes runs in its own scratch folder.
// A group is { key, name }: the key is stable (the repo path, or hermes:<profile>[:<thread>]), the name is what the page shows.
const fs = require('fs');
const path = require('path');
const os = require('os');

const memo = new Map();
function repoOf(cwd) {   // the main repository root for a folder, or null outside git
  if (!cwd || typeof cwd !== 'string') return null; if (memo.has(cwd)) return memo.get(cwd);
  let dir = cwd, out = null;
  for (let i = 0; i < 16 && dir && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
    if (dir === os.homedir()) break;   // a home folder kept in git (dotfiles) is not a project: anything that only reaches it is "other"
    const g = path.join(dir, '.git'); let st; try { st = fs.statSync(g); } catch { continue; }
    if (st.isDirectory()) { out = dir; break; }
    try { const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8')), wt = m && /^(.*)[\\/]\.git[\\/]worktrees[\\/]/.exec(m[1].trim()); out = wt ? wt[1] : dir; } catch { out = dir; }   // a worktree's .git is a file pointing into the main repo
    break;
  }
  memo.set(cwd, out); if (memo.size > 2000) memo.delete(memo.keys().next().value); return out;
}
const HERMES_SCRATCH = /[\\/]\.hermes[\\/](?:profiles[\\/]([\w.-]+)[\\/])?cache[\\/]scratch[\\/]claude-directsdk-cwd-/;   // where Hermes runs its Claude SDK sessions
function groupOf(cwd) {   // for a folder: the repo, a Hermes profile, or "other" outside any repo; null when the folder is unknown (an unplaced session)
  const h = HERMES_SCRATCH.exec(cwd || ''); if (h) return { key: 'hermes:' + (h[1] || 'default'), name: 'Hermes ' + (h[1] || 'default'), hermes: true };
  const repo = repoOf(cwd); if (repo) return { key: repo, name: path.basename(repo) };
  return cwd ? { key: '_other', name: path.basename(cwd) || cwd, other: true } : null;
}
const hermesGroup = (profile, threadId, title) => (threadId ? { key: 'hermes:' + profile + ':' + threadId, name: 'Hermes ' + profile + ', ' + String(title || threadId).slice(0, 48), hermes: true } : { key: 'hermes:' + profile, name: 'Hermes ' + profile, hermes: true });
module.exports = { repoOf, groupOf, hermesGroup };
