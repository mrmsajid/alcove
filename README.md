# Alcove

A productivity and privacy focused browser for Mac and Windows. Tabs live in a floating sidebar, the page gets the
whole window, and the everyday tools (timers, notes, a Markdown editor) are built in.

Built on [Electron](https://www.electronjs.org/) (Chromium). Plain HTML, CSS and JavaScript, no framework, no bundler.

## What it does

- **Sidebar-first browsing:** tabs, spaces, tab groups, pinned tabs, split view, peek, a Cmd/Ctrl+K command palette.
- **Start page:** a search bar, pinned website shortcuts, a live daily report (to-dos done, Markdown to-dos done,
  time spent) and your tools.
- **Privacy:** built-in ad and tracker blocking, Do Not Track, optional HTTPS-only, per-site permissions, no
  account, no telemetry.
- **Tools:** timers, stopwatch, Pomodoro, alarms, time tracking, focus mode (blocks distracting sites), world clock,
  notes and to-dos.
- **Markdown editor:** Visual and Code views, folders you mount like vaults, search, tags, a graph of linked notes.
- **Also:** Chrome Web Store extensions, screenshots, YouTube ad skipping and SponsorBlock, video download,
  import from other browsers, profiles, a frosted-glass look.

## Install

There are no releases yet. Build it yourself (below), or take the installers from the **Actions** tab of this
repository (`alcove-electron-macos`, `alcove-electron-windows`).

> **Windows warns about the installer?** The Windows installer is not code signed yet, so Chrome and Windows
> SmartScreen call it "uncommon" or "dangerous". In Chrome open the downloads list, click the three dots next to
> the file, choose **Keep**, then **Keep anyway**. In SmartScreen choose **More info**, then **Run anyway**. See
> [Code signing policy](#code-signing-policy).
>
> **macOS** builds are not notarized yet either, so the first launch may be blocked: allow it in System Settings ›
> Privacy & Security (**Open Anyway**).

## Build from source

You need a current [Node.js](https://nodejs.org/).

```bash
cd electron
npm install
npm start          # run it
npm run dist       # build an installer into electron/dist (.dmg on macOS, .exe on Windows)
```

The developer guide, with the architecture, how the pieces talk to each other, and a checklist for the Windows
build, is in [docs/DEVELOPER.md](docs/DEVELOPER.md).

## Privacy

Alcove has no account, no analytics and no telemetry. Your browsing history, bookmarks, tabs, notes, to-dos, timers
and time tracking are stored on your device only.

Besides the websites you visit, Alcove contacts these services, and only for the feature named:

| Service | Why |
| --- | --- |
| Ad-block filter lists (via the [Ghostery adblocker](https://github.com/ghostery/adblocker) library) | keep the ad blocker up to date |
| `sponsor.ajay.app` | SponsorBlock on YouTube (sends a short hash prefix of the video id, not the id) |
| `clients2.google.com` | installing and updating extensions from the Chrome Web Store |
| `github.com` (yt-dlp and ffmpeg releases) | downloading the video tools, only when you set up video download |
| `open.er-api.com` | exchange rates in the command palette |
| The sites in your start page shortcuts | each one's `/favicon.ico`, the same way the sidebar gets tab icons |

Do Not Track is on by default. Ad blocking and SponsorBlock can be switched off in Settings; the other services are
only contacted when you use the feature.

## Code signing policy

The Windows installer is **not code signed yet**. We intend to apply for free code signing for open-source projects
from the [SignPath Foundation](https://signpath.org/) once the project has public releases. This section will be
updated with the signing details and the team roles when that is in place. Until then, check the installer you
download came from this repository's Releases or Actions page.

## License

[MIT](LICENSE). Third-party software keeps its own licenses: Electron (MIT), Chromium (BSD-style and others, listed in the
`LICENSES.chromium.html` that ships with every build), the Ghostery adblocker (MPL-2.0), adm-zip (MIT) and
qrcode-generator by Kazuhiko Arase (MIT, in `ui/vendor/qrcode.js`).
