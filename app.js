'use strict';
const firebaseConfig = {
  apiKey: "AIzaSyD_HK_i7xcSMuGNBTFeEljgPgCJUaqPWhw",
  authDomain: "fade-self-erasing-clipboard.firebaseapp.com",
  databaseURL: "https://fade-self-erasing-clipboard-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "fade-self-erasing-clipboard",
  storageBucket: "fade-self-erasing-clipboard.firebasestorage.app",
  messagingSenderId: "511038937505",
  appId: "1:511038937505:web:4eaf327b0857f023e9d3e0",
  measurementId: "G-71KLZNSNK8"
};



const M = FadeOrganizer;
const MAX_HEADER_LENGTH = 160;
// Small attachments stay inline; larger ones are split into 512 KB database writes.
const MAX_FILE_BYTES = 7_000_000;
const CHUNK_BYTES = 512_000;
const STORAGE_WARNING_BYTES = 1_000_000_000;
// This UID must match the owner UID in database.rules.json. Client checks are only UX;
// Firebase rules enforce the limit even when someone calls the database directly.
const OWNER_UID = 'SagJ5qWZwEZWBijqebsWCPRBLHU2';
const GIRLFRIEND_EMAIL = 'usa.prasoblarp@gmail.com';
const FREE_CLIP_KEY = 'one';
const owner = () => currentUid === OWNER_UID;
let girlfriend = false;
const freeClipFull = () => !owner() && !girlfriend && Object.keys(scopes.clips.items).length > 0;
const freeClipMessage = 'You can add one temporary clip at a time. Delete it or wait for it to expire before adding another.';
const pinkColor = key => M.PINK_COLORS[[...String(key)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % M.PINK_COLORS.length][1];
const canEdit = item => !girlfriend || item?.authorEmail === GIRLFRIEND_EMAIL;
// Optional user-defined Vault budget; never inferred from the Firebase plan.
const VAULT_CAPACITY_BYTES = null;
let vaultBytes = null;
let vaultStorageError = false;
function vaultCapacity() {
  try { return Number(localStorage.getItem('fade.vault.capacity')) || VAULT_CAPACITY_BYTES; }
  catch { return VAULT_CAPACITY_BYTES; }
}
let db, auth, currentUid = null, connected = false, clockOffset = 0, activeScope = 'clips', toastTimeout, unlockTimer;
let drag = null;
const now = () => Date.now() + clockOffset;
const $ = id => document.getElementById(id);
const scopes = {};
const dialog = $('actionDialog');
const pendingExpiry = new Set();
const expiryQueue = new Set();

function readPreferences(scope) {
  try { return currentUid ? JSON.parse(localStorage.getItem('fade.organizer.v2.' + currentUid + '.' + scope)) || {} : {}; }
  catch { return {}; }
}
function savePreferences(view) {
  try {
    if (!currentUid) return;
    localStorage.setItem('fade.organizer.v2.' + currentUid + '.' + view.scope, JSON.stringify({
      groups: view.groups, collapsed: [...view.collapsed], layout: view.layout, sort: view.sort
    }));
  } catch { /* Device preferences are optional; clipboard content is never stored here. */ }
}
function makeView(scope) {
  const prefs = readPreferences(scope);
  const ids = ['Board', 'Scroll', 'Search', 'Type', 'Sort', 'Layout', 'Select', 'Bulk', 'SelectionCount',
    'SelectAll', 'BulkShare', 'BulkMove', 'BulkDelete', 'Done', 'NewGroup', 'Count', 'Empty', 'Input', 'Image', 'File', 'Destination', 'Add'];
  return { scope, ref: null, items: {}, cards: new Map(), sections: new Map(), groups: M.groups({}, Array.isArray(prefs.groups) ? prefs.groups : []),
    collapsed: new Set(Array.isArray(prefs.collapsed) ? prefs.collapsed.filter(x => typeof x === 'string') : []),
    layout: scope === 'vault' ? (prefs.layout === 'comfortable' ? 'comfortable' : 'sheet') : prefs.layout === 'list' ? 'list' : 'grid', sort: ['manual', 'newest', 'oldest', 'title-asc', 'title-desc'].includes(prefs.sort) ? prefs.sort : 'manual',
    query: '', type: 'all', selecting: false, selected: new Set(), visible: [], adding: false,
    ui: Object.fromEntries(ids.map(id => [id, $(scope + id)])) };
}
scopes.clips = makeView('clips');
scopes.vault = makeView('vault');

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function formatStorage(bytes) {
  if (bytes < 1000) return bytes + ' B';
  if (bytes < 1000000) return (bytes / 1000).toFixed(1) + ' KB';
  if (bytes < 1000000000) return (bytes / 1000000).toFixed(1) + ' MB';
  return (bytes / 1000000000).toFixed(2) + ' GB';
}
function updateVaultStorage() {
  const status = $('vaultStorageText'), meter = $('vaultStorageMeter');
  if (vaultStorageError || vaultBytes === null) {
    status.textContent = vaultStorageError ? 'Storage unavailable' : 'Loading storage…';
    meter.hidden = true; return;
  }
  const usage = M.storageUsage(vaultBytes, vaultCapacity());
  status.textContent = '~' + formatStorage(usage.used) + ' used · ' + (usage.remaining === null ? 'limit not set' : '~' + formatStorage(usage.remaining) + ' left');
  meter.hidden = usage.capacity === null;
  meter.value = usage.percent || 0;
  $('vaultStorage').classList.toggle('storage-full', usage.capacity !== null && usage.used >= usage.capacity);
  $('vaultStorage').title = 'Estimated Vault data size, including encoded images and metadata. ' + (usage.capacity === null ? 'Set a budget to calculate space left.' : 'Remaining space is relative to your Vault budget, not a Firebase account quota.');
}
function openStorageSettings() {
  const body = openDialog('Vault storage');
  body.append(element('p', 'dialog-help', 'Usage estimates the Vault’s stored data, including images and metadata. Firebase’s account quota is not available to this app. Set your own Vault budget to calculate space left.'));
  const form = element('form');
  const label = element('label', '', 'Vault budget (MB)');
  const input = element('input'); input.type = 'number'; input.min = '1'; input.step = 'any'; input.placeholder = 'For example, 1000';
  input.id = 'vaultBudget'; label.htmlFor = input.id;
  input.value = vaultCapacity() ? String(vaultCapacity() / 1000000) : '';
  const error = element('p', 'dialog-error'); error.setAttribute('role', 'alert');
  const save = button('Save budget'); save.type = 'submit';
  form.append(label, input, element('p', 'dialog-help', 'This display budget is saved on this device. It does not change or enforce your Firebase storage plan. Leave blank to clear it.'), error, save);
  form.onsubmit = e => {
    e.preventDefault();
    const value = input.value.trim() ? Number(input.value) * 1000000 : null;
    if (value !== null && (!Number.isFinite(value) || value < 1000000)) { error.textContent = 'Enter at least 1 MB.'; return; }
    try {
      if (value === null) localStorage.removeItem('fade.vault.capacity'); else localStorage.setItem('fade.vault.capacity', String(value));
    } catch { error.textContent = 'This browser could not save the budget.'; return; }
    updateVaultStorage(); closeDialog();
  };
  body.append(form); input.focus();
}
$('vaultStorage').onclick = openStorageSettings;
function button(text, action, className = '') {
  const el = element('button', className, text);
  el.type = 'button';
  if (action) el.addEventListener('click', action);
  return el;
}
function announce(text) { $('announcer').textContent = text; }
function toast(message, action, actionText = 'Undo', duration = 6000) {
  clearTimeout(toastTimeout);
  $('toastMessage').textContent = message;
  $('toast').hidden = false;
  $('toastAction').hidden = !action;
  $('toastAction').textContent = actionText;
  $('toastAction').onclick = action ? async () => {
    $('toast').hidden = true;
    try { await action(); } catch (err) { toast(err.message || 'Could not finish. Please try again.'); }
  } : null;
  toastTimeout = setTimeout(() => { $('toast').hidden = true; $('toastAction').onclick = null; }, duration);
}
$('toastDismiss').onclick = () => { $('toast').hidden = true; clearTimeout(toastTimeout); $('toastAction').onclick = null; };
function requireConnection() {
  if (!db || !connected) throw new Error('Waiting for a connection. Your draft is still here.');
}
function currentGroup(view, id) { return view.groups.find(g => g.id === id) || null; }
function imageContents(item) { return M.imageContents(item); }
function clipLabel(item) { return (item.title || item.filename || (item.type === 'image' ? `${item.attachments?.length || imageContents(item).length} image(s)` : item.content)).slice(0, 90); }
function blobRef(view, key) { return db.ref(`users/${view.scope === 'clips' && girlfriend ? OWNER_UID : currentUid}/fileData/${key}`); }
async function cleanDetachedBlob(view, key) {
  if (!db || !currentUid) return;
  const clip = await scopes.clips.ref.child(key).once('value');
  if (clip.exists()) return;
  if (owner()) {
    const kept = await scopes.vault.ref.child(key).once('value');
    if (kept.exists()) return;
  }
  await blobRef(view, key).remove();
}
function getSelected(view) { return [...view.selected].filter(key => !!view.items[key]); }
function manualMode(view) { return view.sort === 'manual' && !view.query && view.type === 'all'; }

async function patchItem(view, key, patch) {
  requireConnection();
  if (girlfriend && !canEdit(view.items[key])) throw new Error('You can copy this clip, but only its creator can edit it.');
  const result = await view.ref.child(key).transaction(current => M.patchCurrent(current, patch, view.scope, now()), undefined, false);
  if (!result.committed) throw new Error('This clip expired or was removed on another device.');
  return result.snapshot.val();
}
async function applyPatches(view, patches) {
  requireConnection();
  const results = await Promise.allSettled(Object.entries(patches).map(([key, patch]) => patchItem(view, key, patch)));
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) {
    if (results.length === 1) throw failed[0].reason;
    throw new Error(`${results.length - failed.length} of ${results.length} changes saved. Some clips changed or could not sync; please try again.`);
  }
}
function purgeExpired(key, item = scopes.clips.items[key]) {
  if (girlfriend && !canEdit(item)) return;
  expiryQueue.add(key);
  if (!connected || pendingExpiry.has(key)) return;
  pendingExpiry.add(key);
  scopes.clips.ref.child(key).transaction(current => M.isClip(current) && M.expired(current, 'clips', now()) ? null : undefined, undefined, false)
    .then(result => { if (result.committed) { expiryQueue.delete(key); if (['chunked', 'album'].includes(item?.content)) cleanDetachedBlob(scopes.clips, key).catch(() => {}); } })
    .catch(() => { $('status').textContent = 'Expiry sync failed'; });
}
function listen(view) {
  const uid = currentUid;
  view.ref.on('value', snap => {
    if (uid !== currentUid) return;
    const data = snap.val() || {};
    if (view.scope === 'vault') { vaultBytes = M.storageBytes(data); vaultStorageError = false; updateVaultStorage(); }
    view.items = Object.create(null);
    for (const [key, item] of Object.entries(data)) {
      if (!M.isClip(item)) continue;
      if (item.ready === false) {
        if (now() - M.timestamp(item, view.scope) > 24 * 60 * 60 * 1000 && view.scope === 'clips') purgeExpired(key, item);
        continue;
      }
      if (M.expired(item, view.scope, now())) { purgeExpired(key, item); continue; }
      if (view.scope === 'clips') expiryQueue.delete(key);
      view.items[key] = item;
    }
    if (view.scope === 'clips') {
      for (const key of pendingExpiry) if (!data[key]) pendingExpiry.delete(key);
      for (const key of expiryQueue) if (!data[key]) expiryQueue.delete(key);
    }
    render(view);
    tick();
  }, () => {
    if (uid !== currentUid) return;
    if (view.scope === 'vault') { vaultStorageError = true; updateVaultStorage(); }
    view.ui.Count.textContent = 'Could not load clips';
    view.ui.Empty.hidden = false;
    view.ui.Empty.replaceChildren(element('strong', '', 'Could not connect'), element('p', '', 'Check your connection and database access, then reload. Your existing clips have not been changed.'));
    toast('Could not read ' + (view.scope === 'vault' ? 'the vault.' : 'the clipboard.'));
  });
}
function initFirebase() {
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    auth = firebase.auth();
    auth.onAuthStateChanged(async user => {
      stopSession();
      if (!user) { $('signIn').hidden = false; $('signInButton').disabled = false; $('signInButton').textContent = 'Continue with Google'; return; }
      currentUid = user.uid;
      girlfriend = user.emailVerified && user.email?.toLowerCase() === GIRLFRIEND_EMAIL;
      document.body.classList.toggle('girlfriend-theme', girlfriend);
      $('clipsBulkKeep').hidden = !owner();
      $('clipsNewGroup').hidden = girlfriend;
      $('clipsSelect').hidden = girlfriend;
      try { await db.ref(`accounts/${user.uid}`).set(true); }
      catch (err) { $('signInError').textContent = 'Could not set up your private workspace. Deploy the database rules and retry.'; $('signInButton').disabled = false; $('signInButton').textContent = 'Retry setup'; return; }
      if (currentUid !== user.uid) return;
      for (const view of Object.values(scopes)) {
        const prefs = readPreferences(view.scope);
        view.groups = M.groups({}, Array.isArray(prefs.groups) ? prefs.groups : []);
        view.collapsed = new Set(Array.isArray(prefs.collapsed) ? prefs.collapsed.filter(x => typeof x === 'string') : []);
        view.layout = view.scope === 'vault' ? (prefs.layout === 'comfortable' ? 'comfortable' : 'sheet') : prefs.layout === 'list' ? 'list' : 'grid';
        view.sort = ['manual', 'newest', 'oldest', 'title-asc', 'title-desc'].includes(prefs.sort) ? prefs.sort : 'manual';
        const workspaceUid = girlfriend && view.scope === 'clips' ? OWNER_UID : currentUid;
        view.ref = db.ref(`users/${workspaceUid}/${view.scope === 'vault' ? 'kept' : 'clips'}`);
      }
      $('signIn').hidden = true; $('mainWorkspace').hidden = false;
      db.ref('.info/serverTimeOffset').on('value', snap => { clockOffset = Number(snap.val()) || 0; tick(); });
      db.ref('.info/connected').on('value', snap => {
        connected = snap.val() === true;
        $('status').textContent = connected ? 'Synced' : 'Reconnecting…';
        $('status').classList.toggle('online', connected);
        $('vaultStatus').textContent = connected ? 'Synced' : 'Reconnecting…';
        $('vaultStatus').classList.toggle('online', connected);
        if (connected) { pendingExpiry.clear(); for (const key of expiryQueue) purgeExpired(key); tick(); }
      });
      listen(scopes.clips);
      if (owner()) listen(scopes.vault);
    }, err => { $('signInError').textContent = err.message || 'Could not restore sign-in.'; $('signInButton').disabled = false; });
  } catch (err) {
    console.error(err);
    $('signInError').textContent = 'Could not load Firebase. Check your connection and reload.';
    $('signInButton').textContent = 'Reload'; $('signInButton').disabled = false;
    $('status').textContent = 'Connection unavailable';
    for (const view of Object.values(scopes)) view.ui.Count.textContent = 'Connection unavailable';
    toast('Could not connect. Check your connection, then reload.');
  }
}
function stopSession() {
  connected = false;
  clearTimeout(unlockTimer); unlockTimer = null;
  document.body.classList.remove('vault-breaching');
  $('unlockPopup').classList.remove('show', 'breach-ready');
  $('mainWorkspace').classList.remove('breach-ready');
  $('vault').classList.remove('vault-entering', 'vault-preparing');
  cancelDrag(); cancelKeepHold();
  if (dialog.open) closeDialog();
  if (db) { db.ref('.info/serverTimeOffset').off(); db.ref('.info/connected').off(); }
  for (const view of Object.values(scopes)) {
    view.ref?.off(); view.ref = null; view.items = {};
    view.cards.clear(); view.sections.clear(); view.selected.clear(); view.visible = [];
    view.ui.Board.querySelectorAll('.group').forEach(section => section.remove());
    view.ui.Input.value = ''; view.ui.Search.value = ''; view.query = ''; view.type = 'all'; view.ui.Type.value = 'all';
  }
  pendingExpiry.clear(); expiryQueue.clear(); currentUid = null; vaultBytes = null;
  girlfriend = false; document.body.classList.remove('girlfriend-theme');
  $('clipsBulkKeep').hidden = false;
  $('clipsNewGroup').hidden = false;
  $('clipsSelect').hidden = false;
  activeScope = 'clips'; $('mainWorkspace').inert = false; $('vault').hidden = true; $('mainWorkspace').hidden = true; $('signIn').hidden = false;
  $('toast').hidden = true;
}
$('signInButton').onclick = async () => {
  if (!auth) { location.reload(); return; }
  if (auth?.currentUser) { location.reload(); return; }
  $('signInButton').disabled = true; $('signInError').textContent = '';
  try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  catch (err) { $('signInError').textContent = err.code === 'auth/popup-blocked' ? 'Allow popups for this page and try again.' : (err.message || 'Sign-in failed.'); $('signInButton').disabled = false; }
};
document.querySelectorAll('[data-sign-out]').forEach(btn => btn.onclick = () => auth.signOut().catch(err => toast(err.message || 'Could not sign out.')));

function createSection(view, group) {
  const id = group?.id || '';
  const section = element('section', 'group');
  section.dataset.group = id;
  const heading = element('div', 'group-heading');
  const toggle = button('', () => {
    if (view.collapsed.has(id)) view.collapsed.delete(id); else view.collapsed.add(id);
    savePreferences(view); render(view);
  }, 'group-toggle');
  const name = element('span', 'group-name');
  toggle.append(element('span', 'chevron', '⌄'), element('span', 'group-dot'), name);
  const count = element('span', 'group-count');
  const menu = button('•••', () => openGroupDialog(view, currentGroup(view, id)), 'group-menu');
  menu.setAttribute('aria-label', 'Manage group');
  menu.hidden = !id || girlfriend;
  const items = element('div', 'group-items');
  items.id = view.scope + '-group-' + (id || 'unfiled');
  toggle.setAttribute('aria-controls', items.id);
  const empty = element('p', 'drop-empty', 'Drop clips here, or choose this group when adding a clip.');
  items.append(empty);
  heading.append(toggle, count, menu);
  if (view.scope === 'vault') {
    const columns = element('div', 'sheet-columns');
    ['#', 'A · Title', 'B · Content', 'C · Type', 'D · Saved', 'E · Actions'].forEach((label, index) => {
      const cell = element('span');
      if (index === 1 || index === 4) {
        const sortButton = button(label + ' ↕', () => {
          view.sort = index === 1 ? (view.sort === 'title-asc' ? 'title-desc' : 'title-asc') : (view.sort === 'newest' ? 'oldest' : 'newest');
          savePreferences(view); render(view);
        });
        sortButton.dataset.sortColumn = index === 1 ? 'title' : 'date';
        cell.append(sortButton);
      } else cell.textContent = label;
      columns.append(cell);
    });
    section.append(heading, columns, items);
  } else section.append(heading, items);
  const rec = { section, name, toggle, count, items, empty, menu };
  view.sections.set(id, rec);
  return rec;
}
function place(parent, child, index) {
  if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null);
}
function render(view) {
  if (drag?.active && drag.view === view) { drag.needsRender = true; return; }
  const focus = document.activeElement;
  const focusedInside = view.ui.Board.contains(focus);
  const selection = focusedInside && typeof focus.selectionStart === 'number' ? [focus.selectionStart, focus.selectionEnd] : null;
  view.groups = M.groups(view.items, view.groups);
  savePreferences(view);
  for (const [key, card] of view.cards) {
    if (!view.items[key]) { card.el.remove(); view.cards.delete(key); view.selected.delete(key); }
    else card.el.hidden = true;
  }
  view.visible = M.ordered(view.items, view.scope, view.sort).filter(key => {
    const item = view.items[key];
    return M.matches(item, view.query, view.type, currentGroup(view, M.groupId(item))?.name);
  });
  const visibleSet = new Set(view.visible);
  const total = Object.keys(view.items).length;
  const filtered = !!view.query || view.type !== 'all';
  view.ui.Count.textContent = `${filtered ? view.visible.length + ' of ' : ''}${total} clip${total === 1 ? '' : 's'}`;
  view.ui.Board.dataset.layout = view.layout;
  view.ui.Layout.textContent = view.layout === 'grid' ? 'List' : 'Grid';
  view.ui.Layout.setAttribute('aria-label', 'Use ' + (view.layout === 'grid' ? 'list' : 'grid') + ' layout');
  if (view.scope === 'vault') { view.ui.Layout.textContent = view.layout === 'sheet' ? 'Comfortable rows' : 'Compact rows'; view.ui.Layout.setAttribute('aria-label', 'Toggle row density'); }
  view.ui.Sort.value = view.sort;
  const groups = [null, ...view.groups];
  let sectionIndex = 2;
  for (const g of groups) {
    const id = g?.id || '';
    const rec = view.sections.get(id) || createSection(view, g);
    const keys = view.visible.filter(k => M.groupId(view.items[k]) === id);
    const groupTotal = Object.values(view.items).filter(i => M.groupId(i) === id).length;
    rec.name.textContent = g?.name || 'Unfiled';
    rec.section.style.setProperty('--group-color', girlfriend ? pinkColor(id) : g?.color || '#87929b');
    rec.count.textContent = filtered ? `${keys.length}/${groupTotal}` : groupTotal;
    rec.menu.setAttribute('aria-label', 'Manage group: ' + (g?.name || 'Unfiled'));
    rec.section.hidden = filtered ? keys.length === 0 : !id && total === 0 && view.groups.length === 0;
    const collapsed = view.collapsed.has(id) && !filtered;
    for (const control of rec.section.querySelectorAll('[data-sort-column]')) {
      const title = control.dataset.sortColumn === 'title';
      const direction = title ? (view.sort === 'title-asc' ? ' ↑' : view.sort === 'title-desc' ? ' ↓' : ' ↕') : (view.sort === 'oldest' ? ' ↑' : view.sort === 'newest' ? ' ↓' : ' ↕');
      control.textContent = (title ? 'A · Title' : 'D · Saved') + direction;
      control.setAttribute('aria-label', title ? 'Sort by title' : 'Sort by saved date');
    }
    rec.section.classList.toggle('collapsed', collapsed);
    rec.toggle.setAttribute('aria-expanded', String(!collapsed));
    rec.items.hidden = collapsed;
    rec.empty.hidden = keys.length > 0;
    place(view.ui.Board, rec.section, sectionIndex++);
    keys.forEach((key, index) => {
      let card = view.cards.get(key);
      if (!card) { card = createCard(view, key, view.items[key]); view.cards.set(key, card); }
      updateCard(view, card, view.items[key]);
      card.el.hidden = false;
      if (card.rowNumber) card.rowNumber.textContent = String(index + 1);
      place(rec.items, card.el, index);
    });
  }
  for (const [id, rec] of view.sections) {
    if (id && !view.groups.some(g => g.id === id)) { rec.section.remove(); view.sections.delete(id); }
  }
  for (const key of view.selected) if (!visibleSet.has(key)) view.selected.delete(key);
  view.ui.Empty.hidden = filtered ? view.visible.length > 0 : total > 0 || view.groups.length > 0;
  view.ui.Empty.replaceChildren(element('strong', '', filtered ? 'No matching clips' : view.scope === 'vault' ? 'Your kept clips go here' : 'A little space between devices'),
    element('p', '', filtered ? 'Try a different search or choose All types.' : view.scope === 'vault' ? 'Keep something from Fade or add it below. It stays here until you delete it.' : 'Paste text, a link, or an image below. Pick it up on another device before it fades.'));
  updateDestination(view);
  updateSelection(view);
  if (focusedInside && focus.isConnected && !focus.closest('[hidden]') && !dialog.open) {
    focus.focus({ preventScroll: true });
    if (selection) focus.setSelectionRange(...selection);
  }
}
function updateSelection(view) {
  view.ui.Bulk.hidden = !view.selecting;
  view.ui.Select.setAttribute('aria-pressed', String(view.selecting));
  view.ui.Select.textContent = view.selecting ? 'Selecting' : 'Select';
  view.ui.SelectionCount.textContent = view.selected.size + ' selected';
  view.ui.BulkMove.disabled = view.ui.BulkDelete.disabled = view.selected.size === 0;
  const imageCount = getSelected(view).reduce((sum, key) => sum + (view.items[key].attachments?.length || imageContents(view.items[key]).length), 0);
  view.ui.BulkShare.disabled = imageCount === 0;
  view.ui.BulkShare.textContent = imageCount > 1 ? `Share ${imageCount} images` : 'Share image';
  if (view.scope === 'clips') $('clipsBulkKeep').disabled = !owner() || view.selected.size === 0;
  view.ui.SelectAll.textContent = view.visible.length && view.selected.size === view.visible.length ? 'Deselect all' : 'Select all';
  for (const [key, card] of view.cards) {
    card.selector.hidden = view.scope !== 'vault' && !view.selecting;
    card.checkbox.checked = view.selected.has(key);
    card.el.classList.toggle('selected', view.selected.has(key));
  }
}
function updateDestination(view) {
  const select = view.ui.Destination;
  const signature = JSON.stringify(view.groups.map(g => [g.id, g.name]));
  if (select.dataset.signature === signature) return;
  const current = select.value;
  fillGroupOptions(select, view);
  if (currentGroup(view, current)) select.value = current;
  select.dataset.signature = signature;
}
function fillGroupOptions(select, view, includeUnchanged = false) {
  select.replaceChildren();
  if (includeUnchanged) select.add(new Option('Keep current groups', '*'));
  select.add(new Option('Unfiled', ''));
  for (const g of view.groups) select.add(new Option(g.name, g.id));
}

// One active hold across mouse, pen, touch and keyboard. No per-frame JS work.
const KEEP_HOLD_MS = 3000;
let activeKeepHold = null;
function showKeepWarning() {
  const warning = $('keepWarning');
  if (!warning.open) warning.showModal();
  $('keepWarningClose').focus();
}
function cancelKeepHold(warn = false) {
  const hold = activeKeepHold;
  if (!hold) return;
  activeKeepHold = null;
  clearTimeout(hold.timer);
  hold.btn.classList.remove('keep-holding');
  hold.btn.textContent = 'Keep';
  if (warn) showKeepWarning();
}
function bindKeepHold(btn, save, after = () => {}) {
  let consumed = false, busy = false;
  btn.classList.add('keep-hold');
  btn.title = 'Keep';
  btn.setAttribute('aria-label', 'Keep');
  function start(kind, id) {
    if (busy || btn.disabled || $('keepWarning').open) return;
    cancelKeepHold();
    consumed = true;
    const hold = {btn, kind, id, timer: null};
    activeKeepHold = hold;
    // Keep the gesture undisclosed: no countdown, hint, or progress fill.
    hold.timer = setTimeout(async () => {
      if (activeKeepHold !== hold) return;
      if (!btn.isConnected || btn.disabled || document.hidden) { cancelKeepHold(); return; }
      cancelKeepHold();
      busy = true; btn.disabled = true; btn.textContent = 'Keeping…';
      try { await save(); }
      catch (err) { toast(err.message || 'Could not keep this clip.'); }
      finally { busy = false; btn.disabled = false; btn.textContent = 'Keep'; after(); }
    }, KEEP_HOLD_MS);
  }
  btn.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.isPrimary === false) return;
    start('pointer', e.pointerId);
    if (activeKeepHold?.btn === btn) btn.setPointerCapture?.(e.pointerId);
  });
  btn.addEventListener('pointermove', e => {
    if (activeKeepHold?.btn !== btn || activeKeepHold.id !== e.pointerId) return;
    const r = btn.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) cancelKeepHold();
  });
  btn.addEventListener('pointerup', e => {
    if (activeKeepHold?.btn === btn && activeKeepHold.id === e.pointerId) cancelKeepHold(true);
  });
  for (const event of ['pointercancel', 'lostpointercapture', 'blur']) btn.addEventListener(event, () => {
    if (activeKeepHold?.btn === btn) cancelKeepHold();
  });
  btn.addEventListener('keydown', e => {
    if (![' ', 'Enter'].includes(e.key)) return;
    e.preventDefault();
    if (!e.repeat) start('keyboard', e.key);
  });
  btn.addEventListener('keyup', e => {
    if (![' ', 'Enter'].includes(e.key)) return;
    e.preventDefault();
    if (activeKeepHold?.btn === btn && activeKeepHold.kind === 'keyboard' && activeKeepHold.id === e.key) cancelKeepHold(true);
  });
  btn.addEventListener('contextmenu', e => e.preventDefault());
  btn.addEventListener('click', e => {
    e.preventDefault();
    if (consumed) { consumed = false; return; }
    if (!busy) showKeepWarning();
  });
}
window.addEventListener('blur', () => cancelKeepHold());
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelKeepHold(); });
$('keepWarning').addEventListener('cancel', e => e.preventDefault());
$('keepWarning').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
});
$('keepWarningClose').onclick = () => $('keepWarning').close();

function createCard(view, key, item) {
  const el = element('article', 'clip');
  el.dataset.key = key;
  const rec = { key, el, item: null };
  const top = element('div', 'clip-top');
  rec.handle = button('⠿', () => {}, 'drag-handle');
  rec.handle.setAttribute('aria-label', 'Move clip: ' + clipLabel(item));
  rec.handle.title = 'Drag to move. Press Enter for move controls.';
  rec.handle.addEventListener('pointerdown', e => beginDrag(e, view, key));
  rec.handle.addEventListener('click', e => {
    if (Date.now() < (rec.handle.suppressClickUntil || 0)) { e.preventDefault(); return; }
    openItemDialog(view, [key]);
  });
  rec.tag = element('span', 'tag');
  rec.time = element('span', view.scope === 'clips' ? 'timer' : 'kept-date');
  rec.pin = element('span', 'pin-mark', 'Pinned');
  rec.selector = element('label', 'clip-selector');
  rec.checkbox = document.createElement('input');
  rec.checkbox.type = 'checkbox';
  rec.checkbox.setAttribute('aria-label', 'Select clip: ' + clipLabel(item));
  rec.checkbox.onchange = () => {
    if (rec.checkbox.checked) view.selected.add(key); else view.selected.delete(key);
    if (rec.checkbox.checked) view.selecting = true;
    updateSelection(view);
  };
  rec.selector.append(rec.checkbox);
  if (girlfriend) rec.selector.hidden = true;
  top.append(rec.handle, rec.tag, rec.time, rec.pin, rec.selector);
  rec.header = createHeader(view, key, item.title);
  rec.content = element('div', 'clip-content');
  rec.content.dir = 'auto';
  rec.expand = button('Show more', () => {
    const expanded = rec.content.classList.toggle('expanded');
    rec.expand.textContent = expanded ? 'Show less' : 'Show more';
    rec.expand.setAttribute('aria-expanded', String(expanded));
  }, 'expand-button');
  rec.expand.hidden = true;
  rec.expand.setAttribute('aria-expanded', 'false');
  rec.content.id = view.scope + '-content-' + key;
  rec.expand.setAttribute('aria-controls', rec.content.id);
  const actions = element('div', 'clip-actions');
  actions.append(button(item.type === 'file' ? 'Download' : item.content === 'album' || imageContents(item).length > 1 ? 'Open images' : 'Copy', e => rec.item.type === 'file' ? downloadFile(rec.item, view, rec.key) : rec.item.content === 'album' || imageContents(rec.item).length > 1 ? openImages(rec.item, view, rec.key) : copyItem(rec.item, e.currentTarget)));
  if (view.scope === 'clips' && owner()) {
    const keep = button('Keep');
    bindKeepHold(keep, () => keepItems(view, [key]));
    actions.append(keep);
  }
  const more = button('•••', () => openItemDialog(view, [key]), 'more-button');
  more.hidden = girlfriend && !canEdit(item);
  rec.handle.hidden = girlfriend;
  more.setAttribute('aria-label', 'Organize clip: ' + clipLabel(item));
  actions.append(more);
  if (view.scope === 'vault') {
    rec.rowNumber = element('span', 'row-number');
    const row = element('div', 'sheet-index'); row.append(rec.rowNumber, rec.selector, rec.handle);
    const preview = element('div', 'sheet-preview'); preview.append(rec.content, rec.expand);
    const type = element('div', 'sheet-type'); type.append(rec.tag, rec.pin);
    el.append(row, rec.header.el, preview, type, rec.time, actions);
  } else el.append(top, rec.header.el, rec.content, rec.expand, actions);
  if (view.scope === 'clips') {
    const track = element('div', 'progress-track');
    rec.progress = element('div', 'progress-fill');
    track.setAttribute('aria-hidden', 'true');
    track.append(rec.progress); el.append(track);
  }
  updateCard(view, rec, item);
  return rec;
}
function updateCard(view, rec, item) {
  const contentChanged = !rec.item || item.type !== rec.item.type || item.content !== rec.item.content || JSON.stringify(item.images) !== JSON.stringify(rec.item.images);
  rec.item = item;
  rec.tag.textContent = item.type === 'image' && (item.attachments?.length || imageContents(item).length) > 1 ? (item.attachments?.length || imageContents(item).length) + ' images' : item.type;
  rec.el.style.setProperty('--card-color', girlfriend ? pinkColor(item.color || rec.key) : M.color(item.color) || M.defaultColor(rec.key));
  rec.el.setAttribute('aria-label', clipLabel(item));
  rec.handle.setAttribute('aria-label', 'Move clip: ' + clipLabel(item));
  rec.checkbox.setAttribute('aria-label', 'Select clip: ' + clipLabel(item));
  rec.pin.hidden = !item.pinned;
  rec.header.updateTitle(item.title);
  if (view.scope === 'vault') {
    const stamp = M.timestamp(item, view.scope);
    rec.time.textContent = stamp ? new Date(stamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Kept';
    rec.time.title = stamp ? new Date(stamp).toLocaleString() : 'No expiry';
  }
  if (contentChanged) {
    rec.content.replaceChildren();
    rec.content.classList.remove('expanded');
    rec.expand.textContent = 'Show more';
    rec.expand.setAttribute('aria-expanded', 'false');
    renderContent(rec.content, item, view, rec.key);
    const img = rec.content.querySelector('img');
    if (img) img.onload = () => checkExpand(rec);
    requestAnimationFrame(() => checkExpand(rec));
  }
}
function checkExpand(rec) {
  if (!rec.content.clientHeight) return;
  const image = rec.content.querySelector('img');
  const fullImageHeight = image?.naturalWidth ? Math.min(image.naturalWidth, rec.content.clientWidth) * image.naturalHeight / image.naturalWidth : 0;
  const thumbnail = image && image.clientHeight + 3 < fullImageHeight;
  rec.expand.hidden = !rec.content.classList.contains('expanded') && rec.content.scrollHeight <= rec.content.clientHeight + 3 && !thumbnail;
}
async function albumImage(view, key, index, info) {
  const parts = [];
  for (let part = 0; part < info.parts; part++) {
    const encoded = (await blobRef(view, key).child(`a${index}_${part}`).once('value')).val();
    if (typeof encoded !== 'string') throw new Error('An image part is missing.');
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    parts.push(bytes);
  }
  return new File(parts, info.name || `image-${index + 1}`, {type: info.mime});
}
function showAlbumImage(img, view, key, index, info) {
  albumImage(view, key, index, info).then(file => {
    if (!img.isConnected) return;
    const url = URL.createObjectURL(file);
    img.src = url;
    img.onload = () => URL.revokeObjectURL(url);
  }).catch(() => { if (img.isConnected) img.alt = 'Image unavailable'; });
}
function openImages(item, view, key) {
  const body = openDialog(item.title || 'Image collection');
  if (item.content === 'album') {
    body.append(button('Share all images', () => shareImages(item.attachments.map((_, index) => ({album: true, view, key, index, item})))));
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        const index = Number(entry.target.dataset.index);
        showAlbumImage(entry.target, view, key, index, item.attachments[index]);
      }
    }, {root: dialog, rootMargin: '200px'});
    dialog.addEventListener('close', () => observer.disconnect(), {once: true});
    item.attachments.forEach((info, index) => {
      const block = element('div', 'gallery-item');
      const img = element('img'); img.alt = info.name || 'Image ' + (index + 1); img.dataset.index = index;
      block.append(img, element('span', 'file-name', info.name || `Image ${index + 1}`),
        button('Copy image ' + (index + 1), async e => {
          try { const file = await albumImage(view, key, index, info); await copyItem({type:'image', content: await readDataURL(file)}, e.currentTarget); }
          catch { toast('Could not copy this image.'); }
        }), button('Download', async () => {
          try { const file = await albumImage(view, key, index, info); downloadBlob(file); }
          catch { toast('Could not download this image.'); }
        }));
      body.append(block); observer.observe(img);
    });
    return;
  }
  body.append(button('Share all images', () => shareImages(imageContents(item).map(content => ({type:'image', content})))));
  imageContents(item).forEach((content, index) => {
    const block = element('div', 'gallery-item');
    const img = element('img'); img.src = content; img.alt = 'Image ' + (index + 1);
    block.append(img, button('Copy image ' + (index + 1), e => copyItem({type:'image', content}, e.currentTarget)), button('Download', () => downloadImage({content})));
    body.append(block);
  });
}
function renderContent(el, item, view, key) {
  if (item.content === 'album' && Array.isArray(item.attachments)) {
    const gallery = button('', () => openImages(item, view, key), 'image-collection');
    gallery.setAttribute('aria-label', `Open all ${item.attachments.length} images`);
    item.attachments.slice(0, 4).forEach((info, index) => {
      const img = element('img'); img.alt = info.name || `Image ${index + 1}`;
      gallery.append(img); showAlbumImage(img, view, key, index, info);
    });
    el.append(gallery, element('span', 'collection-count', `${item.attachments.length} images · Open collection`));
    return;
  }
  if (imageContents(item).length > 1) {
    const gallery = button('', () => openImages(item), 'image-collection');
    gallery.setAttribute('aria-label', 'Open all ' + imageContents(item).length + ' images');
    imageContents(item).slice(0, 4).forEach((content, index) => {
      const img = element('img'); img.src = content; img.alt = 'Image ' + (index + 1); img.loading = 'lazy'; gallery.append(img);
    });
    el.append(gallery, element('span', 'collection-count', imageContents(item).length + ' images · Open collection'));
    return;
  }
  if (item.type === 'image' && /^data:image\/(jpeg|png|webp|gif);base64,/i.test(item.content)) {
    const img = document.createElement('img');
    img.src = item.content; img.alt = item.title || 'Clipboard image'; img.loading = 'lazy';
    el.append(img);
  } else if (item.type === 'file') {
    el.append(element('strong', 'file-name', item.filename || 'Attachment'), element('span', 'file-size', ' · ' + formatStorage(item.fileSize || 0)));
  } else if (item.type === 'link' && M.safeLink(item.content)) {
    const a = element('a', 'compact-link', M.linkPreview(item.content));
    a.href = M.safeLink(item.content); a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', 'Open link: ' + M.linkPreview(item.content));
    el.append(a);
  } else el.textContent = item.type === 'image' ? 'Image unavailable' : item.content;
}
function tick() {
  const view = scopes.clips;
  let changed = false;
  for (const [key, item] of Object.entries(view.items)) {
    if (M.expired(item, 'clips', now())) { delete view.items[key]; purgeExpired(key); changed = true; continue; }
    const rec = view.cards.get(key);
    if (!rec) continue;
    const stamp = M.timestamp(item, 'clips');
    if (!stamp) { rec.time.textContent = 'Syncing time…'; continue; }
    const remaining = Math.max(0, Math.min(M.TTL, M.TTL - (now() - stamp)));
    const frac = remaining / M.TTL;
    rec.time.textContent = `${Math.floor(remaining / 60000)}:${String(Math.floor(remaining % 60000 / 1000)).padStart(2, '0')}`;
    rec.time.className = 'timer' + (remaining < 30000 ? ' danger' : remaining < 120000 ? ' warn' : '');
    rec.time.title = 'Expires ' + new Date(stamp + M.TTL).toLocaleTimeString();
    rec.content.style.opacity = String(.72 + .28 * frac);
    rec.progress.style.transform = `scaleX(${frac})`;
  }
  if (changed) render(view);
}

function createHeader(view, key, initialTitle){
  let savedTitle = '';
  let saving = false;

  const el = document.createElement('div');
  el.className = 'vheader';

  const titleBtn = document.createElement('button');
  titleBtn.type = 'button';
  titleBtn.className = 'vheader-button';
  titleBtn.setAttribute('aria-expanded', 'false');
  const titleText = document.createElement('span');
  titleText.className = 'vheader-text';
  titleText.dir = 'auto';
  const editHint = document.createElement('span');
  editHint.className = 'vheader-edit';
  editHint.textContent = 'edit';
  editHint.setAttribute('aria-hidden', 'true');
  titleBtn.append(titleText, editHint);

  const editor = document.createElement('form');
  editor.className = 'vheader-editor';
  editor.id = view.scope + '-header-editor-' + key;
  editor.hidden = true;
  titleBtn.setAttribute('aria-controls', editor.id);

  const label = document.createElement('label');
  label.textContent = 'Header / summary';
  const input = document.createElement('input');
  input.className = 'vheader-input';
  input.id = view.scope + '-header-' + key;
  input.type = 'text';
  input.maxLength = MAX_HEADER_LENGTH;
  input.autocomplete = 'off';
  input.placeholder = 'e.g. Important — project notes';
  input.enterKeyHint = 'done';
  input.dir = 'auto';
  label.htmlFor = input.id;

  const help = document.createElement('p');
  help.className = 'vheader-help';
  help.id = input.id + '-help';
  help.textContent = 'Up to ' + MAX_HEADER_LENGTH + ' characters. Clear and save to remove the header.';
  input.setAttribute('aria-describedby', help.id);

  const controls = document.createElement('div');
  controls.className = 'vheader-controls';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Save';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  controls.append(saveBtn, cancelBtn);

  const status = document.createElement('p');
  status.className = 'vheader-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  editor.append(label, input, help, controls, status);
  el.append(titleBtn, editor);

  function setStatus(message){
    status.textContent = message;
    status.hidden = !message;
  }

  function updateTitle(value){
    const title = typeof value === 'string' ? value : '';
    if(title !== savedTitle && !editor.hidden && !saving){
      setStatus('Header changed on another device. Save to use your draft, or Cancel to use the synced header.');
    }
    savedTitle = title;
    titleText.textContent = title || '+ add header';
    editHint.hidden = !title;
    titleBtn.classList.toggle('is-empty', !title);
    titleBtn.setAttribute('aria-label', title ? 'Edit header: ' + title : 'Add header');
  }

  function closeEditor(){
    const restoreFocus = el.contains(document.activeElement) || document.activeElement === document.body;
    editor.hidden = true;
    titleBtn.hidden = false;
    titleBtn.setAttribute('aria-expanded', 'false');
    setStatus('');
    if(restoreFocus && el.isConnected && activeScope === view.scope) titleBtn.focus();
  }

  titleBtn.onclick = () => {
    input.value = savedTitle;
    setStatus('');
    titleBtn.hidden = true;
    titleBtn.setAttribute('aria-expanded', 'true');
    editor.hidden = false;
    input.focus();
    input.select();
  };
  cancelBtn.onclick = closeEditor;
  input.addEventListener('keydown', e => {
    if(e.isComposing){
      if(e.key === 'Enter') e.preventDefault();
      return;
    }
    if(e.key === 'Escape' && !saving){
      e.preventDefault();
      closeEditor();
    }
  });
  input.addEventListener('paste', e => e.stopPropagation());

  editor.addEventListener('submit', async e => {
    e.preventDefault();
    if(saving) return;
    const title = input.value.trim();
    if(title.length > MAX_HEADER_LENGTH){
      setStatus('Please keep the header to ' + MAX_HEADER_LENGTH + ' characters.');
      return;
    }
    if(title === savedTitle){ closeEditor(); return; }
    saving = true;
    input.readOnly = true;
    saveBtn.disabled = cancelBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    editor.setAttribute('aria-busy', 'true');
    setStatus('Saving header…');
    try{
      const result = await patchItem(view, key, {title: title || null});
      updateTitle(result.title);
      closeEditor();
    }catch(err){
      console.error('saveVaultHeader failed:', err);
      setStatus(err.message || 'Could not save the header. Your draft is still here; please try again.');
    }finally{
      saving = false;
      input.readOnly = false;
      saveBtn.disabled = cancelBtn.disabled = false;
      saveBtn.textContent = 'Save';
      editor.removeAttribute('aria-busy');
    }
  });

  updateTitle(initialTitle);
  return { el, updateTitle };
}


let dialogVersion = 0;
function closeDialog() {
  dialog.close();
  if (!document.activeElement || document.activeElement === document.body || document.activeElement.closest('[hidden]')) scopes[activeScope].ui.Input.focus({ preventScroll: true });
}
$('dialogClose').onclick = closeDialog;
function openDialog(title) {
  dialogVersion++;
  $('dialogTitle').textContent = title;
  $('dialogBody').replaceChildren();
  if (!dialog.open) dialog.showModal();
  return $('dialogBody');
}
function field(labelText, input) {
  const label = element('label', 'field', labelText);
  label.append(input); return label;
}
function swatches(initial, pink = girlfriend) {
  let selected = initial;
  const el = element('div', 'swatches');
  el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Color');
  for (const [name, hex] of pink ? M.PINK_COLORS : M.COLORS) {
    const choice = button('', () => {
      selected = hex;
      for (const child of el.children) child.setAttribute('aria-pressed', String(child === choice));
    }, 'swatch');
    choice.style.setProperty('--swatch', hex);
    choice.title = name; choice.setAttribute('aria-label', name);
    choice.setAttribute('aria-pressed', String(hex === selected));
    el.append(choice);
  }
  return { el, value: () => selected };
}
async function dialogAction(action) {
  const version = dialogVersion;
  const buttons = [...$('dialogBody').querySelectorAll('button, input, select')];
  const states = buttons.map(el => el.disabled);
  buttons.forEach(el => { el.disabled = true; });
  let error = $('dialogBody').querySelector('.dialog-error');
  if (!error) { error = element('p', 'dialog-error'); error.setAttribute('role', 'alert'); $('dialogBody').append(error); }
  error.textContent = 'Saving…';
  try {
    await action();
    if (version === dialogVersion && dialog.open) closeDialog();
  } catch (err) {
    if (version === dialogVersion && dialog.open) error.textContent = err.message || 'Could not save. Please try again.';
    else toast(err.message || 'Could not save. Please try again.');
  } finally { buttons.forEach((el, i) => { el.disabled = states[i]; }); }
}

function openItemDialog(view, requestedKeys) {
  const keys = requestedKeys.filter(key => !!view.items[key]);
  if (!keys.length) { toast('These clips are no longer available.'); return; }
  const single = keys.length === 1, item = view.items[keys[0]];
  const body = openDialog(single ? 'Organize clip' : `Organize ${keys.length} clips`);
  const description = element('p', '', single ? clipLabel(item) : 'Apply changes to the selected clips.');
  body.append(description);
  const destination = document.createElement('select');
  fillGroupOptions(destination, view, !single);
  destination.value = single ? M.groupId(item) : '*';
  body.append(field('Group', destination));
  const colors = swatches(single ? M.color(item.color) || M.defaultColor(keys[0]) : '', single && item.authorEmail === GIRLFRIEND_EMAIL);
  body.append(element('p', '', single ? 'Color label' : 'Color label · leave unchanged or choose a color'), colors.el);
  const pin = document.createElement('select');
  if (!single) pin.add(new Option('Keep pin status', '*'));
  pin.add(new Option('Normal position', 'no')); pin.add(new Option('Pin to top of group', 'yes'));
  pin.value = single ? (item.pinned ? 'yes' : 'no') : '*';
  body.append(field('Position', pin));
  if (view.scope === 'clips') body.append(element('p', 'dialog-help', owner() ? 'Pinned clips still expire after 10 minutes. Use Keep to save a clip in the vault.' : 'Pinned clips still expire after 10 minutes.'));
  if (single) {
    const lane = M.ordered(view.items, view.scope).filter(k => M.groupId(view.items[k]) === M.groupId(item) && !!view.items[k].pinned === !!item.pinned);
    const index = lane.indexOf(keys[0]);
    const row = element('div', 'move-buttons');
    for (const [label, direction] of [['Move earlier', -1], ['Move later', 1]]) {
      const control = button(label, () => dialogAction(async () => {
        if (!view.items[keys[0]]) throw new Error('This clip is no longer available.');
        const before = direction < 0 ? lane[index - 1] : lane[index + 2] || null;
        const g = currentGroup(view, M.groupId(view.items[keys[0]]));
        await applyPatches(view, M.movePlan(view.items, view.scope, keys, g, before));
        view.sort = 'manual'; savePreferences(view); render(view); toast('Clip moved.');
      }));
      control.disabled = direction < 0 ? index <= 0 : index >= lane.length - 1;
      row.append(control);
    }
    body.append(element('p', 'dialog-help', 'Quick move within the current group. Pinned clips stay at the top.'), row);
  }
  const actions = element('div', 'dialog-actions');
  actions.append(button('Delete', () => confirmDelete(view, keys), 'danger-button'), button('Cancel', closeDialog));
  actions.append(button('Save changes', () => dialogAction(async () => {
    if (keys.some(key => !view.items[key])) throw new Error('Some selected clips expired or were removed. Close this menu and select the remaining clips.');
    const destinationId = destination.value;
    const g = currentGroup(view, destinationId);
    if (destinationId !== '*' && destinationId && !g) throw new Error('That group was removed. Choose another group.');
    let patches = {};
    if (destinationId !== '*' && keys.some(k => M.groupId(view.items[k] || {}) !== destinationId)) patches = M.movePlan(view.items, view.scope, keys, g);
    for (const key of keys) {
      patches[key] = { ...(patches[key] || {}) };
      if (colors.value()) patches[key].color = colors.value();
      if (pin.value !== '*') patches[key].pinned = pin.value === 'yes';
    }
    await applyPatches(view, patches);
    if (destinationId !== '*') view.collapsed.delete(destinationId);
    savePreferences(view); render(view); toast(single ? 'Clip updated.' : 'Clips updated.');
  }), 'primary'));
  body.append(actions);
  destination.focus();
}

function groupKey() {
  return typeof crypto.randomUUID === 'function' ? 'g-' + crypto.randomUUID() : 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}
async function commitGroup(view, nextGroup) {
  const patches = {};
  for (const [key, item] of Object.entries(view.items)) if (M.groupId(item) === nextGroup.id) patches[key] = { group: nextGroup };
  if (Object.keys(patches).length) await applyPatches(view, patches);
  view.groups = [...view.groups.filter(g => g.id !== nextGroup.id), nextGroup];
  savePreferences(view); render(view);
}
function openGroupDialog(view, group = null) {
  const body = openDialog(group ? 'Manage group' : 'New group');
  const name = document.createElement('input');
  name.type = 'text'; name.maxLength = 60; name.value = group?.name || ''; name.placeholder = 'e.g. Work, Links, Ideas';
  name.autocomplete = 'off'; name.dir = 'auto';
  body.append(field('Group name', name));
  const colors = swatches(group?.color || M.COLORS[view.groups.length % M.COLORS.length][1]);
  body.append(element('p', '', 'Group color'), colors.el);
  const applyColor = document.createElement('input'); applyColor.type = 'checkbox';
  const colorLabel = element('label', 'check-field'); colorLabel.append(applyColor, document.createTextNode('Also recolor clips in this group'));
  if (group) body.append(colorLabel);
  body.append(element('p', 'dialog-help', 'Groups sync with their clips. Empty groups and collapsed sections stay on this device.'));
  if (group) {
    const index = view.groups.findIndex(g => g.id === group.id);
    const row = element('div', 'move-buttons');
    for (const [label, direction] of [['Move group up', -1], ['Move group down', 1]]) {
      const control = button(label, () => dialogAction(async () => {
        const list = [...view.groups];
        const from = list.findIndex(g => g.id === group.id), to = from + direction;
        if (from < 0 || to < 0 || to >= list.length) throw new Error('The group order changed. Please reopen this menu.');
        [list[from], list[to]] = [list[to], list[from]];
        const version = now();
        for (let i = 0; i < list.length; i++) await commitGroup(view, { ...list[i], order: i * 1024, updatedAt: Math.max(version, list[i].updatedAt + 1) });
        toast('Group moved.');
      }));
      control.disabled = direction < 0 ? index === 0 : index === view.groups.length - 1;
      row.append(control);
    }
    body.append(row);
  }
  const actions = element('div', 'dialog-actions');
  if (group) actions.append(button('Remove group', () => {
    const confirmation = openDialog('Remove group?');
    confirmation.append(element('p', '', `Clips in “${group.name}” will move to Unfiled. The clips themselves will stay.`));
    const buttons = element('div', 'dialog-actions');
    buttons.append(button('Cancel', closeDialog), button('Remove group', () => dialogAction(async () => {
      const keys = Object.keys(view.items).filter(k => M.groupId(view.items[k]) === group.id);
      if (keys.length) await applyPatches(view, M.movePlan(view.items, view.scope, keys, null));
      view.groups = view.groups.filter(g => g.id !== group.id);
      view.collapsed.delete(group.id); savePreferences(view); render(view);
      toast('Group removed. Clips moved to Unfiled.');
    }), 'danger-button'));
    confirmation.append(buttons);
  }, 'danger-button'));
  actions.append(button('Cancel', closeDialog), button(group ? 'Save group' : 'Create group', () => dialogAction(async () => {
    const trimmed = name.value.trim();
    if (!trimmed) throw new Error('Give this group a name.');
    if (view.groups.some(g => g.id !== group?.id && g.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) throw new Error('A group with that name already exists.');
    const current = group ? currentGroup(view, group.id) : null;
    if (group && !current) throw new Error('This group was removed. Please create a new group.');
    const next = { id: group?.id || groupKey(), name: trimmed, color: colors.value(),
      order: current?.order ?? ((view.groups.at(-1)?.order || 0) + 1024), updatedAt: Math.max(now(), (current?.updatedAt || 0) + 1) };
    await commitGroup(view, next);
    if (group && applyColor.checked) {
      const patches = Object.fromEntries(Object.keys(view.items).filter(k => M.groupId(view.items[k]) === group.id).map(k => [k, { color: colors.value() }]));
      await applyPatches(view, patches);
    }
    if (!group) view.ui.Destination.value = next.id;
    toast(group ? 'Group updated.' : 'Group created. New clips will go here.');
  }), 'primary'));
  body.append(actions);
  name.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); actions.lastElementChild.click(); }
  });
  name.focus();
}

async function keepItems(view, keys) {
  requireConnection();
  if (!owner()) throw new Error('Only the owner can keep clips.');
  let count = 0, changed = 0;
  for (const key of keys) {
    const snap = await view.ref.child(key).once('value');
    const item = snap.val();
    if (!M.isClip(item) || M.expired(item, view.scope, now())) continue;
    const kept = { ...item, keptAt: firebase.database.ServerValue.TIMESTAMP, order: -now() };
    const result = await scopes.vault.ref.child(key).transaction(current => current === null ? kept : undefined, undefined, false);
    // A prior attempt may have kept a different revision. Never replace it or erase the source.
    if (!result.committed) { changed++; continue; }
    const removed = await view.ref.child(key).transaction(current => {
      if (!M.isClip(current)) return;
      if ((Number(current.revision) || 0) !== (Number(item.revision) || 0) || current.content !== item.content) return;
      return null;
    }, undefined, false);
    count++;
    if (!removed.committed) changed++;
  }
  if (count) toast(`${count} clip${count === 1 ? '' : 's'} kept in the vault.${changed ? ' Changed source clips were left in place.' : ''}`);
  else toast(changed ? 'Already kept or changed on another device. Source clips were left in place.' : 'These clips already expired or were removed.');
}
function confirmDelete(view, keys) {
  const body = openDialog(`Delete ${keys.length === 1 ? 'this clip' : keys.length + ' clips'}?`);
  body.append(element('p', '', 'This removes the selected clips from every device. You can undo for 10 seconds; expired clips cannot be restored.'));
  const actions = element('div', 'dialog-actions');
  actions.append(button('Cancel', closeDialog), button('Delete', () => dialogAction(async () => {
    requireConnection();
    const deleted = [];
    const results = await Promise.allSettled(keys.map(async key => {
      let record;
      const result = await view.ref.child(key).transaction(current => {
        if (!M.isClip(current)) return;
        record = current; return null;
      }, undefined, false);
      if (result.committed && record) deleted.push({ key, item: record });
    }));
    const failures = results.filter(r => r.status === 'rejected').length;
    if (!deleted.length) {
      if (failures) throw new Error('Could not delete. Please try again.');
      toast('These clips were already removed.'); return;
    }
    const undoUntil = Date.now() + 10000;
    toast(`${deleted.length} deleted.${failures ? ` ${failures} could not be deleted.` : ''}`, async () => {
      requireConnection();
      if (Date.now() > undoUntil) { toast('The undo window has ended.'); return; }
      let restored = 0;
      for (const { key, item } of deleted) {
        if (M.expired(item, view.scope, now())) continue;
        const result = await view.ref.child(key).transaction(current => current === null && !M.expired(item, view.scope, now()) ? item : undefined, undefined, false);
        if (result.committed) restored++;
      }
      toast(`${restored} restored.${restored < deleted.length ? ' Other clips expired or were already restored.' : ''}`);
    }, 'Undo', 10000);
    setTimeout(() => { for (const { key, item } of deleted) if (['chunked', 'album'].includes(item.content)) cleanDetachedBlob(view, key).catch(() => {}); }, 11_000);
  }), 'danger-button'));
  body.append(actions);
}

function beginDrag(e, view, key) {
  if (e.button !== 0 || !view.items[key]) return;
  if (!manualMode(view)) { toast('Choose Your order and clear filters to drag. You can also use the Move menu.'); return; }
  if (drag) cancelDrag();
  drag = { view, key, handle: e.currentTarget, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
    x: e.clientX, y: e.clientY, active: false, target: null, frame: null };
  e.currentTarget.setPointerCapture?.(e.pointerId);
}
function clearDropMarkers(view) {
  for (const rec of view.sections.values()) rec.section.classList.remove('drop-target');
  for (const rec of view.cards.values()) rec.el.classList.remove('drop-before', 'drop-after');
}
function locateDrop() {
  if (!drag?.active) return;
  const { view, key, x, y } = drag;
  clearDropMarkers(view);
  drag.target = null;
  const under = document.elementFromPoint(x, y);
  const section = under?.closest('.group');
  if (!section || !view.ui.Board.contains(section)) return;
  const groupId = section.dataset.group;
  const card = under.closest('.clip');
  let before = null;
  if (card && card.dataset.key !== key) {
    const rect = card.getBoundingClientRect();
    const after = view.layout === 'grid' && window.innerWidth > 700 ? x > rect.left + rect.width / 2 : y > rect.top + rect.height / 2;
    const keys = M.ordered(view.items, view.scope).filter(k => M.groupId(view.items[k]) === groupId && k !== key);
    before = after ? keys[keys.indexOf(card.dataset.key) + 1] || null : card.dataset.key;
    card.classList.add(after ? 'drop-after' : 'drop-before');
  } else if (card?.dataset.key === key) return;
  section.classList.add('drop-target');
  drag.target = { groupId, before };
}
function dragFrame() {
  if (!drag?.active) return;
  const rect = drag.view.ui.Scroll.getBoundingClientRect();
  let step = 0;
  if (drag.y < rect.top + 64) step = -Math.min(18, (rect.top + 64 - drag.y) / 4);
  else if (drag.y > rect.bottom - 64) step = Math.min(18, (drag.y - rect.bottom + 64) / 4);
  if (step) drag.view.ui.Scroll.scrollTop += step;
  locateDrop();
  drag.frame = requestAnimationFrame(dragFrame);
}
document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.x = e.clientX; drag.y = e.clientY;
  if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 8) return;
  e.preventDefault();
  if (!drag.active) {
    drag.active = true;
    drag.ghost = element('div', 'drag-ghost', clipLabel(drag.view.items[drag.key]));
    drag.ghost.setAttribute('aria-hidden', 'true');
    document.body.append(drag.ghost);
    document.body.classList.add('is-dragging');
    drag.view.cards.get(drag.key)?.el.classList.add('dragging');
    announce('Moving clip. Drop in a group. Press Escape to cancel.');
    drag.frame = requestAnimationFrame(dragFrame);
  }
  drag.ghost.style.left = Math.max(8, Math.min(window.innerWidth - 268, drag.x + 12)) + 'px';
  drag.ghost.style.top = Math.max(8, Math.min(window.innerHeight - 60, drag.y + 16)) + 'px';
  locateDrop();
}, { passive: false });
function clearDrag() {
  const previous = drag;
  if (!previous) return null;
  drag = null;
  if (previous.frame) cancelAnimationFrame(previous.frame);
  previous.ghost?.remove();
  clearDropMarkers(previous.view);
  previous.view.cards.get(previous.key)?.el.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
  if (previous.active) previous.handle.suppressClickUntil = Date.now() + 500;
  if (previous.handle.hasPointerCapture?.(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
  render(previous.view);
  return previous;
}
function cancelDrag() { if (clearDrag()?.active) announce('Move cancelled.'); }
document.addEventListener('pointercancel', e => { if (drag?.pointerId === e.pointerId) cancelDrag(); });
document.addEventListener('lostpointercapture', e => { if (drag?.pointerId === e.pointerId) cancelDrag(); });
document.addEventListener('pointerup', async e => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const previous = clearDrag();
  if (!previous.active || !previous.target) return;
  const { view, key, target } = previous;
  if (!view.items[key]) { toast('This clip expired or was removed while you were moving it.'); return; }
  try {
    const destination = currentGroup(view, target.groupId);
    if (target.groupId && !destination) throw new Error('This group is no longer available.');
    await applyPatches(view, M.movePlan(view.items, view.scope, [key], destination, target.before));
    view.collapsed.delete(target.groupId); savePreferences(view); render(view);
    announce('Moved to ' + (destination?.name || 'Unfiled'));
  } catch (err) { toast(err.message || 'Could not move the clip.'); }
});

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This image could not be opened. Try a JPEG, PNG, or WebP file.'));
    img.src = source;
  });
}
async function imagePng(content) {
  const img = await loadImage(content);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not copy this image.')), 'image/png'));
}
function downloadImage(item) {
  const a = document.createElement('a'); a.href = item.content;
  const match = /^data:image\/(png|jpeg|webp|gif);base64,/i.exec(item.content);
  const extension = match?.[1]?.toLowerCase() === 'jpeg' ? 'jpg' : (match?.[1]?.toLowerCase() || 'png');
  a.download = 'fade-image.' + extension;
  document.body.append(a); a.click(); a.remove();
}
function downloadBlob(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a'); a.href = url; a.download = file.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
async function downloadFile(item, view, key) {
  if (item.content !== 'chunked' && !/^data:application\/octet-stream;base64,[A-Za-z0-9+/=]+$/.test(item.content)) { toast('File unavailable.'); return; }
  try {
    const parts = [];
    const count = item.content === 'chunked' ? item.chunkCount : 1;
    for (let index = 0; index < count; index++) {
      const encoded = item.content === 'chunked' ? (await blobRef(view, key).child(String(index)).once('value')).val() : item.content.split(',')[1];
      if (typeof encoded !== 'string') throw new Error('A file part is missing.');
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      parts.push(bytes);
    }
    const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
    const a = document.createElement('a'); a.href = url; a.download = item.filename || 'attachment';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch { toast('Could not download this file. Check your connection and try again.'); }
}

function imageFile(item, index) {
  const match = /^data:image\/(png|jpeg|webp|gif);base64,/i.exec(item.content);
  if (!match) throw new Error('One of the selected images is unavailable.');
  const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const binary = atob(item.content.slice(item.content.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], `fade-image-${index + 1}.${extension}`, { type: `image/${match[1].toLowerCase()}` });
}

async function shareSelectedImages(view) {
  const items = getSelected(view).flatMap(key => {
    const item = view.items[key];
    return item.content === 'album' ? item.attachments.map((_, index) => ({album: true, view, key, index, item}))
      : imageContents(item).map(content => ({type:'image', content}));
  });
  return shareImages(items);
}
async function shareImages(items) {
  if (!items.length) { toast('Select at least one image to share.'); return; }
  let files;
  try { files = await Promise.all(items.map((item, index) => item.album
    ? albumImage(item.view, item.key, item.index, item.item.attachments[item.index]) : imageFile(item, index))); }
  catch (err) { toast(err.message); return; }

  if (navigator.share && (!navigator.canShare || navigator.canShare({ files }))) {
    try {
      await navigator.share({ files, title: files.length === 1 ? 'Image from Fade' : `${files.length} images from Fade` });
      announce(`${files.length} image${files.length === 1 ? '' : 's'} shared.`);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  if (items.length === 1) {
    if (items[0].album) downloadBlob(files[0]); else downloadImage(items[0]);
    toast('Sharing is unavailable in this browser. The image was downloaded instead.');
    return;
  }
  toast('This browser cannot share multiple images. Download them one at a time from each image card.', null, 'Undo', 9000);
}
async function copyItem(item, btn) {
  try {
    if (item.type === 'image') {
      if (!/^data:image\/(jpeg|png|webp|gif);base64,/i.test(item.content)) throw new Error('Image unavailable.');
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image copying is unavailable.');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': imagePng(item.content) })]);
    } else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(item.content);
    else {
      const active = document.activeElement;
      const input = element('textarea', 'sr-only'); input.value = item.content; document.body.append(input); input.select();
      const copied = document.execCommand('copy'); input.remove(); active?.focus({ preventScroll: true });
      if (!copied) throw new Error('Copy unavailable.');
    }
    const original = btn.dataset.originalText || btn.textContent;
    btn.dataset.originalText = original; btn.textContent = 'Copied'; btn.classList.add('copied');
    clearTimeout(btn.copyTimeout);
    btn.copyTimeout = setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1400);
    announce('Copied to clipboard.');
  } catch {
    if (item.type === 'image' && /^data:image\/(jpeg|png|webp|gif);base64,/i.test(item.content)) toast('This browser could not copy the image.', () => downloadImage(item), 'Save image');
    else toast('Copy was blocked. Select the text and copy it manually.');
  }
}
function looksLikeUrl(text) { return /^(https?:\/\/|www\.)\S+$/i.test(text.trim()); }
async function addItem(view, type, content, destinationId = view.ui.Destination.value, images = null, attachment = null) {
  requireConnection();
  if (view.scope === 'vault' && !owner()) throw new Error('Only the owner can use the vault.');
  if (view.scope === 'clips' && freeClipFull()) throw new Error(freeClipMessage);
  if (typeof content !== 'string' || (type === 'image' || type === 'file' ? content.length > 9500000 : content.length > 100000)) throw new Error('Inline clip is too large. Try attaching the file again.');
  if (images && (images.length > 5 || images.some(image => image.length > 1500000))) throw new Error('Older image collections are limited to five small images.');
  const ref = view.scope === 'clips' && !owner() && !girlfriend ? view.ref.child(FREE_CLIP_KEY) : view.ref.push();
  const group = currentGroup(view, destinationId);
  const item = { type, content, color: girlfriend ? pinkColor(ref.key) : group?.color || M.defaultColor(ref.key), order: -now(), revision: 0,
    [view.scope === 'vault' ? 'keptAt' : 'createdAt']: firebase.database.ServerValue.TIMESTAMP };
  if (girlfriend) item.authorEmail = GIRLFRIEND_EMAIL;
  if (type === 'file') {
    item.filename = attachment.filename; item.fileSize = attachment.fileSize;
    if (attachment.chunkCount) { item.chunkCount = attachment.chunkCount; item.ready = false; }
  }
  if (type === 'image' && content === 'album') { item.attachments = attachment.attachments; item.ready = false; }
  if (images?.length > 1) item.images = images;
  if (group) item.group = group;
  if (view.scope === 'clips' && !owner() && !girlfriend) {
    const result = await ref.transaction(current => current === null ? item : undefined, undefined, false);
    if (!result.committed) throw new Error(freeClipMessage);
  } else await ref.set(item);
  view.collapsed.delete(group?.id || ''); savePreferences(view); render(view);
  announce(view.scope === 'vault' ? 'Added to the vault.' : 'Clip added. It will expire in 10 minutes.');
  if (view.query || view.type !== 'all') toast('Clip added. Clear your filters to see all clips.');
  return ref.key;
}
function updateComposer(view) {
  view.ui.Add.disabled = view.adding || !view.ui.Input.value.trim();
  const compact = matchMedia('(min-width: 900px) and (pointer: fine)').matches;
  view.ui.Input.style.height = 'auto';
  view.ui.Input.style.height = Math.min(compact ? 112 : 140, Math.max(compact ? 40 : 48, view.ui.Input.scrollHeight)) + 'px';
}
async function submitText(view) {
  if (view.adding) return;
  const draft = view.ui.Input.value;
  const val = draft.trim();
  if (!val) return;
  if (view.scope === 'clips' && val.toLowerCase() === 'iii') { view.ui.Input.value = ''; updateComposer(view); unlockVault(); return; }
  view.adding = true; updateComposer(view);
  try {
    await addItem(view, looksLikeUrl(val) ? 'link' : 'text', val);
    if (view.ui.Input.value === draft) view.ui.Input.value = '';
  } catch (err) { toast(err.message || 'Could not add this clip. Your draft is still here.'); }
  finally { view.adding = false; updateComposer(view); }
}
function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read ' + file.name));
    reader.onerror = () => reject(new Error('Could not read ' + file.name));
    reader.readAsDataURL(file);
  });
}
function estimatedStorageBytes() {
  // This is workspace data only; other Firebase data and billing quotas are not exposed here.
  return Object.values(scopes).reduce((sum, view) => sum + M.storageBytes(view.items), 0);
}
async function processAttachments(view, files, destinationId = view.ui.Destination.value) {
  try {
    requireConnection();
    if (!files.length) return;
    if (view.adding) throw new Error('Wait for the current upload to finish.');
    if (view.scope === 'clips' && freeClipFull()) throw new Error(freeClipMessage);
    const incoming = files.reduce((sum, file) => sum + Math.ceil(file.size * 4 / 3) + 1000, 0);
    const projected = estimatedStorageBytes() + incoming;
    if (projected > STORAGE_WARNING_BYTES && !window.confirm(`Estimated workspace data would be ~${formatStorage(projected)}, over 1 GB. Firebase quota cannot be checked here. Continue?`)) return;
    view.adding = true; updateComposer(view);
    let added = 0;
    const images = files.filter(file => /^image\//i.test(file.type));
    if (images.length > 1) {
      const attachments = images.map((file, index) => ({
        name: (file.name || `image-${index + 1}`).replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 160),
        size: file.size, parts: Math.max(1, Math.ceil(file.size / CHUNK_BYTES)), mime: file.type.toLowerCase()
      }));
      const key = await addItem(view, 'image', 'album', destinationId, null, {attachments});
      try {
        if (girlfriend) await blobRef(view, key).child('authorEmail').set(GIRLFRIEND_EMAIL);
        for (let index = 0; index < images.length; index++) {
          const file = images[index];
          for (let part = 0; part < attachments[index].parts; part++) {
            const data = await readDataURL(file.slice(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES));
            await blobRef(view, key).child(`a${index}_${part}`).set(data.slice(data.indexOf(',') + 1));
          }
          (view.scope === 'vault' ? $('vaultStatus') : $('status')).textContent = `Uploading images: ${index + 1} / ${images.length}`;
        }
        await view.ref.child(key).update({ready: true, ...(view.scope === 'clips' ? {createdAt: firebase.database.ServerValue.TIMESTAMP} : {})});
      } catch (error) {
        try { await blobRef(view, key).remove(); } catch { /* Cleanup can race with expiry. */ }
        try { await view.ref.child(key).remove(); } catch { /* Abandoned uploads expire. */ }
        throw error;
      }
      added++;
    }
    for (const file of files) {
      const image = /^image\//i.test(file.type);
      if (images.length > 1 && image) continue;
      const filename = (file.name || 'attachment').replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 160);
      if (file.size <= MAX_FILE_BYTES && (!image || /^image\/(png|jpeg|webp|gif)$/i.test(file.type))) {
        const encoded = await readDataURL(file);
        const content = image ? encoded : 'data:application/octet-stream;base64,' + encoded.slice(encoded.indexOf(',') + 1);
        await addItem(view, image ? 'image' : 'file', content, destinationId, null,
          image ? null : { filename, fileSize: file.size });
      } else {
        const chunkCount = Math.ceil(file.size / CHUNK_BYTES);
        const key = await addItem(view, 'file', 'chunked', destinationId, null, { filename, fileSize: file.size, chunkCount });
        try {
          if (girlfriend) await blobRef(view, key).child('authorEmail').set(GIRLFRIEND_EMAIL);
          for (let i = 0; i < chunkCount; i++) {
            const data = await readDataURL(file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
            await blobRef(view, key).child(String(i)).set(data.slice(data.indexOf(',') + 1));
            (view.scope === 'vault' ? $('vaultStatus') : $('status')).textContent = `Uploading ${filename}: ${formatStorage(Math.min(file.size, (i + 1) * CHUNK_BYTES))} / ${formatStorage(file.size)}`;
          }
          await view.ref.child(key).update({ ready: true, ...(view.scope === 'clips' ? { createdAt: firebase.database.ServerValue.TIMESTAMP } : {}) });
        } catch (error) {
          try { await blobRef(view, key).remove(); } catch { /* Cleanup can race with expiry. */ }
          try { await view.ref.child(key).remove(); } catch { /* Incomplete uploads expire automatically. */ }
          throw error;
        }
      }
      added++;
    }
    toast(added === 1 ? images.length > 1 ? `${images.length} images added in one clip.` : 'Attachment added.' : `${added} clips added.`);
  } catch (err) { toast(err.message || 'Could not add attachments. Please try again.'); }
  finally { view.adding = false; (view.scope === 'vault' ? $('vaultStatus') : $('status')).textContent = connected ? 'Synced' : 'Reconnecting…'; updateComposer(view); }
}

let keyBuffer = '', lastKeyAt = 0, keyBufferTarget = null;

function clearTypedVaultCode(target) {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  if (start === null || end === null || start !== end || start < 2) return;
  if (target.value.slice(start - 2, start).toLowerCase() !== 'ii') return;
  target.setRangeText('', start - 2, start, 'end');
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

function openVault(animate = false) {
  if (!currentUid) return;
  activeScope = 'vault';
  $('mainWorkspace').inert = true;
  $('vault').hidden = false;
  $('vault').classList.remove('vault-preparing');
  if (animate) {
    $('vault').classList.remove('vault-entering');
    void $('vault').offsetWidth;
    $('vault').classList.add('vault-entering');
  }
  scopes.vault.ui.Search.focus();
  requestAnimationFrame(() => { for (const rec of scopes.vault.cards.values()) checkExpand(rec); });
}
function unlockVault() {
  if (!currentUid || activeScope === 'vault' || unlockTimer) return;
  if (!owner()) { toast('The vault is available only to the owner.'); return; }
  // Block a second trigger while the two pre-warm frames are pending.
  unlockTimer = -1;
  const popup = $('unlockPopup');
  const workspace = $('mainWorkspace');
  const vault = $('vault');
  popup.classList.remove('show');
  popup.classList.add('breach-ready');
  workspace.classList.add('breach-ready');

  // Build the hidden vault and its compositor layers before the breach begins.
  // This avoids a full layout/paint in the middle of the 1.6s animation.
  vault.hidden = false;
  vault.classList.add('vault-preparing');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!currentUid) return;
    document.body.classList.add('vault-breaching');
    popup.classList.add('show');
    unlockTimer = setTimeout(() => openVault(true), 1120);
    setTimeout(() => {
      clearTimeout(unlockTimer);
      unlockTimer = null;
      popup.classList.remove('show', 'breach-ready');
      workspace.classList.remove('breach-ready');
      vault.classList.remove('vault-entering', 'vault-preparing');
      document.body.classList.remove('vault-breaching');
    }, 1620);
  }));
}
function closeVault() {
  cancelDrag();
  if (dialog.open) closeDialog();
  $('vault').hidden = true; $('mainWorkspace').inert = false; activeScope = 'clips'; keyBuffer = ''; keyBufferTarget = null;
  scopes.clips.ui.Input.focus({ preventScroll: true });
}
$('vaultExit').onclick = closeVault;
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing) return;
  if ($('keepWarning').open) return;
  if (e.key === 'Escape' && drag) { e.preventDefault(); cancelDrag(); return; }
  if (dialog.open) return;
  if (e.key === 'Escape' && activeScope === 'vault') { e.preventDefault(); closeVault(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (Date.now() - lastKeyAt > 1800 || keyBufferTarget !== e.target) keyBuffer = '';
  lastKeyAt = Date.now();
  keyBufferTarget = e.target;
  keyBuffer = e.key.length === 1 ? (keyBuffer + e.key.toLowerCase()).slice(-3) : '';
  if (keyBuffer === 'iii') {
    e.preventDefault();
    clearTypedVaultCode(e.target);
    keyBuffer = '';
    keyBufferTarget = null;
    unlockVault();
  }
});
document.addEventListener('paste', e => {
  if (dialog.open) return;
  const view = scopes[activeScope];
  const editor = e.target.closest('input, textarea, [contenteditable=true]');
  if (editor && editor !== view.ui.Input) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  const attachments = Array.from(items).filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean);
  if (attachments.length) {
    e.preventDefault();
    const destinationId = view.ui.Destination.value;
    processAttachments(view, attachments, destinationId);
    return;
  }
  if (!editor) {
    const text = e.clipboardData.getData('text/plain').trim();
    if (!text) return;
    e.preventDefault();
    if (activeScope === 'clips' && text.toLowerCase() === 'iii') { unlockVault(); return; }
    addItem(view, looksLikeUrl(text) ? 'link' : 'text', text).catch(err => toast(err.message));
  }
});

let imageDragDepth = 0;
function draggingFiles(e) { return Array.from(e.dataTransfer?.types || []).includes('Files'); }
function clearImageDropState() {
  imageDragDepth = 0;
  document.body.classList.remove('image-drop-ready');
}
document.addEventListener('dragenter', e => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  imageDragDepth++;
  document.body.classList.add('image-drop-ready');
});
document.addEventListener('dragover', e => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', e => {
  if (!draggingFiles(e)) return;
  imageDragDepth = Math.max(0, imageDragDepth - 1);
  if (!imageDragDepth) document.body.classList.remove('image-drop-ready');
});
document.addEventListener('drop', e => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  clearImageDropState();
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  const view = scopes[activeScope];
  const destinationId = view.ui.Destination.value;
  processAttachments(view, files, destinationId);
});
window.addEventListener('blur', clearImageDropState);

function bindView(view) {
  view.ui.NewGroup.onclick = () => openGroupDialog(view);
  view.ui.Search.oninput = () => { view.query = view.ui.Search.value.trim(); view.selected.clear(); render(view); };
  view.ui.Type.onchange = () => { view.type = view.ui.Type.value; view.selected.clear(); render(view); };
  view.ui.Sort.onchange = () => { view.sort = view.ui.Sort.value; savePreferences(view); render(view); };
  view.ui.Layout.onclick = () => {
    view.layout = view.scope === 'vault' ? (view.layout === 'sheet' ? 'comfortable' : 'sheet') : view.layout === 'grid' ? 'list' : 'grid'; savePreferences(view); render(view);
    requestAnimationFrame(() => { for (const rec of view.cards.values()) checkExpand(rec); });
  };
  const selectionMode = value => { view.selecting = value; if (!value) view.selected.clear(); updateSelection(view); };
  view.ui.Select.onclick = () => selectionMode(!view.selecting);
  view.ui.Done.onclick = () => selectionMode(false);
  view.ui.SelectAll.onclick = () => {
    view.selected = view.selected.size === view.visible.length ? new Set() : new Set(view.visible); updateSelection(view);
  };
  view.ui.BulkMove.onclick = () => openItemDialog(view, getSelected(view));
  view.ui.BulkShare.onclick = () => shareSelectedImages(view);
  view.ui.BulkDelete.onclick = () => confirmDelete(view, getSelected(view));
  if (view.scope === 'clips') bindKeepHold($('clipsBulkKeep'), () => keepItems(view, getSelected(view)), () => updateSelection(view));
  view.ui.Input.oninput = () => {
    if (view.scope === 'clips' && view.ui.Input.value.trim().toLowerCase() === 'iii') { view.ui.Input.value = ''; unlockVault(); }
    updateComposer(view);
  };
  view.ui.Input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (e.ctrlKey || e.metaKey || matchMedia('(pointer: fine)').matches)) {
      e.preventDefault(); submitText(view);
    }
  });
  view.ui.Add.onclick = () => submitText(view);
  view.ui.Image.onclick = () => view.ui.File.click();
  view.ui.File.onchange = async () => {
    const files = Array.from(view.ui.File.files || []);
    const destinationId = view.ui.Destination.value;
    view.ui.File.value = '';
    if (!files.length) return;
    await processAttachments(view, files, destinationId);
  };
  render(view);
}
for (const view of Object.values(scopes)) bindView(view);
initFirebase();
setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); else cancelDrag(); });
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    updateComposer(scopes[activeScope]);
    for (const rec of scopes[activeScope].cards.values()) checkExpand(rec);
  }, 150);
});
