# Fade

A cross-device clipboard with Google sign-in. Temporary clips fade after ten minutes. The owner also has a private, end-to-end encrypted Keep vault for clips that should stay.

The `iii` vault entry runs for ten seconds as a full-screen Linux-style TTY. Local-only commands type character by character beside a blinking cursor: slow at first, accelerating through second five, then fast through second eight. A vault mount appears for the final two seconds before the terminal slides away. The text is theatrical; it runs no commands and makes no external connection.

[Open Fade](https://0xtrvkc.github.io/Fade-self-erasing-clipboard/)

## How it works

- Add text, links, images, PDFs, SVGs, ZIPs, or other files on one device. Download attachments on another device.
- Search, sort, pin, label, and organize clips into groups. Layout and collapsed-group preferences are stored in each browser; clipboard content is stored in Firebase.
- Temporary clips disappear from the app after ten minutes. While an app session is open, it also tries to remove expired records from Firebase.
- The owner can move clips into the private vault with **Keep**. Type `iii` to open it, then enter the vault passphrase. The shortcut only hides the screen; the passphrase is what protects the vault.
- Images can be copied or shared with the device's native share controls. Other file types download with their original names. Clipboard permissions and browser support vary.
- Select, paste, or drag multiple attachments at once with no app-level selection-count or per-file size cap. Images in one selection become one gallery clip; other file types become separate clips. Large files and image galleries are uploaded in 512 KB chunks and fetched on demand. A single supported JPEG, PNG, WebP, or GIF under 7 MB retains its inline preview.

## Access

| Account | Temporary clipboard | Keep vault | Appearance |
| --- | --- | --- | --- |
| Owner | Unlimited clips | Private, unlimited | Standard palette |
| Invited account | Shares the owner's temporary clips; can add unlimited clips | No access | Pink interface and color palette |
| Other Google accounts | One private temporary clip at a time | No access | Standard palette |

Clips created by the invited account appear pink to the owner. The owner's existing clips retain their stored colors. The invited account can copy the owner's clips and edit the clips it creates. Other accounts cannot access the shared board or the owner's vault. Deleting their one temporary clip frees the slot for another.

The invited account is identified by its verified Google identity in `app.js` and `database.rules.json`. The README intentionally does not list account identifiers. Existing clips from an invited account's earlier private workspace are not moved automatically.

## Use Fade

1. Open the app and sign in with Google. Sign in with the same account on each of your own devices.
2. Type or paste a clip, then select **Add clip**. Use the attachment button to select images or other files.
3. Tap **Copy** on another device before the temporary clip expires.
4. If you are the owner, type `iii` in the clipboard composer to open the vault. The first time, choose a vault passphrase and save the recovery key. After that, use **Keep** to save a clip to the vault; Keep works while the vault is locked.

On desktop, **Enter** adds a clip and **Shift+Enter** makes a new line. On touch devices, use **Add clip**; **Ctrl/Cmd+Enter** also works. The app supports reduced-motion preferences.

### On a phone

- **Paste** (clipboard icon next to the attachment button) adds whatever is on the clipboard as a new clip in one tap. iOS shows its own Paste confirmation.
- **Tap a card** to copy it. While selecting, a tap selects the card. Titles, Keep and moving clips are in each card's **•••** sheet.
- **Share to Fade (Android):** install Fade to the home screen, then choose Fade in any app's share sheet. Shared text, links and files become clips.
- **iOS Shortcuts:** open `https://<your-site>/?text=<text>` to place text in the composer for review, then tap **Add clip**. `?compose=1` just focuses the composer (also the home-screen "New clip" shortcut on Android).
- The `iii` vault scene plays in full once per tab session and can be skipped by tapping after a moment. Later entries, and devices with Reduce Motion on, get a one-second version.

## Data and expiry

Firebase Realtime Database stores each account's clip metadata and smaller attachments under `users/<uid>/clips` and the owner's kept items under `users/<owner uid>/kept`. The invited account uses the owner's temporary clipboard path. Database rules control who can read and write each path; hiding a button in the app is not an access control. Files are base64 encoded, so they use roughly one-third more database space than their original size. Large-file and gallery chunks are stored separately under `users/<uid>/fileData/<clipId>`; the board only syncs metadata. Very large files can still fail because of available database space, browser memory, upload time, or network limits. The app estimates visible workspace use and warns when an upload would put it above 1 GB; it cannot see your project-wide Firebase usage or enforce the plan quota. See Firebase Console → Realtime Database → Usage for actual usage. Large-file bytes download only when someone selects Download. Smaller inline images still sync with the board.

Expiry is enforced in the open app. A large file starts its ten-minute life after its upload finishes; abandoned uploads are cleaned after 24 hours when the app is opened. A scheduled Cloud Function is included for server-side cleanup while no browser is open, but deploying it requires a Blaze plan. On Spark, expired records and orphaned chunks can remain in Firebase if every browser closes before cleanup. Reopen Fade to clear expired records; check Firebase usage after large uploads. The scheduled cleanup function handles expiry and related chunks when deployed on Blaze. The vault has no expiry; moving a file there makes it permanent until deleted. Keep a separate backup of anything you cannot afford to lose.

Temporary clips are not end-to-end encrypted: Firebase project administrators, and the invited account for the owner's board, can read them until they are removed. Do not use the temporary board for passwords or keys. The Firebase web configuration in `app.js` identifies the project; it is not a private service-account key.

## Vault encryption

Vault items are encrypted in the browser before they are written to Firebase, using the Web Crypto API (`crypto.js`). Firebase, Google, and anyone who signs in as the owner see only ciphertext.

- **Keys.** The vault has one ECDH P-256 key pair. The private key is stored only encrypted: once under a key derived from your passphrase (PBKDF2-SHA256, 600,000 iterations, random salt) and once under a random 256-bit recovery key. The public key is stored in plain form so **Keep** can encrypt clips while the vault is locked.
- **Items.** Each item gets its own AES-256-GCM key derived from a fresh ephemeral key (ECIES with HKDF-SHA256). Text, links, titles, groups, filenames, images, and every file chunk are encrypted. Each ciphertext is bound to its item and part, so swapped or edited data fails to decrypt instead of showing altered content.
- **Visible metadata.** Item count, saved time, order, pin, color label, and approximate sizes remain visible to Firebase.
- **Locking.** The unlocked key exists only in the open tab's memory and cannot be exported. The vault locks every time you leave it or sign out.
- **Recovery.** Setup shows a 52-character recovery key once. Use **Use recovery key** on the unlock screen to set a new passphrase. If both the passphrase and the recovery key are lost, the vault cannot be decrypted by anyone.
- **Passphrase change.** Select the storage estimate at the top of the vault, then **Change vault passphrase**.
- **Upgrade.** Vault items saved before encryption are encrypted automatically the first time the owner unlocks the vault, and their plain file parts are removed. Unfinished uploads that were never shown are deleted.
- **Not covered.** Encryption does not protect against malware or a malicious browser extension on an unlocked device, or against someone who can change the code served to your browser. Items copied out of the vault enter the system clipboard.

## Deployment

The site is static and has no build step. It can be hosted with GitHub Pages. Google sign-in must be enabled for the Firebase project, and the hosting domain must be authorized in Firebase Authentication settings.

**Deploy both the site and the Realtime Database rules, together.** The vault rules accept only encrypted records, so an older copy of the site cannot keep clips after the new rules are published. Pushing `database.rules.json` to GitHub does not apply the rules to Firebase. In Firebase Console, open **Realtime Database → Rules**, paste the contents of `database.rules.json`, and publish. Check that the Firebase project and the owner's user ID in the code match your project before publishing.

Alternatively, from the repository root with Firebase CLI configured:

```sh
firebase deploy --project fade-self-erasing-clipboard --only database
```

This command deploys database rules only and works with the Spark plan. The optional server cleanup function requires a separate deployment and a Blaze plan.

After deploying, test vault encryption: open the vault, set a passphrase, save the recovery key, keep a clip, exit, and confirm the passphrase is required again. Then test with three accounts: the owner can add and keep several clips; the invited account can add pink clips to the shared board but cannot open the vault; another account can add one private temporary clip and cannot keep it. Check that the invited account cannot change the owner's clip colors and that the owner sees the invited account's clips in pink.

For local development, serve the repository root:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Clipboard APIs require HTTPS or localhost and browser permission. Add localhost to Firebase Authentication's authorized domains if needed.

## Checks

```sh
node --test tests/*.test.cjs
node --check app.js
node --check organizer.js
node --check crypto.js
```

These local checks do not replace testing the published Firebase rules with separate Google accounts.

## License

MIT.
