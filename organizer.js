/* Shared, dependency-free organization rules. Existing Firebase records need no migration. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FadeOrganizer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const TTL = 10 * 60 * 1000;
  const COLORS = [
    ['Green', '#1f7a4d'], ['Blue', '#2f5fa8'], ['Orange', '#b8511d'],
    ['Violet', '#7052ad'], ['Red', '#b22e38'], ['Teal', '#0e7c86'],
    ['Pink', '#ad4386'], ['Gold', '#977414']
  ];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const color = value => COLORS.some(c => c[1] === value) ? value : '';
  function isClip(item) {
    return !!item && ['text', 'link', 'image'].includes(item.type) && typeof item.content === 'string';
  }
  function timestamp(item, scope) {
    const value = scope === 'vault' ? item.keptAt : item.createdAt;
    return finite(value) ? value : 0;
  }
  function expired(item, scope, now) {
    return scope === 'clips' && finite(item.createdAt) && now - item.createdAt >= TTL;
  }
  function group(value) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[\w-]{1,100}$/.test(value.id)) return null;
    const name = typeof value.name === 'string' ? value.name.trim().slice(0, 60) : '';
    return name ? { id: value.id, name, color: color(value.color) || COLORS[0][1],
      order: finite(value.order) ? value.order : 0, updatedAt: finite(value.updatedAt) ? value.updatedAt : 0 } : null;
  }
  function groupId(item) { return group(item.group)?.id || ''; }
  function groups(items, remembered) {
    const map = new Map();
    for (const candidate of [...(remembered || []), ...Object.values(items).map(i => i?.group)]) {
      const g = group(candidate);
      if (g && (!map.has(g.id) || g.updatedAt > map.get(g.id).updatedAt)) map.set(g.id, g);
    }
    return [...map.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  function rank(item, scope) { return finite(item.order) ? item.order : -timestamp(item, scope); }
  function ordered(items, scope, sort = 'manual') {
    return Object.keys(items).filter(k => isClip(items[k])).sort((a, b) => {
      const x = items[a], y = items[b];
      const pinned = Number(!!y.pinned) - Number(!!x.pinned);
      if (pinned) return pinned;
      const diff = sort === 'oldest' ? timestamp(x, scope) - timestamp(y, scope)
        : sort === 'newest' ? timestamp(y, scope) - timestamp(x, scope) : rank(x, scope) - rank(y, scope);
      return diff || a.localeCompare(b);
    });
  }
  function matches(item, query, type, groupName) {
    if (type && type !== 'all' && item.type !== type) return false;
    const haystack = [item.title || '', item.type === 'image' ? 'image photo' : item.content,
      groupName || group(item.group)?.name || ''].join(' ').toLocaleLowerCase();
    return !query || query.trim().toLocaleLowerCase().split(/\s+/).every(term => haystack.includes(term));
  }
  function defaultColor(key) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    return COLORS[(hash >>> 0) % COLORS.length][1];
  }
  // Assign a stable order to the destination group, preserving pinned and unpinned lanes.
  // A plan never contains a deleted item or fabricates content.
  function movePlan(items, scope, keys, destination, beforeKey = null) {
    const moving = [...new Set(keys)].filter(k => isClip(items[k]));
    const targetId = destination?.id || '';
    const peers = ordered(items, scope).filter(k => groupId(items[k]) === targetId && !moving.includes(k));
    let index = beforeKey === null ? peers.length : peers.indexOf(beforeKey);
    if (index < 0) index = peers.length;
    peers.splice(index, 0, ...moving);
    const patches = Object.create(null);
    peers.forEach((key, i) => {
      const order = (i + 1) * 1024;
      if (moving.includes(key)) patches[key] = { group: destination || null, order };
      else if (rank(items[key], scope) !== order) patches[key] = { order };
    });
    return patches;
  }
  function patchCurrent(current, patch, scope, now) {
    if (!isClip(current) || expired(current, scope, now)) return undefined;
    const next = { ...current, ...patch, revision: (Number(current.revision) || 0) + 1 };
    for (const key of Object.keys(next)) if (next[key] === null || next[key] === undefined) delete next[key];
    return next;
  }
  function safeLink(value) {
    try {
      const url = new URL(/^www\./i.test(value) ? 'https://' + value : value);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }
  return { TTL, COLORS, color, isClip, timestamp, expired, group, groupId, groups, rank,
    ordered, matches, defaultColor, movePlan, patchCurrent, safeLink };
});
