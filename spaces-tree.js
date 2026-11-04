#!/usr/bin/env node
// herdr-spaces-tree: renders herdr's Spaces sidebar as a group -> workspace tree by writing
// per-workspace metadata tokens. A workspace labelled "group/name" belongs to that group.
// Every run is an idempotent full reconcile.
//
// Usage: node spaces-tree.js [event|refresh|clear|doctor|demo|demo-off]
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const HERDR = process.env.HERDR_BIN_PATH || 'herdr';
const SOCKET = process.env.HERDR_SOCKET_PATH;
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || path.join(__dirname, '.state');
const SOURCE = 'spaces-tree';
const STATUSES = ['working', 'blocked', 'done', 'idle', 'unknown'];
const TOKENS = ['sp_group', ...STATUSES.map((s) => 'sp_' + s), 'sp_tree', 'sp_name', 'sp_tabs'];
// Same glyphs as herdr-tui-agents-tree, so both panels share one legend.
const GLYPH = { working: '◐', blocked: '!', done: '✓', idle: '○', unknown: '?' };
// A tab's glyph is its most urgent agent's state, in this order.
const URGENCY = ['blocked', 'done', 'working', 'idle', 'unknown'];
// States a group heading counts. Idle and unknown are left out: the heading says what
// wants attention, and the workspace count already says how many there are.
const COUNTED = ['blocked', 'done', 'working'];
const SHELL_TAB = '▫'; // a tab with no agent in it
const GROUP_SEP = '/'; // the first slash splits, so "a/b/c" is "b/c" in group "a"
const PAD = Number(process.env.SPACES_TREE_PAD || 2);
// herdr trims leading whitespace from token values, so pad with an invisible non-whitespace
// character (U+2800 braille blank, one cell wide).
const PAD_CHAR = process.env.SPACES_TREE_PAD_CHAR || '⠀';
const mode = process.argv[2] || 'refresh';

// Optional config.json in the plugin config dir (`herdr plugin config-dir <id>`):
//   { "regroup": false }
// regroup (default true) reorders the Spaces list so each group's workspaces sit together.
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || __dirname;
function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') process.stderr.write(`config.json ignored: ${e.message}\n`); return {}; }
}
const REGROUP = readConfig().regroup !== false;

fs.mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK = path.join(STATE_DIR, 'lock');
const DIRTY = path.join(STATE_DIR, 'dirty');
const DEMO = path.join(STATE_DIR, 'demo'); // while present, workspaces are shown with fake groups/names/tabs

// main() treats a lock older than LOCK_STALE_MS as abandoned and takes it over. Every herdr
// call and socket request is bounded by what's left of RUN_BUDGET_MS from process start, so
// a run always ends before its lock can be taken over, and two runs never write at once.
// That ordering is what lets writes go without --seq.
const LOCK_STALE_MS = 30000;
const RUN_BUDGET_MS = 25000;
const DEADLINE = Date.now() + RUN_BUDGET_MS;
function remainingMs() {
  const ms = DEADLINE - Date.now();
  if (ms <= 0) throw new Error(`run exceeded its ${RUN_BUDGET_MS} ms budget`);
  return ms;
}

function herdr(args, { json = true } = {}) {
  const r = spawnSync(HERDR, args, { encoding: 'utf8', windowsHide: true, timeout: remainingMs() });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`herdr ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return json ? JSON.parse(r.stdout) : r.stdout;
}

// One raw socket request, for methods the CLI has no command for (workspace.move_block).
function request(method, params) {
  return new Promise((resolve, reject) => {
    if (!SOCKET) return reject(new Error('HERDR_SOCKET_PATH is not set'));
    const timeout = Math.min(10000, remainingMs());
    const conn = net.createConnection(SOCKET);
    let buf = '';
    // setTimeout only fires on idle time; the timer below caps the request's total time.
    const timer = setTimeout(() => conn.destroy(new Error(`${method} timed out`)), timeout);
    conn.on('close', () => clearTimeout(timer));
    conn.on('connect', () => conn.write(JSON.stringify({ id: SOURCE, method, params }) + '\n'));
    conn.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      conn.end();
      try {
        const reply = JSON.parse(buf);
        if (reply.error) reject(new Error(`${method} failed: ${JSON.stringify(reply.error)}`));
        else resolve(reply.result);
      } catch (e) { reject(e); }
    });
    conn.on('error', reject);
  });
}

// "work/api" -> { group: "work", name: "api" }. A label without a slash, or with nothing
// on one side of it, is ungrouped.
function parseLabel(label) {
  const s = String(label || '').trim();
  const i = s.indexOf(GROUP_SEP);
  const group = i < 0 ? '' : s.slice(0, i).trim();
  const name = i < 0 ? '' : s.slice(i + 1).trim();
  return group && name ? { group, name } : { group: null, name: s };
}

// Workspace ids in the order the Spaces list should show them: ungrouped workspaces first,
// then each group where its longest unbroken run already sits (the first, on a tie), with any
// stray members appended after that run. So a workspace renamed into a group joins the end of
// it without moving the group, and dragging a workspace within its group sticks.
function groupedOrder(workspaces) {
  const runs = []; // [{ group, ids }] per unbroken stretch of one group, in list order
  for (const w of workspaces) {
    const { group } = parseLabel(w.label);
    const last = runs[runs.length - 1];
    if (last && last.group === group) last.ids.push(w.workspace_id);
    else runs.push({ group, ids: [w.workspace_id] });
  }
  const anchor = new Map();
  runs.forEach((r, i) => {
    if (r.group !== null && (!anchor.has(r.group) || r.ids.length > runs[anchor.get(r.group)].ids.length)) anchor.set(r.group, i);
  });
  const order = runs.filter((r) => r.group === null).flatMap((r) => r.ids);
  runs.forEach((r, i) => {
    if (r.group === null || anchor.get(r.group) !== i) return;
    order.push(...r.ids, ...runs.filter((o, j) => o.group === r.group && j !== i).flatMap((o) => o.ids));
  });
  return order;
}

// Tab strip per workspace: a glyph per tab in tab order, the state of its most urgent agent,
// or SHELL_TAB for a tab with no agent.
function tabStrips(snap) {
  const tabState = new Map();
  for (const a of snap.agents) {
    const st = URGENCY.includes(a.agent_status) ? a.agent_status : 'unknown';
    const cur = tabState.get(a.tab_id);
    if (cur === undefined || URGENCY.indexOf(st) < URGENCY.indexOf(cur)) tabState.set(a.tab_id, st);
  }
  const strips = new Map();
  for (const t of snap.tabs) {
    const glyph = tabState.has(t.tab_id) ? GLYPH[tabState.get(t.tab_id)] : SHELL_TAB;
    strips.set(t.workspace_id, (strips.get(t.workspace_id) || '') + glyph);
  }
  return strips;
}

// Desired tokens per workspace from rows in Spaces order:
//   [{ id, group, name, status, tabs }]  ->  { id: { sp_group, sp_<status>, sp_tree, sp_name, sp_tabs } }
//
//   ▾ work (3) !1 ◐2
//   ├─ ◐ api ◐○▫
//   ⠀⠀├─ ! web !
//   ⠀⠀└─ ◐ db ◐◐
//
// Exactly one sp_<status> token is set per workspace, holding the whole row, so the layout
// can colour the row by status. sp_tree, sp_name and sp_tabs are the same row in parts, for
// layouts that use herdr's own state_icon instead.
//
// The heading row is set only on a group's first workspace. The sidebar indents an entry's
// first row by 1 and later rows by 3, so every grouped workspace except the one under the
// heading gets PAD pad characters to keep the connectors in one column.
function buildTokens(rows) {
  const members = new Map();
  for (const r of rows) if (r.group !== null) members.set(r.group, [...(members.get(r.group) || []), r]);
  const out = {};
  for (const r of rows) {
    const t = { sp_group: null };
    for (const s of STATUSES) t['sp_' + s] = null;
    Object.assign(t, { sp_tree: null, sp_name: r.name || null, sp_tabs: r.tabs || null });
    if (r.group !== null) {
      const mates = members.get(r.group);
      const first = mates[0] === r;
      const branch = mates[mates.length - 1] === r ? '└─' : '├─';
      t.sp_tree = first ? branch : PAD_CHAR.repeat(PAD) + branch;
      if (first) {
        const counts = COUNTED.map((s) => [s, mates.filter((m) => m.status === s).length])
          .filter(([, n]) => n > 0).map(([s, n]) => `${GLYPH[s]}${n}`);
        t.sp_group = [`▾ ${r.group} (${mates.length})`, ...counts].join(' ');
      }
    }
    const status = STATUSES.includes(r.status) ? r.status : 'unknown';
    t['sp_' + status] = [t.sp_tree, GLYPH[status], r.name, r.tabs].filter(Boolean).join(' ');
    out[r.id] = t;
  }
  return out;
}

// Fake groups/workspaces for demo mode. Tokens can only be written to real workspaces, so the
// first N real workspaces (in Spaces order) are relabelled with these. If there are more real
// workspaces than entries the list repeats with a numeric suffix.
const DEMO_SPACES = [
  ['work/billing-api', 'working', '◐!✓▫'],
  ['work/mobile-app', 'blocked', '!○'],
  ['work/docs-site', 'done', '✓○◐?'],
  ['scratch', 'idle', '▫'],
  ['home/dotfiles', 'idle', '○▫'],
  ['home/photo-sorter', 'working', '◐✓'],
];

function demoRows(workspaces) {
  return workspaces.map((w, i) => {
    const [label, status, tabs] = DEMO_SPACES[i % DEMO_SPACES.length];
    const round = Math.floor(i / DEMO_SPACES.length);
    return { id: w.workspace_id, ...parseLabel(round ? `${label}-${round + 1}` : label), status, tabs };
  });
}

function desiredTokens(snap, workspaces) {
  if (fs.existsSync(DEMO)) return buildTokens(demoRows(workspaces));
  const strips = tabStrips(snap);
  return buildTokens(workspaces.map((w) => ({
    id: w.workspace_id, ...parseLabel(w.label), status: w.agent_status, tabs: strips.get(w.workspace_id) || '',
  })));
}

function snapshot() {
  const snap = herdr(['api', 'snapshot']).result.snapshot;
  // The snapshot lists workspaces in Spaces order; number is the 1-based position.
  snap.workspaces.sort((a, b) => a.number - b.number);
  return snap;
}

// Move the Spaces list into groupedOrder() with one block move, if it isn't there already.
// Returns the workspaces in the order the list now shows. move_block with no anchor moves the
// block to the end, so moving every workspace sets the whole order at once.
async function regroup(workspaces) {
  const want = groupedOrder(workspaces);
  if (want.every((id, i) => id === workspaces[i].workspace_id)) return workspaces;
  try { await request('workspace.move_block', { workspace_ids: want }); }
  catch (e) { console.error(String(e.message)); return workspaces; }
  const byId = new Map(workspaces.map((w) => [w.workspace_id, w]));
  return want.map((id) => byId.get(id));
}

function writeTokens(wsId, tokens) {
  const args = ['workspace', 'report-metadata', wsId, '--source', SOURCE];
  for (const [k, v] of Object.entries(tokens)) {
    if (v === null) args.push('--clear-token', k);
    else args.push('--token', `${k}=${v}`);
  }
  herdr(args, { json: false });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

async function reconcile() {
  const snap = snapshot();
  let workspaces = snap.workspaces;
  const regrouping = REGROUP && mode !== 'clear' && !fs.existsSync(DEMO);
  if (regrouping) workspaces = await regroup(workspaces);
  const desired = mode === 'clear' ? {} : desiredTokens(snap, workspaces);
  // clear ignores the saved state, so it also works after the state dir is lost.
  const prev = mode === 'clear' ? {} : loadState();
  const clearAll = Object.fromEntries(TOKENS.map((k) => [k, null]));
  const next = {};
  let writes = 0;
  for (const w of workspaces) {
    const tokens = desired[w.workspace_id] || clearAll;
    const sig = JSON.stringify(tokens);
    if (prev[w.workspace_id] === sig) { next[w.workspace_id] = sig; continue; }
    try { writeTokens(w.workspace_id, tokens); writes++; next[w.workspace_id] = sig; }
    catch (e) {
      console.error(String(e.message));
      if (DEADLINE <= Date.now()) break; // out of budget; the unwritten workspaces retry next run
    }
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(next));
  return { writes, workspaces: workspaces.length };
}

function doctor() {
  const snap = snapshot();
  const workspaces = snap.workspaces;
  const want = groupedOrder(workspaces);
  const byId = new Map(workspaces.map((w) => [w.workspace_id, w]));
  const ordered = REGROUP ? want.map((id) => byId.get(id)) : workspaces;
  const desired = desiredTokens(snap, ordered);
  const moved = want.some((id, i) => id !== workspaces[i].workspace_id);
  console.log(`regroup=${REGROUP} demo=${fs.existsSync(DEMO)}` + (REGROUP && moved ? ' (Spaces order would change)' : ''));
  for (const w of ordered) {
    const t = desired[w.workspace_id];
    if (t.sp_group) console.log(t.sp_group);
    const status = STATUSES.find((s) => t['sp_' + s]);
    console.log(`  ${t['sp_' + status]}   [${w.workspace_id} ${status}]`);
  }
}

async function main() {
  if (mode === 'doctor') return doctor();
  if (mode === 'demo') fs.writeFileSync(DEMO, '1');
  if (mode === 'demo-off') { try { fs.unlinkSync(DEMO); } catch {} }
  // Serialize runs: events arrive in bursts. A losing run flags "dirty" and exits;
  // the lock holder loops until no further events arrived.
  let held = false;
  try { fs.mkdirSync(LOCK); held = true; }
  catch {
    try {
      if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(LOCK); fs.mkdirSync(LOCK); held = true; }
    } catch { /* lost the race */ }
  }
  if (!held) { try { fs.writeFileSync(DIRTY, '1'); } catch {} return; }
  try {
    let rounds = 0;
    do {
      try { fs.unlinkSync(DIRTY); } catch {}
      const r = await reconcile();
      if (rounds === 0) console.log(`[${mode}] workspaces=${r.workspaces} writes=${r.writes}`);
      rounds++;
    } while (fs.existsSync(DIRTY) && rounds < 5 && DEADLINE > Date.now());
  } finally {
    try { fs.rmdirSync(LOCK); } catch {}
  }
}

if (require.main === module) main().catch((e) => { console.error(String(e.stack || e)); process.exit(1); });
// Exported for test.js.
module.exports = { parseLabel, groupedOrder, tabStrips, buildTokens };
