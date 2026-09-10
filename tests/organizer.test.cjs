const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../organizer.js');
const time = 1800000000000;
const clip = (extra = {}) => ({ type: 'text', content: 'A note', createdAt: time, ...extra });
const group = (id, name = id, updatedAt = 1) => ({ id, name, color: '#2f5fa8', order: 0, updatedAt });

test('legacy records remain usable without organization metadata', () => {
  const items = { old: clip({ createdAt: time - 1000 }), newest: clip() };
  assert.deepEqual(M.ordered(items, 'clips'), ['newest', 'old']);
  assert.equal(M.groupId(items.old), '');
  assert.equal(M.isClip(items.old), true);
  assert.equal(M.timestamp(items.newest, 'clips'), time);
});
test('expiry occurs at the exact ten-minute boundary and never applies to kept items', () => {
  assert.equal(M.expired(clip(), 'clips', time + M.TTL - 1), false);
  assert.equal(M.expired(clip(), 'clips', time + M.TTL), true);
  assert.equal(M.expired(clip(), 'vault', time + M.TTL * 1000), false);
});
test('unresolved server timestamps are not assigned an invented lifetime', () => {
  const pending = clip({ createdAt: { '.sv': 'timestamp' } });
  assert.equal(M.timestamp(pending, 'clips'), 0);
  assert.equal(M.expired(pending, 'clips', time), false);
});
test('editing, grouping, coloring and pinning do not reset a clip lifetime', () => {
  const original = clip({ customLegacyField: 'preserve me' });
  const updated = M.patchCurrent(original, { title: 'Saved header', color: '#2f5fa8', pinned: true, group: group('work') }, 'clips', time + 1000);
  assert.equal(updated.createdAt, time);
  assert.equal(updated.content, original.content);
  assert.equal(updated.customLegacyField, 'preserve me');
  assert.equal(updated.revision, 1);
  assert.equal(original.title, undefined);
});
test('late transaction callbacks cannot resurrect deleted or expired records', () => {
  assert.equal(M.patchCurrent(null, { color: '#2f5fa8' }, 'clips', time), undefined);
  assert.equal(M.patchCurrent(clip(), { title: 'late' }, 'clips', time + M.TTL), undefined);
  assert.equal(M.patchCurrent({ title: 'incomplete' }, { pinned: true }, 'vault', time), undefined);
});
test('clearing title and group removes metadata while retaining the content', () => {
  const updated = M.patchCurrent(clip({ title: 'Title', group: group('work'), revision: 4 }), { title: null, group: null }, 'clips', time);
  assert.equal('title' in updated, false);
  assert.equal('group' in updated, false);
  assert.equal(updated.content, 'A note');
  assert.equal(updated.revision, 5);
});
test('newer remote group names and colors replace older cached definitions', () => {
  const remote = { ...group('work', 'Projects', 10), color: '#b8511d' };
  const result = M.groups({ a: clip({ group: remote }), b: clip({ group: group('work', 'Old name', 2) }) }, [group('work', 'Cached', 1)]);
  assert.deepEqual(result, [remote]);
});
test('groups keep their identity through renames and retain local empty groups', () => {
  const result = M.groups({ a: clip({ group: group('one', 'Work', 2) }) }, [group('one', 'Old', 1), group('two', 'Ideas')]);
  assert.deepEqual(new Set(result.map(g => g.id)), new Set(['one', 'two']));
  assert.equal(result.find(g => g.id === 'one').name, 'Work');
});
test('invalid group data and malformed records are ignored safely', () => {
  assert.equal(M.group({ id: '<script>', name: 'Bad' }), null);
  assert.equal(M.group({ id: 'ok', name: ' ' }), null);
  assert.deepEqual(M.groups({ bad: null, incomplete: {} }, [null, 'bad']), []);
  assert.deepEqual(M.ordered({ empty: null, meta: { title: 'ignore' }, valid: clip() }, 'clips'), ['valid']);
  assert.equal(M.color('url(javascript:alert(1))'), '');
});
test('search matches titles, group names, Thai text, and types without searching image bytes', () => {
  assert.equal(M.matches(clip({ title: 'โครงการ', group: group('work', 'Mahidol') }), 'โครงการ mahidol', 'text'), true);
  assert.equal(M.matches(clip(), 'note', 'image'), false);
  assert.equal(M.matches(clip({ type: 'image', content: 'secretBase64Payload' }), 'secretBase64Payload', 'all'), false);
  assert.equal(M.matches(clip({ type: 'image', content: 'data:...' }), 'photo', 'image'), true);
});
test('manual order differs from date sorting and pinned cards stay at the top', () => {
  const items = { a: clip({ order: 2 }), b: clip({ order: 1, createdAt: time - 10 }), c: clip({ pinned: true, order: 99, createdAt: time - 20 }) };
  assert.deepEqual(M.ordered(items, 'clips'), ['c', 'b', 'a']);
  assert.deepEqual(M.ordered(items, 'clips', 'newest'), ['c', 'a', 'b']);
  assert.deepEqual(M.ordered(items, 'clips', 'oldest'), ['c', 'b', 'a']);
});
test('equal ranks and timestamps have a deterministic cross-device tie break', () => {
  assert.deepEqual(M.ordered({ z: clip(), a: clip() }, 'clips'), ['a', 'z']);
});
test('dragging within a group produces the requested insertion order', () => {
  const items = { a: clip({ order: 1 }), b: clip({ order: 2 }), c: clip({ order: 3 }) };
  const patches = M.movePlan(items, 'clips', ['c'], null, 'b');
  const updated = Object.fromEntries(Object.entries(items).map(([k, item]) => [k, M.patchCurrent(item, patches[k] || {}, 'clips', time)]));
  assert.deepEqual(M.ordered(updated, 'clips'), ['a', 'c', 'b']);
  assert.equal(items.c.order, 3);
});
test('bulk move changes membership and order without touching unrelated groups', () => {
  const work = group('work'), ideas = group('ideas');
  const items = { a: clip(), b: clip(), c: clip({ group: work, order: 1 }), d: clip({ group: ideas }) };
  const patches = M.movePlan(items, 'clips', ['a', 'b'], work);
  assert.equal(patches.d, undefined);
  assert.equal(patches.a.group.id, 'work');
  assert.equal(patches.b.group.id, 'work');
  const updated = Object.fromEntries(Object.entries(items).map(([k, item]) => [k, M.patchCurrent(item, patches[k] || {}, 'clips', time)]));
  assert.deepEqual(M.ordered(updated, 'clips').filter(k => M.groupId(updated[k]) === 'work'), ['c', 'a', 'b']);
  assert.ok(Object.values(updated).every(item => item.createdAt === time));
});
test('moving to Unfiled removes membership and ignores missing selected keys', () => {
  const items = { a: clip({ group: group('work') }) };
  const patches = M.movePlan(items, 'clips', ['missing', 'a', 'a'], null);
  assert.deepEqual(Object.keys(patches), ['a']);
  assert.equal(M.groupId(M.patchCurrent(items.a, patches.a, 'clips', time)), '');
});
test('an item expiring during a move is not restored by its reorder plan', () => {
  const items = { a: clip() }, patches = M.movePlan(items, 'clips', ['a'], group('work'));
  assert.equal(M.patchCurrent(items.a, patches.a, 'clips', time + M.TTL), undefined);
});
test('moving a pinned clip cannot cause an unpinned clip to sort above it', () => {
  const items = { a: clip({ pinned: true }), b: clip() };
  const patches = M.movePlan(items, 'clips', ['a'], null);
  const updated = Object.fromEntries(Object.entries(items).map(([k, item]) => [k, { ...item, ...patches[k] }]));
  assert.equal(M.ordered(updated, 'clips')[0], 'a');
});
test('legacy www links open as HTTPS and active URL schemes are rejected', () => {
  assert.equal(M.safeLink('www.example.com/path'), 'https://www.example.com/path');
  assert.equal(M.safeLink('https://example.com'), 'https://example.com/');
  assert.equal(M.safeLink('javascript:alert(1)'), null);
  assert.equal(M.safeLink('data:text/html,test'), null);
});
test('default colors are stable across renders and devices', () => {
  assert.equal(M.defaultColor('-stable-key'), M.defaultColor('-stable-key'));
  assert.ok(M.COLORS.some(c => c[1] === M.defaultColor('-stable-key')));
});
