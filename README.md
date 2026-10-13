# BIVA Desktop (Windows + Mac)

A desktop app for BIVA, like Claude Desktop: users download one installer, install it, and get a
**BIVA** icon on the desktop and Start Menu. The app opens the live BIVA site
(`https://biva-dev-app.onrender.com`) in its own window, so every deploy to Render shows up in the
desktop app automatically — no reinstall needed.

## What it does

- Opens BIVA in its own window (remembers size/position) with the BIVA icon in the taskbar.
- Remembers sign-in between launches.
- Monime checkout opens inside the app; other links (WhatsApp, email, etc.) open in the normal browser.
- Branded loading screen while Render wakes up, and an "offline" screen with auto-retry when there's no internet.
- Printing (receipts → *Print / Save PDF*) and file downloads (CSV exports) work as in a browser.
- Right-click Cut / Copy / Paste, spell-check, zoom (Ctrl + / Ctrl −), Back/Forward (Alt ← / Alt →).
- Only one copy runs at a time. Press **Alt** to show the menu (Home, Check for updates, About).
- Secure defaults: no Node.js access for the web page, sandboxed, permissions only for the BIVA site.

## Requirements (on the computer that builds it)

- Windows 10/11
- [Node.js 20 or newer](https://nodejs.org) (LTS)

## 1. Try it without installing

Double-click **`run-app.bat`** (or run `npm install` then `npm start`).

## 2. Build the installer on your computer (optional)

Double-click **`build-installer.bat`** (or `npm install` then `npm run dist`).
The installer is created at `dist\BIVA-Setup.exe`.

The installer is a normal Windows setup wizard: **Welcome → Install (progress bar 0–100%) → Finish**,
with **Run BIVA** ticked on the last page, so BIVA opens straight away. It adds a desktop shortcut,
a Start Menu entry, and an entry in *Settings → Apps* to uninstall.

> Windows shows a blue "Windows protected your PC" box for unsigned apps. Users click
> **More info → Run anyway**. To remove the warning, code-sign the app (see step 5).

## 3. Change which site the app opens

Edit `config.json`:

```json
{ "appUrl": "https://biva-dev-app.onrender.com", "startPath": "/account/login" }
```

Rebuild after changing it. Quick test against another server without rebuilding:
`set BIVA_APP_URL=http://localhost:3000 && npm start`.

## 4. Publish it so the website's Download button works

**Easiest:** double-click **`push-to-github.bat`** — it does steps 2–3 below for you.

The BIVA website (`/download` page → **Download for Windows**) serves the newest installer from this
repo's GitHub Releases and saves it as **`BIVA Setup.exe`**.

1. On GitHub, create a **public** repository **`salonetechdepot/Roarbyte-biva-desktop`**
   (public so anyone can download the installer — this folder contains no secrets).
2. Move the build script into place (one time), then push this folder:
   ```bat
   mkdir .github\workflows
   move ci\release.yml .github\workflows\release.yml
   git init
   git add .
   git commit -m "BIVA desktop app"
   git branch -M main
   git remote add origin https://github.com/salonetechdepot/Roarbyte-biva-desktop.git
   git push -u origin main
   ```
3. Release version 1.0.0:
   ```bat
   git tag v1.0.0
   git push origin v1.0.0
   ```
   GitHub Actions (`.github/workflows/release.yml`) builds `BIVA-Setup.exe` on Windows and publishes the
   Release (about 5–8 minutes; watch it in the repo's **Actions** tab). No token setup needed.
4. Open the website's `/download` page — the button now downloads `BIVA Setup.exe`
   (the page refreshes its version info every 10 minutes).
5. New version later: raise `"version"` in `package.json` (e.g. `1.1.1`) and run `push-to-github.bat` again.
   Installed apps update themselves and offer **Restart now**.

## Mac version

GitHub builds the Mac app at the same time as Windows (every `v*` tag) and attaches
**`BIVA-Mac.dmg`** to the same Release. It runs on every Mac (Apple Silicon M1–M4 and Intel), macOS 11+.

How Mac users install it:
1. Download `BIVA.dmg` from the website's Download page and open it.
2. Drag the **BIVA** icon onto the **Applications** folder.
3. Open BIVA from Applications. The first time, macOS says it can't check the developer:
   click **Done**, then go to **System Settings → Privacy & Security**, scroll down and click
   **Open Anyway** (on older macOS: right-click BIVA → Open → Open). This is only needed once.

When a new version is out, the Mac app shows **Update available → Download**.

To remove the first-open warning and get automatic Mac updates, join the Apple Developer Program
($99/year), then add these repository secrets (Settings → Secrets and variables → Actions):
`MAC_CERT_P12_BASE64` (your "Developer ID Application" certificate exported as .p12, base64),
`MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
The next release is then signed and notarized automatically.

A Mac build can't be made on Windows — GitHub's Mac machines do it for you.

## 5. Code signing (removes the Windows warning)

Buy a code-signing certificate (e.g. Azure Trusted Signing, Sectigo, DigiCert) and follow
electron-builder's Windows signing guide: https://www.electron.build/code-signing-win

## Files

| Path | Purpose |
|---|---|
| `config.json` | Which BIVA site to open |
| `src/main.js` | The desktop window, links, offline screen, menu, updates |
| `src/preload.js` | Lets the site detect the app (`window.bivaDesktop.isDesktop`) |
| `src/pages/` | Loading and offline screens |
| `build/icon.ico` | App + installer icon |
| `build/icon-mac.png`, `build/dmg-background.png`, `build/entitlements.mac.plist`, `build/afterPack.js` | Mac icon, DMG window, Mac permissions and signing |
| `build/installerSidebar.bmp` | Picture on the installer's Welcome/Finish pages |
| `ci/release.yml` → `.github/workflows/release.yml` | Builds + publishes the installer when you push a `v*` tag |
