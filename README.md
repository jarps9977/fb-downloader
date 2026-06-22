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
- Downloads video-only files for DASH streams. Audio is intentionally ignored.

## Requirements

- Node.js 18+
- npm

`ffmpeg` is optional. The current UI downloads video-only streams and does not require audio merging.

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

## Deployment

This is an Express app, so it needs Node hosting. Static-only hosts such as GitHub Pages will not run the backend.

Recommended free/low-cost options:

- Render Web Service
- Railway
- Koyeb

The repo includes `nixpacks.toml` for platforms that use Nixpacks.

## Notes

- Private stories depend on the source copied from a logged-in browser.
- CDN video URLs can expire quickly, so download soon after parsing.
- The app is intended for downloading videos you own or have permission to download.
