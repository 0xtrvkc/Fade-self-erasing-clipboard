# Fade

A clipboard that connects your phone and desktop. Temporary clips disappear after 10 minutes. Keep something in the hidden vault when you want it to last.

[Open Fade](https://0xtrvkc.github.io/Fade-self-erasing-clipboard/)

## Organize either workspace

The normal clipboard and the `iii` vault have the same organization controls:

- **Groups:** create named groups, rename them, set a group color, collapse sections, and move groups up or down. Removing a group moves its clips to Unfiled.
- **Drag to move:** drag a clip by its dotted handle to reorder it or move it between groups. Touch dragging includes edge scrolling. Scroll normally by touching anywhere outside the handle.
- **Move without dragging:** tap the handle or open **•••** to choose a group or use **Move earlier / Move later**. These controls also work with a keyboard.
- **Color labels:** choose from eight named colors per clip. A group can also recolor all of its clips.
- **Headers:** add or edit a title / summary on any clip, including temporary ones. An open draft survives incoming sync updates; remote header changes are flagged before you overwrite them.
- **Pin:** keep a clip at the top of its group. Pinning a temporary clip does not extend its timer.
- **Search and filters:** search text, titles, and group names; filter text, links, or images. Image contents are not OCR-searched.
- **Layouts and sorting:** switch between grid and list, or choose your own order, newest first, or oldest first. Dragging requires **Your order** and cleared filters; the Move menu remains available with filters active.
- **Bulk actions:** choose **Select**, pick clips or **Select all** matching clips, then move, recolor, pin, keep, or delete them. Keep is available in the normal clipboard.
- **Delete and undo:** deletion asks for confirmation and syncs to every device. Undo is available for 10 seconds and preserves the original expiry time. An expired clip cannot be restored.

Group names, colors, membership, pin status, titles, and clip order travel with the clip in Firebase. Empty groups, collapsed sections, layout, and sort preferences are local to each browser. Each workspace has its own preferences. No clipboard content is written to localStorage.

## Everyday use

1. Open Fade on both devices.
2. Type or paste into the composer, select a destination group, and tap **Add clip**. The image button accepts an image from your device. Clipboard images can also be pasted.
3. Tap **Copy** on the other device. Images are converted to PNG for clipboard compatibility; if the browser blocks copying, **Save image** is offered.
4. Tap **Keep** before the countdown reaches zero to move a clip to the vault, retaining its title, color, and group.
5. Type `iii` while outside an editor, or type `iii` into the normal composer, to open the vault. On mobile, use the composer. Add notes and images directly to the vault if desired.
6. Tap **Exit** or press **Escape** to return to the temporary clipboard.

On desktop, **Enter** adds a clip and **Shift+Enter** inserts a line break. On touch devices, Enter inserts a line break; use the Add button. **Ctrl/Cmd+Enter** also adds a clip. These shortcuts respect text composition.

The responsive layout uses larger touch targets, a bottom-sheet organizer on smaller screens, and a composer outside the scrolling board. Browser zoom is enabled. Reduced-motion preferences skip the vault transition. Content fades gradually; buttons and timers stay legible.

## Sync and expiry

Fade uses the existing Firebase Realtime Database paths, `clips` and `kept`. Organization is optional metadata on each item, so existing records continue to work without a migration or new database paths.

- Changes use transactions that merge metadata with the latest record. An expired or deleted clip cannot be recreated by a late edit or move.
- Keep writes the vault copy first and only removes an unchanged source clip. If another device edits the source during that operation, the source stays in place.
- New text drafts are cleared only after the save succeeds. Connection and write failures are shown in the interface.
- Countdown calculations use Firebase's server-time offset. Expiry is performed by an open, connected client; there is no scheduled server-side cleanup. Expired records may remain in the database while every client is closed or offline and are cleaned up when a client reconnects.
- Simultaneous reorders are not collaborative locking: the latest successful writes determine order. Content edits are merged independently.

## Run or deploy

No build step or package installation is required. Serve the repository root with any static host, including GitHub Pages. Keep `index.html`, `styles.css`, `organizer.js`, `app.js`, `manifest.json`, and `icons/` together.

For a local server:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Clipboard access requires HTTPS or localhost and browser permission.

For a new Firebase project:

1. Create a Firebase web app and enable Realtime Database.
2. Replace `firebaseConfig` at the top of `app.js` with your project's configuration.
3. Configure database access for both `clips` and `kept`. Existing deployments that already permit reading and writing those paths need no additional paths for grouping.
4. Enable GitHub Pages from the `main` branch / repository root, or upload the files to your static host.

## Access model

The `iii` shortcut hides a screen; it is not authentication or encryption. Access to the data is controlled by Firebase Database Rules. The app does not implement sign-in or private per-user storage. A database configured for public reads and writes is accessible to anyone who knows its endpoint, including its kept items.

Firebase client configuration identifies the project and does not grant access independently of Database Rules. Use this shared clipboard only for content appropriate to your configured access rules.

## Development checks

Organization rules are in `organizer.js`; browser interaction and Firebase integration are in `app.js`; styling is in `styles.css`.

Run the dependency-free logic checks with Node.js:

```sh
node --test tests/organizer.test.cjs
node --check app.js
node --check organizer.js
```

The tests cover legacy records, expiry boundaries, late edits, pinning, group reconciliation, search, drag/reorder plans, and safe links. They do not replace browser/device testing or exercise a live Firebase database.

## License

MIT.
