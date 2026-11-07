# Mimo for Windows

The Windows version of Mimo: a tray app that watches free space on your system drive every minute, asks before deleting, and cleans temporary files, browser caches, WhatsApp Desktop media, chat app caches, crash dumps and developer caches.

- `src/engine.js` — Mimo's logic (plain Node, tested in `test/engine.test.js`)
- `src/places.js` — the places Mimo recognises on Windows
- `src/main.js` — Electron shell: tray icon, window, notifications, start at sign-in
- `src/ui/` — the window

```bash
npm install
npm test          # engine tests against a fake Windows user folder
npm start         # run it
npm run dist      # build dist/Mimo-Setup.exe (on Windows)
```

Releases are built by `.github/workflows/windows.yml` on a Windows runner.
