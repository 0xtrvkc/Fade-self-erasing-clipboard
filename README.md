# Fade

A cross-device clipboard that self-erases. Paste text, a link, or an image on your phone, see it instantly on your desktop (and vice versa) — every item fades out and deletes itself 10 minutes after it's added.

**Live app:** https://0xtrvkc.github.io/Fade-self-erasing-clipboard/

## Why

Bouncing between phone and desktop (or app and browser) usually means emailing yourself a link or texting yourself a photo. Fade is a single page you keep open everywhere — paste on one device, grab it on another, and don't worry about cleanup. Everything expires on its own.

## Features

- **Cross-device sync** — items appear on every open device in real time via Firebase Realtime Database.
- **Three content types** — plain text, links (auto-detected and made clickable), and images.
- **Paste anywhere** — `Ctrl`/`Cmd`+`V` for text or images, or tap the image button to upload/take a photo on mobile.
- **Ticking countdown** — each item shows time remaining and visually fades (like thermal receipt paper) as it approaches deletion.
- **Auto-delete after 10 minutes** — removed from every device automatically. A manual "delete now" is also available per item.
- **No build step** — a single static `index.html`, deployable on GitHub Pages.

## Setup

This app needs a free Firebase project to sync data between devices — GitHub Pages only hosts static files, so Firebase Realtime Database acts as the shared storage.

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. Enable **Realtime Database** (left sidebar → Build → Realtime Database → Create Database).
3. Go to **Project settings → General → Your apps**, add a **Web app**, and copy the `firebaseConfig` object.
4. Open `index.html` and paste your config into the `firebaseConfig` block near the top of the `<script>` section (replacing the placeholder values).
5. In **Realtime Database → Rules**, set:
   ```json
   {
     "rules": {
       "clips": {
         ".read": true,
         ".write": true
       }
     }
   }
   ```
6. Push to GitHub and enable **GitHub Pages** (Settings → Pages → Deploy from branch → `main` / root).

## Security note

The `firebaseConfig` values (including `apiKey`) are safe to expose publicly — Firebase client keys aren't secrets, and GitHub's secret scanner sometimes flags them anyway. Access is actually controlled by the **Database Rules** above, which are intentionally open so any of your own devices can read/write without signing in. That means anyone who has your `databaseURL` could technically read or write to it too — an acceptable tradeoff for a personal, ephemeral scratchpad, but don't store anything sensitive here.

To tighten this later:
- Restrict the Firebase API key to your domain in Google Cloud Console → APIs & Services → Credentials.
- Add Firebase Anonymous Auth and scope the rules to `"auth != null"`.

## Tech

Vanilla HTML/CSS/JS, Firebase Realtime Database (via CDN, no build tooling). Images are resized and compressed client-side before syncing to keep payloads small.

## License

MIT — do whatever you'd like with it.
