// Checks, against this machine's real sessions, that every busy session on the board has a project (a git root from its folder, a Hermes thread, or "other").
//   node scripts/check-placement.js      → prints the counts; exit code 1 when a working, waiting or blocked session could not be placed
const { placement } = require('../server.js');
const p = placement();
const by = {}; for (const r of p.rows) { const k = r.group ? (r.group.other ? 'other' : r.group.hermes ? 'hermes' : 'repo') : 'UNPLACED'; by[k] = (by[k] || 0) + 1; }
console.log(`${p.rows.length} sessions on the board · ${p.groups} projects · placed: ${JSON.stringify(by)} · unplaced: ${p.unplaced} · busy and unplaced: ${p.busyUnplaced.length}`);
for (const r of p.busyUnplaced) console.log(`  UNPLACED ${r.source} ${r.state} ${r.proj}/${r.id} ${r.title}`);
require('../server.js').shutdown();
process.exit(p.busyUnplaced.length ? 1 : 0);
