'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {TTL_MS, isExpired, purgeUserClips} = require('../functions/expiry');

test('a temporary clip expires at ten minutes; missing timestamps are not deleted', () => {
  const now = 1_000_000;
  assert.equal(isExpired({createdAt: now - TTL_MS}, now - TTL_MS), true);
  assert.equal(isExpired({createdAt: now - TTL_MS + 1}, now - TTL_MS), false);
  assert.equal(isExpired({content: 'old record'}, now - TTL_MS), false);
});

test('server purge rechecks the current record before deleting', async () => {
  const cutoff = 500_000;
  const clips = [{createdAt: cutoff}, {createdAt: cutoff + 1}];
  const db = {ref(path) {
    assert.equal(path, 'users/test-uid/clips');
    return {orderByChild(key) {assert.equal(key, 'createdAt'); return this;}, endAt(value) {assert.equal(value, cutoff); return this;}, limitToFirst(n) {assert.equal(n, 500); return this;}, async once() {
      return {exists: () => true, forEach(fn) {
        fn({ref: {transaction: async update => ({committed: update(clips[0]) === null})}});
        fn({ref: {transaction: async update => ({committed: update(clips[1]) === null})}});
      }};
    }};
  }};
  assert.equal(await purgeUserClips(db, 'test-uid', cutoff), 1);
});
