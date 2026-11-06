// Run with: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLabel, groupedOrder, tabStrips, buildTokens } = require('./spaces-tree.js');

const ws = (id, label) => ({ workspace_id: id, label });

test('parseLabel splits on the first slash only', () => {
  assert.deepEqual(parseLabel('work/api'), { group: 'work', name: 'api' });
  assert.deepEqual(parseLabel('a/b/c'), { group: 'a', name: 'b/c' });
  assert.deepEqual(parseLabel('scratch'), { group: null, name: 'scratch' });
  assert.deepEqual(parseLabel('/x'), { group: null, name: '/x' });
  assert.deepEqual(parseLabel('x/ '), { group: null, name: 'x/' });
});

test('groupedOrder puts ungrouped first and appends strays to the longest run', () => {
  const list = [ws('1', 'w/a'), ws('2', 'h/x'), ws('3', 'w/b'), ws('4', 'w/c'), ws('5', 'solo'), ws('6', 'h/y')];
  // w's longest run is 3,4 so 1 joins after it; h's runs tie, so the first (2) anchors.
  assert.deepEqual(groupedOrder(list), ['5', '2', '6', '3', '4', '1']);
});

test('groupedOrder keeps an already grouped list unchanged', () => {
  const list = [ws('1', 'solo'), ws('2', 'w/a'), ws('3', 'w/b'), ws('4', 'h/x')];
  assert.deepEqual(groupedOrder(list), ['1', '2', '3', '4']);
});

test('tabStrips shows the most urgent agent per tab and a shell mark for empty tabs', () => {
  const snap = {
    tabs: [
      { tab_id: 't1', workspace_id: 'w' },
      { tab_id: 't2', workspace_id: 'w' },
      { tab_id: 't3', workspace_id: 'w' },
    ],
    agents: [
      { tab_id: 't1', agent_status: 'idle' },
      { tab_id: 't1', agent_status: 'blocked' },
      { tab_id: 't3', agent_status: 'something-new' },
    ],
  };
  assert.equal(tabStrips(snap).get('w'), '!▫?');
});

test('buildTokens draws headings, connectors and padding', () => {
  const rows = [
    { id: 's', group: null, name: 'solo', status: 'idle', tabs: '○' },
    { id: 'a', group: 'w', name: 'a', status: 'blocked', tabs: '!' },
    { id: 'b', group: 'w', name: 'b', status: 'working', tabs: '◐▫' },
  ];
  const t = buildTokens(rows);
  const none = { sp_working: null, sp_blocked: null, sp_done: null, sp_idle: null, sp_unknown: null };
  assert.deepEqual(t.s, { ...none, sp_group: null, sp_idle: '○ solo ○', sp_tree: null, sp_name: 'solo', sp_tabs: '○' });
  assert.deepEqual(t.a, {
    ...none,
    sp_group: '▾ w (2) !1 ◐1',
    sp_blocked: '├─ ! a !',
    sp_tree: '├─',
    sp_name: 'a',
    sp_tabs: '!',
  });
  assert.deepEqual(t.b, {
    ...none,
    sp_group: null,
    sp_working: '⠀⠀└─ ◐ b ◐▫',
    sp_tree: '⠀⠀└─',
    sp_name: 'b',
    sp_tabs: '◐▫',
  });
});

test('buildTokens files an unrecognised workspace status under unknown', () => {
  const t = buildTokens([{ id: 'x', group: null, name: 'x', status: 'something-new', tabs: '' }]);
  assert.equal(t.x.sp_unknown, '? x');
});
