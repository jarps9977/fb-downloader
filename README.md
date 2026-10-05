# Story Video Downloader Pro

Node.js web app for extracting downloadable video URLs from Facebook and Instagram stories/videos.

The app supports two workflows:

1. Paste a public Facebook / Instagram URL and let the server analyze it.
2. Paste Page Source from a logged-in browser when the URL requires a session.

## Features

- Supports Facebook, fb.watch, and Instagram URLs.
- Always shows a Page Source box for private/login-required stories.
- Generates a `view-source:` link from the URL you enter.
- Parses direct MP4 URLs and DASH manifests.
- Shows one download option per quality, such as `1080p`, `720p`, `480p`, and `360p`.
- Picks the highest available resolution and merges DASH video + audio with `ffmpeg`.
- Shows previews and downloads posts, stories, and carousels (images and videos) one by one or as a ZIP.

## Requirements

- Node.js 18+
- npm

`ffmpeg` is required for full-quality video. Facebook / Instagram serve 1080p+ only as separate DASH video and audio tracks, which the server merges with `ffmpeg -c copy` (no re-encode). Without `ffmpeg`, downloads fall back to the progressive file (usually 720p).

## Run Locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Usage

### URL Flow

1. Paste a Facebook / Instagram URL.
2. Click the search button.
3. If the server can read the page, download options will appear.

### Page Source Flow

Use this when a story requires login.

1. Paste the URL into the app.
2. Copy the generated `view-source:` link.
3. Open that link in a browser where you are logged in.
4. Copy the full page source.
5. Paste it into `Page Source`.
6. Click `Show Download`.
7. Choose a quality and download.

For iOS, `view-source:` may not work directly. Use Safari Web Inspector or a Shortcut that copies page HTML/script content, then paste it into `Page Source`.

### iOS: Save to Photos

- In Safari, the results header shows `บันทึกลง Photos`. Tap once to prepare the files, then tap again to open the share sheet and choose Save Image / Save Video.
- iOS Shortcut: share a link from the Facebook / Instagram app. The Shortcut calls `POST /api/shortcut` and saves each returned file to the Photo Album. If the link needs login, the response includes `safariUrl` (`/go.html`), which opens the link in Safari. Share from Safari to the same Shortcut, and it sends `document.documentElement.outerHTML` as `source`.

## Deployment

This is an Express app, so it needs Node hosting. Static-only hosts such as GitHub Pages will not run the backend.

Recommended free/low-cost options:

- Render Web Service
- Railway
- Koyeb

The repo includes a `Dockerfile` (Node 20 + `ffmpeg`). On Render, create the Web Service with Language `Docker`. The repo also includes `nixpacks.toml` for platforms that use Nixpacks.

## Notes

- Private stories depend on the source copied from a logged-in browser.
- CDN video URLs can expire quickly, so download soon after parsing.
- The app is intended for downloading videos you own or have permission to download.
