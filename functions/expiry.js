'use strict';
const TTL_MS = 10 * 60 * 1000;
function isExpired(item, cutoff) {
  return item && typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) && item.createdAt <= cutoff;
}
async function purgeUserClips(db, uid, cutoff) {
  const ref = db.ref(`users/${uid}/clips`);
  let deleted = 0;
  // Bounded batches avoid loading a user's whole clipboard at once.
  for (let batch = 0; batch < 20; batch++) {
    const snap = await ref.orderByChild('createdAt').endAt(cutoff).limitToFirst(500).once('value');
    if (!snap.exists()) break;
    const work = [];
    snap.forEach(child => {
      work.push(child.ref.transaction(current => isExpired(current, cutoff) ? null : undefined, undefined, false).then(result => {
        if (result.committed) deleted++;
      }));
    });
    await Promise.all(work);
    if (work.length < 500) break;
  }
  return deleted;
}
module.exports = {TTL_MS, isExpired, purgeUserClips};
