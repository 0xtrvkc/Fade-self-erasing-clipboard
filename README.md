# Fade

A cross-device clipboard with Google sign-in. Temporary clips fade after ten minutes. The owner also has a private Keep vault for clips that should stay.

[Open Fade](https://0xtrvkc.github.io/Fade-self-erasing-clipboard/)

## How it works

- Add text, links, or images on one device and copy them on another.
- Search, sort, pin, label, and organize clips into groups. Layout and collapsed-group preferences are stored in each browser; clipboard content is stored in Firebase.
- Temporary clips disappear from the app after ten minutes. While an app session is open, it also tries to remove expired records from Firebase.
- The owner can move clips into the private vault with **Keep**. Type `iii` to open it. This shortcut hides the vault screen; it is not a password.
- Images can be copied or shared with the device's native share controls. Clipboard permissions and browser support vary.

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
2. Type or paste a clip, then select **Add clip**. You can also select an image.
3. Tap **Copy** on another device before the temporary clip expires.
4. If you are the owner, use **Keep** to save a clip to the vault. Type `iii` in the clipboard composer to open the vault.

On desktop, **Enter** adds a clip and **Shift+Enter** makes a new line. On touch devices, use **Add clip**; **Ctrl/Cmd+Enter** also works. The app supports reduced-motion preferences.

## Data and expiry

Firebase Realtime Database stores each account's clips under `users/<uid>/clips` and the owner's kept items under `users/<owner uid>/kept`. The invited account uses the owner's temporary clipboard path. Database rules control who can read and write each path; hiding a button in the app is not an access control.

Expiry is enforced in the open app. A scheduled Cloud Function is included for server-side cleanup while no browser is open, but deploying it requires a Blaze plan. On Spark, expired records may remain in Firebase until an app session clears them. The vault has no expiry. Keep a separate backup of anything you cannot afford to lose.

Fade does not provide end-to-end encryption. Firebase project administrators can access stored content. The Firebase web configuration in `app.js` identifies the project; it is not a private service-account key.

## Deployment

The site is static and has no build step. It can be hosted with GitHub Pages. Google sign-in must be enabled for the Firebase project, and the hosting domain must be authorized in Firebase Authentication settings.

**Deploy both the site and the Realtime Database rules.** Pushing `database.rules.json` to GitHub does not apply the rules to Firebase. In Firebase Console, open **Realtime Database → Rules**, paste the contents of `database.rules.json`, and publish. Check that the Firebase project and the owner's user ID in the code match your project before publishing.

Alternatively, from the repository root with Firebase CLI configured:

```sh
firebase deploy --project fade-self-erasing-clipboard --only database
```

This command deploys database rules only and works with the Spark plan. The optional server cleanup function requires a separate deployment and a Blaze plan.

After deploying, test with three accounts: the owner can add and keep several clips; the invited account can add pink clips to the shared board but cannot open the vault; another account can add one private temporary clip and cannot keep it. Check that the invited account cannot change the owner's clip colors and that the owner sees the invited account's clips in pink.

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
```

These local checks do not replace testing the published Firebase rules with separate Google accounts.

## License

MIT.
