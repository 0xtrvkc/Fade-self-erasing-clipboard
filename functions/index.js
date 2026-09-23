'use strict';
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {initializeApp} = require('firebase-admin/app');
const {getDatabase} = require('firebase-admin/database');
const {TTL_MS, purgeUserClips} = require('./expiry');
initializeApp();

exports.purgeExpiredClips = onSchedule({schedule: 'every 1 minutes', region: 'asia-southeast1', timeZone: 'Etc/UTC', maxInstances: 1}, async () => {
  const db = getDatabase();
  const accounts = await db.ref('accounts').once('value');
  const cutoff = Date.now() - TTL_MS;
  const failures = [];
  let deleted = 0;
  for (const uid of Object.keys(accounts.val() || {})) {
    try { deleted += await purgeUserClips(db, uid, cutoff); }
    catch (err) { failures.push(uid); console.error('Expiry failed for account', uid, err); }
  }
  console.log(`Purged ${deleted} expired clips`);
  if (failures.length) throw new Error(`Expiry failed for ${failures.length} account(s)`);
});
