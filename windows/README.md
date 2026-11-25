# Mimo for Windows and Linux

The Windows and Linux versions of Mimo (one Electron app): a tray app that watches free space on your system drive every minute, asks before deleting, and cleans temporary files, browser caches, WhatsApp Desktop media, chat app caches, crash dumps and developer caches.

- `src/engine.js` — Mimo's logic (plain Node, tested in `test/engine.test.js`)
- `src/places.js` — the places Mimo recognises on Windows and on Linux (XDG folders, Snap browsers, ~/.local/share/Trash)
- `src/main.js` — Electron shell: tray icon, window, notifications, start at sign-in
- `src/ui/` — the window

```bash
npm install
npm test          # engine tests against fake Windows and Linux home folders
npm start         # run it
npm run dist      # build dist/Mimo-Setup.exe (on Windows)
npm run dist:linux # build dist/Mimo-Linux.AppImage and dist/Mimo-Linux.deb (on Linux)
```

Releases are built by `.github/workflows/windows.yml` on Windows and Ubuntu runners.

On Linux the AppImage updates itself; the .deb tells you when a new version is out. Mimo starts at login through `~/.config/autostart/mimo.desktop`.
