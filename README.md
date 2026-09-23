# Fade

A private cross-device clipboard using Google sign-in. Temporary clips disappear from the app after ten minutes, and a scheduled cleanup removes expired records from Firebase. The `iii` vault keeps clips until you delete them.

[Open Fade](https://0xtrvkc.github.io/Fade-self-erasing-clipboard/)

## Organize either workspace

The normal clipboard and the `iii` vault have the same organization controls:

- **Groups:** create named groups, rename them, set a group color, collapse sections, and move groups up or down. Removing a group moves its clips to Unfiled.
- **Drag to move:** drag a clip by its dotted handle to reorder it or move it between groups. Touch dragging includes edge scrolling. Scroll normally by touching anywhere outside the handle.
- **Move without dragging:** tap the handle or open **â€¢â€¢â€¢** to choose a group or use **Move earlier / Move later**. These controls also work with a keyboard.
- **Color labels:** choose from eight named colors per clip. A group can also recolor all of its clips.
- **Headers:** add or edit a title / summary on any clip, including temporary ones. An open draft survives incoming sync updates; remote header changes are flagged before you overwrite them.
- **Pin:** keep a clip at the top of its group. Pinning a temporary clip does not extend its timer.
- **Search and filters:** search text, titles, and group names; filter text, links, or images. Image contents are not OCR-searched.
- **Layouts and sorting:** switch between grid and list, or choose your own order, newest first, or oldest first. Dragging requires **Your order** and cleared filters; the Move menu remains available with filters active.
- **Bulk actions:** choose **Select**, pick clips or **Select all** matching clips, then move, recolor, pin, keep, or delete them. Keep is available in the normal clipboard.
- **Delete and undo:** deletion asks for confirmation and syncs to every device. Undo is available for 10 seconds and preserves the original expiry time. An expired clip cannot be restored.

Group names, colors, membership, pin status, titles, and clip order travel with the clip in your per-user Firebase workspace. Empty groups, collapsed sections, layout, and sort preferences are local to each browser. Each workspace has its own preferences. No clipboard content is written to localStorage.

## Everyday use

1. Open Fade on both devices and sign in with the same Google account. Enable popups for this page if the browser blocks sign-in.
2. Type or paste into the composer, select a destination group, and tap **Add clip**. The image button accepts an image from your device. Clipboard images can also be pasted.
3. Tap **Copy** on the other device. Images are converted to PNG for clipboard compatibility; if the browser blocks copying, **Save image** is offered.

The image picker supports selecting several photos at once. To send several saved images from a phone, tap **Select**, choose the image cards, then tap **Share images** to open the native iOS or Android share sheet. Mobile clipboards do not reliably support pasting multiple separate images, so Fade uses native file sharing instead.
4. Tap **Keep** before the countdown reaches zero to move a clip to the vault, retaining its title, color, and group.
5. Type `iii` while outside an editor, or type `iii` into the normal composer, to open the vault. On mobile, use the composer. Add notes and images directly to the vault if desired.
6. Tap **Exit** or press **Escape** to return to the temporary clipboard.

On desktop, **Enter** adds a clip and **Shift+Enter** inserts a line break. On touch devices, Enter inserts a line break; use the Add button. **Ctrl/Cmd+Enter** also adds a clip. These shortcuts respect text composition.

The responsive layout uses larger touch targets, a bottom-sheet organizer on smaller screens, and a composer outside the scrolling board. Browser zoom is enabled. Reduced-motion preferences skip the vault transition. Content fades gradually; buttons and timers stay legible.

Entering `iii` triggers a full-screen vault-breach sequence with chromatic text tearing, data streaks, scanlines, a perspective grid, screen distortion, shutters, and a hard vault reveal. The animation lasts about 1.6 seconds and is skipped automatically when the device requests reduced motion.

On desktops with a mouse or trackpad, the workspace uses a compact layout by default: the grid fills the available width, card actions share the top row, text previews show three lines, and the composer fits on one row. List view uses short horizontal rows with two-line previews. **Show more** expands text or image thumbnails without changing the saved content. Phones and touch tablets retain the larger controls.

Clip content uses a compact 14px type size. Link cards show only the useful domain and path on one line; long paths are visually shortened and query strings are hidden. Opening or copying a link still uses the complete original URL.

## Sync and expiry

Fade stores clips at `users/<uid>/clips` and kept items at `users/<uid>/kept`. Each signed-in user has a separate workspace. Old root-level `clips` and `kept` records are intentionally not read by the new app.

- Changes use transactions that merge metadata with the latest record. An expired or deleted clip cannot be recreated by a late edit or move.
- Keep writes the vault copy first and only removes an unchanged source clip. If another device edits the source during that operation, the source stays in place.
- New text drafts are cleared only after the save succeeds. Connection and write failures are shown in the interface.
- Countdown calculations use Firebase's server-time offset. Open clients remove expired clips promptly; the scheduled `purgeExpiredClips` function removes them from Firebase when no browser is open. The job runs each minute, so deletion is not exact to the second. The kept vault has no expiry.
- Simultaneous reorders are not collaborative locking: the latest successful writes determine order. Content edits are merged independently.

## Run or deploy

The website needs no build step. Serve the repository root with any static host, including GitHub Pages. The scheduled cleanup requires a separate Firebase Functions deployment and a Blaze plan.

For a local server:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Clipboard access requires HTTPS or localhost and browser permission.

## Secure deployment

The website alone does **not** deploy Firebase Database Rules or the scheduled cleanup function. Do these steps in order:

1. In Firebase Console for project `fade-self-erasing-clipboard`, enable **Authentication → Sign-in method → Google**. Add `0xtrvkc.github.io` and any local test domain to **Authentication → Settings → Authorized domains**. Use the same Firebase project defined in `app.js`.
2. Back up the Realtime Database in Firebase Console, especially the old root-level `/clips` and `/kept` paths. Review its existing rules. If they allow public access, treat any data that was there as potentially exposed; changing this code does not reverse prior access.
3. Install Firebase CLI, authenticate with the account that owns the project, and select the project explicitly. From this repository root run:

   ```sh
   npm install -g firebase-tools
   firebase login
   npm --prefix functions install
   firebase deploy --project fade-self-erasing-clipboard --only database,functions
   ```

   Functions use the billed Blaze plan and Cloud Scheduler. Deploying the included database rules blocks the legacy root paths immediately. The app will not work until these rules and Google Authentication are enabled.
4. Push the website files to GitHub Pages, sign in, and check that a new clip appears only under `users/<your uid>/clips`. Test another Google account: it must not see or edit that clip. Check the scheduled function logs and confirm an expired clip is removed while all browser tabs are closed.
5. If you want to keep legacy data, copy only *your own* records from `/clips` and `/kept` into the correct `users/<your uid>/clips` and `users/<your uid>/kept` paths using the Firebase Console or an audited Admin SDK migration. Do this after creating your user account by signing in. Then remove the old root data. Do not automatically assign shared legacy data to one account.

The client limits text to 100,000 characters and images to five files of 1 MB each. Database Rules also check type and encoded image sizes. There is no end-to-end encryption: Firebase project administrators can access stored clips. The `iii` shortcut is a screen shortcut, not a second password. The Firebase web API key in `app.js` identifies the project; it is not a private credential. Never place service-account keys in this repository.

## Access model

Firebase Authentication and Realtime Database Rules restrict reads and writes to `users/<auth.uid>`. The scheduled job uses Firebase Admin privileges and only reads registered accounts to remove temporary clips after expiry. A browser-side logout clears rendered clips from the page. Sign out on shared devices.

## Development checks

Organization rules are in `organizer.js`; browser interaction and Firebase integration are in `app.js`; styling is in `styles.css`.

Run the dependency-free logic checks with Node.js:

```sh
node --test tests/*.test.cjs
node --check app.js
node --check organizer.js
```

The tests cover legacy records, expiry boundaries, late edits, pinning, group reconciliation, search, drag/reorder plans, and safe links. They do not replace testing the deployed Firebase rules with two accounts or checking the scheduled function in your project.

## License

MIT.
