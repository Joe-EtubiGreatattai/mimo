<p align="center">
  <img src="docs/mimo-icon.png" width="128" alt="Mimo's app icon: a cartoon puppy with a red collar">
</p>

<h1 align="center">Mimo</h1>

<p align="center"><strong>A good dog for your full disk.</strong><br>
A tiny Mac menu bar app that watches your free space every minute and cleans up before you run out.</p>

<p align="center">
  <a href="https://github.com/Joe-EtubiGreatattai/mimo/releases/latest/download/Mimo.dmg"><strong>⬇︎ Download for macOS</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/Joe-EtubiGreatattai/mimo/releases/latest/download/Mimo-Setup.exe"><strong>⬇︎ Download for Windows</strong></a><br>
  <sub>Free · macOS 13+ (Apple silicon and Intel) · Windows 10 and 11</sub>
</p>

---

## What Mimo does

- **Checks every minute.** Mimo reads how much space macOS says you can actually use.
- **You pick the line.** He steps in when free space drops below 15 GB by default; set anything from 5 GB to 500 GB. He warns you 10 GB before that.
- **Asks before deleting.** He gathers everything he wants to remove on one Review screen, grouped by type with sizes and the biggest files. Untick what you want to keep, then approve. Prefer hands-off? Switch to *Clean automatically*.
- **You choose what he cleans.** Turn each category on or off in Settings.
- **Control him from your phone.** Settings › Phone › Pair a phone shows a QR code. Your phone gets Mimo Remote, an app you can add to your Home Screen: live free space, approve what he found, change settings. Phones only see totals and categories, never file names.
- **Checks in with you.** Notifications every 15 min, 30 min, 1 hour or 3 hours, so you know he's on patrol.
- **Shows his work.** Open his window to see a storage ring, what he can clean (with sizes) and a live activity feed.

## What he cleans

| Where | What happens |
|---|---|
| App caches (`~/Library/Caches`) | Deleted. Apps rebuild them. |
| Old WhatsApp media (older than 30 days) | Moved to the Bin, so you can restore anything. |
| Xcode build data (`DerivedData`) | Deleted. Xcode rebuilds it. |
| Gradle caches (`~/.gradle/caches`) | Deleted. Gradle downloads what it needs again. |
| npm cache (`~/.npm/_cacache`) | Deleted. Your projects keep their `node_modules`. |
| Old installers in Downloads (.dmg, .pkg, .zip, .iso) — *off by default* | Moved to the Bin. |
| Empty the Bin — *off by default* | Permanently deleted. |

He never touches your Documents, Desktop or Photos library, and only cleans the categories you've switched on. Your files never leave your computer. Mimo sends anonymous counts so his impact can be measured: one ping on first launch (a random install ID, app version, system version and chip type) and, after each clean, how much space he cleared per category. Never file names, folder names or anything you made. Turn it off in Settings › Privacy. If you pair a phone, he also shares storage totals, categories and his activity with that phone through Mimo's server.

## Install

1. Download **Mimo.dmg** and drag Mimo into your Applications folder.
2. Mimo isn't from the App Store yet, so the first time, **right-click Mimo and choose Open**, then confirm. (Or allow it in System Settings › Privacy & Security.)
3. Click **Allow** when macOS asks about notifications.
4. In **System Settings › Privacy & Security › Full Disk Access**, switch Mimo on so he can reach WhatsApp's folder.

Mimo starts by himself when you log in. To quit, open his window, click the menu next to **Check** and choose **Quit Mimo**.

## Windows

Run **Mimo-Setup.exe**. Mimo installs for your user (no admin needed) and lives in the system tray next to the clock. The installer isn't signed with a Microsoft certificate yet, so Windows may say it protected your PC: click **More info**, then **Run anyway**.

On Windows Mimo looks after temporary files (older than 2 days), Chrome, Edge and Firefox caches, old WhatsApp Desktop media, Teams, Slack and Discord caches, Spotify's cache, crash dumps, and npm, Yarn, pip and Gradle caches. Old installers in Downloads, NuGet packages and emptying the Recycle Bin are available but off by default. Everything else works like the Mac version: Review before deleting, mapping your folders, your own places, and phone control.

The Windows app is in [`windows/`](windows/) and is built and tested on a Windows machine by GitHub Actions for every release.

## Build from source

Mimo is a single SwiftUI file. You need the Xcode command line tools (`xcode-select --install`).

```bash
git clone https://github.com/Joe-EtubiGreatattai/mimo.git
cd mimo
./scripts/package.sh   # builds dist/Mimo.app and dist/Mimo.dmg (universal)
```

## Landing page

The website lives in [`docs/index.html`](docs/index.html). Turn on GitHub Pages (Settings › Pages › Deploy from branch › `main` / `docs`) to host it for free.

---

Made by [Great Attai](https://github.com/Joe-EtubiGreatattai).
