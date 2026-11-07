<p align="center">
  <img src="docs/mimo-icon.png" width="128" alt="Mimo's app icon: a cartoon puppy with a red collar">
</p>

<h1 align="center">Mimo</h1>

<p align="center"><strong>A good dog for your full disk.</strong><br>
A tiny Mac menu bar app that watches your free space every minute and cleans up before you run out.</p>

<p align="center">
  <a href="https://github.com/Joe-EtubiGreatattai/mimo/releases/latest/download/Mimo.dmg"><strong>⬇︎ Download Mimo for macOS</strong></a><br>
  <sub>Free · macOS 13 Ventura or later · Apple silicon and Intel</sub>
</p>

---

## What Mimo does

- **Checks every minute.** Mimo reads how much space macOS says you can actually use.
- **Warns at 25 GB.** You get a friendly heads-up before things get tight.
- **Cleans below 15 GB.** He clears the stuff your Mac can rebuild, then tells you how much he freed.
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

He never touches your Documents, Desktop, Downloads or Photos library. Mimo runs entirely on your Mac and doesn't connect to the internet.

## Install

1. Download **Mimo.dmg** and drag Mimo into your Applications folder.
2. Mimo isn't from the App Store yet, so the first time, **right-click Mimo and choose Open**, then confirm. (Or allow it in System Settings › Privacy & Security.)
3. Click **Allow** when macOS asks about notifications.
4. In **System Settings › Privacy & Security › Full Disk Access**, switch Mimo on so he can reach WhatsApp's folder.

Mimo starts by himself when you log in. To quit, open his window, click the menu next to **Check** and choose **Quit Mimo**.

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
