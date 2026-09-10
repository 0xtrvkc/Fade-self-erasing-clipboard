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
let db, connected = false, clockOffset = 0, activeScope = 'clips', toastTimeout, unlockTimer;
let drag = null;
const now = () => Date.now() + clockOffset;
const $ = id => document.getElementById(id);
const scopes = {};
const dialog = $('actionDialog');
const pendingExpiry = new Set();
const expiryQueue = new Set();

function readPreferences(scope) {
  try { return JSON.parse(localStorage.getItem('fade.organizer.v1.' + scope)) || {}; }
  catch { return {}; }
}
function savePreferences(view) {
  try {
    localStorage.setItem('fade.organizer.v1.' + view.scope, JSON.stringify({
      groups: view.groups, collapsed: [...view.collapsed], layout: view.layout, sort: view.sort
    }));
  } catch { /* Device preferences are optional; clipboard content is never stored here. */ }
}
function makeView(scope) {
  const prefs = readPreferences(scope);
  const ids = ['Board', 'Scroll', 'Search', 'Type', 'Sort', 'Layout', 'Select', 'Bulk', 'SelectionCount',
    'SelectAll', 'BulkMove', 'BulkDelete', 'Done', 'NewGroup', 'Count', 'Empty', 'Input', 'Image', 'File', 'Destination', 'Add'];
  return { scope, ref: null, items: {}, cards: new Map(), sections: new Map(), groups: M.groups({}, Array.isArray(prefs.groups) ? prefs.groups : []),
    collapsed: new Set(Array.isArray(prefs.collapsed) ? prefs.collapsed.filter(x => typeof x === 'string') : []),
    layout: prefs.layout === 'list' ? 'list' : 'grid', sort: ['manual', 'newest', 'oldest'].includes(prefs.sort) ? prefs.sort : 'manual',
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
function clipLabel(item) { return (item.title || (item.type === 'image' ? 'Image' : item.content)).slice(0, 90); }
function getSelected(view) { return [...view.selected].filter(key => !!view.items[key]); }
function manualMode(view) { return view.sort === 'manual' && !view.query && view.type === 'all'; }

async function patchItem(view, key, patch) {
  requireConnection();
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
function purgeExpired(key) {
  expiryQueue.add(key);
  if (!connected || pendingExpiry.has(key)) return;
  pendingExpiry.add(key);
  scopes.clips.ref.child(key).transaction(current => M.isClip(current) && M.expired(current, 'clips', now()) ? null : undefined, undefined, false)
    .then(result => { if (result.committed) expiryQueue.delete(key); })
    .catch(() => { $('status').textContent = 'Expiry sync failed'; });
}
function listen(view) {
  view.ref.on('value', snap => {
    const data = snap.val() || {};
    view.items = Object.create(null);
    for (const [key, item] of Object.entries(data)) {
      if (!M.isClip(item)) continue;
      if (M.expired(item, view.scope, now())) { purgeExpired(key); continue; }
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
    scopes.clips.ref = db.ref('clips');
    scopes.vault.ref = db.ref('kept');
    db.ref('.info/serverTimeOffset').on('value', snap => { clockOffset = Number(snap.val()) || 0; tick(); });
    db.ref('.info/connected').on('value', snap => {
      connected = snap.val() === true;
      $('status').textContent = connected ? 'Synced' : 'Reconnecting…';
      $('status').classList.toggle('online', connected);
      if ($('vaultStatus')) {
        $('vaultStatus').textContent = connected ? 'Synced' : 'Reconnecting…';
        $('vaultStatus').classList.toggle('online', connected);
      }
      if (connected) { pendingExpiry.clear(); for (const key of expiryQueue) purgeExpired(key); tick(); }
    });
    listen(scopes.clips);
    listen(scopes.vault);
  } catch (err) {
    console.error(err);
    $('status').textContent = 'Connection unavailable';
    for (const view of Object.values(scopes)) view.ui.Count.textContent = 'Connection unavailable';
    toast('Could not connect. Check your connection, then reload.');
  }
}

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
  menu.hidden = !id;
  const items = element('div', 'group-items');
  items.id = view.scope + '-group-' + (id || 'unfiled');
  toggle.setAttribute('aria-controls', items.id);
  const empty = element('p', 'drop-empty', 'Drop clips here, or choose this group when adding a clip.');
  items.append(empty);
  heading.append(toggle, count, menu);
  section.append(heading, items);
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
  view.ui.Sort.value = view.sort;
  const groups = [null, ...view.groups];
  let sectionIndex = 2;
  for (const g of groups) {
    const id = g?.id || '';
    const rec = view.sections.get(id) || createSection(view, g);
    const keys = view.visible.filter(k => M.groupId(view.items[k]) === id);
    const groupTotal = Object.values(view.items).filter(i => M.groupId(i) === id).length;
    rec.name.textContent = g?.name || 'Unfiled';
    rec.section.style.setProperty('--group-color', g?.color || '#87929b');
    rec.count.textContent = filtered ? `${keys.length}/${groupTotal}` : groupTotal;
    rec.menu.setAttribute('aria-label', 'Manage group: ' + (g?.name || 'Unfiled'));
    rec.section.hidden = filtered ? keys.length === 0 : !id && total === 0 && view.groups.length === 0;
    const collapsed = view.collapsed.has(id) && !filtered;
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
  if (view.scope === 'clips') $('clipsBulkKeep').disabled = view.selected.size === 0;
  view.ui.SelectAll.textContent = view.visible.length && view.selected.size === view.visible.length ? 'Deselect all' : 'Select all';
  for (const [key, card] of view.cards) {
    card.selector.hidden = !view.selecting;
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
    updateSelection(view);
  };
  rec.selector.append(rec.checkbox);
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
  actions.append(button('Copy', e => copyItem(rec.item, e.currentTarget)));
  if (view.scope === 'clips') actions.append(button('Keep', async e => {
    const btn = e.currentTarget; btn.disabled = true;
    try { await keepItems(view, [key]); } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  }));
  const more = button('•••', () => openItemDialog(view, [key]), 'more-button');
  more.setAttribute('aria-label', 'Organize clip: ' + clipLabel(item));
  actions.append(more);
  el.append(top, rec.header.el, rec.content, rec.expand, actions);
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
  const contentChanged = !rec.item || item.type !== rec.item.type || item.content !== rec.item.content;
  rec.item = item;
  rec.tag.textContent = item.type;
  rec.el.style.setProperty('--card-color', M.color(item.color) || M.defaultColor(rec.key));
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
    renderContent(rec.content, item);
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
function renderContent(el, item) {
  if (item.type === 'image' && /^data:image\/(jpeg|png|webp|gif);base64,/i.test(item.content)) {
    const img = document.createElement('img');
    img.src = item.content; img.alt = item.title || 'Clipboard image'; img.loading = 'lazy';
    el.append(img);
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
function swatches(initial) {
  let selected = initial;
  const el = element('div', 'swatches');
  el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Color');
  for (const [name, hex] of M.COLORS) {
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
  const colors = swatches(single ? M.color(item.color) || M.defaultColor(keys[0]) : '');
  body.append(element('p', '', single ? 'Color label' : 'Color label · leave unchanged or choose a color'), colors.el);
  const pin = document.createElement('select');
  if (!single) pin.add(new Option('Keep pin status', '*'));
  pin.add(new Option('Normal position', 'no')); pin.add(new Option('Pin to top of group', 'yes'));
  pin.value = single ? (item.pinned ? 'yes' : 'no') : '*';
  body.append(field('Position', pin));
  if (view.scope === 'clips') body.append(element('p', 'dialog-help', 'Pinned clips still expire after 10 minutes. Use Keep to save a clip in the vault.'));
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
  a.download = 'fade-image.' + (/^data:image\/png/i.test(item.content) ? 'png' : 'jpg');
  document.body.append(a); a.click(); a.remove();
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
async function addItem(view, type, content, destinationId = view.ui.Destination.value) {
  requireConnection();
  const ref = view.ref.push();
  const group = currentGroup(view, destinationId);
  const item = { type, content, color: group?.color || M.defaultColor(ref.key), order: -now(), revision: 0,
    [view.scope === 'vault' ? 'keptAt' : 'createdAt']: firebase.database.ServerValue.TIMESTAMP };
  if (group) item.group = group;
  await ref.set(item);
  view.collapsed.delete(group?.id || ''); savePreferences(view); render(view);
  announce(view.scope === 'vault' ? 'Added to the vault.' : 'Clip added. It will expire in 10 minutes.');
  if (view.query || view.type !== 'all') toast('Clip added. Clear your filters to see all clips.');
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
async function processImage(view, file, destinationId = view.ui.Destination.value) {
  let source;
  try {
    requireConnection();
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
    if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image smaller than 20 MB.');
    source = URL.createObjectURL(file);
    const img = await loadImage(source);
    const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(img, 0, 0, canvas.width, canvas.height);
    await addItem(view, 'image', canvas.toDataURL('image/jpeg', .8), destinationId);
    toast('Image added.');
  } catch (err) { toast(err.message || 'Could not add the image. Please try again.'); }
  finally { if (source) URL.revokeObjectURL(source); }
}

let keyBuffer = '', lastKeyAt = 0;
function openVault(animate = false) {
  activeScope = 'vault';
  $('mainWorkspace').inert = true;
  $('vault').hidden = false;
  if (animate) {
    $('vault').classList.remove('vault-entering');
    void $('vault').offsetWidth;
    $('vault').classList.add('vault-entering');
  }
  scopes.vault.ui.Search.focus();
  requestAnimationFrame(() => { for (const rec of scopes.vault.cards.values()) checkExpand(rec); });
}
function unlockVault() {
  if (activeScope === 'vault' || unlockTimer) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { openVault(); return; }
  $('unlockPopup').classList.remove('show');
  void $('unlockPopup').offsetWidth;
  document.body.classList.add('vault-breaching');
  $('unlockPopup').classList.add('show');
  unlockTimer = setTimeout(() => openVault(true), 1120);
  setTimeout(() => {
    clearTimeout(unlockTimer);
    unlockTimer = null;
    $('unlockPopup').classList.remove('show');
    $('vault').classList.remove('vault-entering');
    document.body.classList.remove('vault-breaching');
  }, 1620);
}
function closeVault() {
  cancelDrag();
  if (dialog.open) closeDialog();
  $('vault').hidden = true; $('mainWorkspace').inert = false; activeScope = 'clips'; keyBuffer = '';
  scopes.clips.ui.Input.focus({ preventScroll: true });
}
$('vaultExit').onclick = closeVault;
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing) return;
  if (e.key === 'Escape' && drag) { e.preventDefault(); cancelDrag(); return; }
  if (dialog.open) return;
  if (e.key === 'Escape' && activeScope === 'vault') { e.preventDefault(); closeVault(); return; }
  if (e.target.closest('input, textarea, select, [contenteditable=true]') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (Date.now() - lastKeyAt > 1800) keyBuffer = '';
  lastKeyAt = Date.now();
  keyBuffer = e.key.length === 1 ? (keyBuffer + e.key.toLowerCase()).slice(-3) : '';
  if (keyBuffer === 'iii') { keyBuffer = ''; unlockVault(); }
});
document.addEventListener('paste', e => {
  if (dialog.open) return;
  const view = scopes[activeScope];
  const editor = e.target.closest('input, textarea, [contenteditable=true]');
  if (editor && editor !== view.ui.Input) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith('image/')) {
      const file = it.getAsFile(); if (file) { e.preventDefault(); processImage(view, file); } return;
    }
  }
  if (!editor) {
    const text = e.clipboardData.getData('text/plain').trim();
    if (!text) return;
    e.preventDefault();
    if (activeScope === 'clips' && text.toLowerCase() === 'iii') { unlockVault(); return; }
    addItem(view, looksLikeUrl(text) ? 'link' : 'text', text).catch(err => toast(err.message));
  }
});

function bindView(view) {
  view.ui.NewGroup.onclick = () => openGroupDialog(view);
  view.ui.Search.oninput = () => { view.query = view.ui.Search.value.trim(); view.selected.clear(); render(view); };
  view.ui.Type.onchange = () => { view.type = view.ui.Type.value; view.selected.clear(); render(view); };
  view.ui.Sort.onchange = () => { view.sort = view.ui.Sort.value; savePreferences(view); render(view); };
  view.ui.Layout.onclick = () => {
    view.layout = view.layout === 'grid' ? 'list' : 'grid'; savePreferences(view); render(view);
    requestAnimationFrame(() => { for (const rec of view.cards.values()) checkExpand(rec); });
  };
  const selectionMode = value => { view.selecting = value; if (!value) view.selected.clear(); updateSelection(view); };
  view.ui.Select.onclick = () => selectionMode(!view.selecting);
  view.ui.Done.onclick = () => selectionMode(false);
  view.ui.SelectAll.onclick = () => {
    view.selected = view.selected.size === view.visible.length ? new Set() : new Set(view.visible); updateSelection(view);
  };
  view.ui.BulkMove.onclick = () => openItemDialog(view, getSelected(view));
  view.ui.BulkDelete.onclick = () => confirmDelete(view, getSelected(view));
  if (view.scope === 'clips') $('clipsBulkKeep').onclick = async () => {
    const btn = $('clipsBulkKeep'); btn.disabled = true;
    try { await keepItems(view, getSelected(view)); } catch (err) { toast(err.message || 'Some clips could not be kept. Please try again.'); }
    finally { updateSelection(view); }
  };
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
  view.ui.File.onchange = () => {
    const file = view.ui.File.files[0]; if (file) processImage(view, file); view.ui.File.value = '';
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
