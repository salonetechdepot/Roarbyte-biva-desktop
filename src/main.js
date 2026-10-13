/**
 * BIVA desktop — a secure window around the hosted BIVA web app (Render).
 * Everything BIVA does still happens on the server; this shell only adds a desktop window,
 * remembered sign-in, an offline screen, printing/downloads and automatic updates.
 */
const { app, BrowserWindow, Menu, shell, session, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// ---------------------------------------------------------------- configuration

function readConfig() {
  const defaults = {
    appUrl: "https://biva-dev-app.onrender.com",
    startPath: "/account/login",
    inAppHosts: ["monime.io"],
    windowTitle: "BIVA",
  };
  try {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
    return { ...defaults, ...file };
  } catch {
    return defaults;
  }
}

const config = readConfig();
// Optional override for testing another deployment: set BIVA_APP_URL before starting.
const APP_URL = (process.env.BIVA_APP_URL || config.appUrl).replace(/\/+$/, "");
const APP_ORIGIN = new URL(APP_URL).origin;
const START_URL = APP_URL + (config.startPath || "/");
const PAGES = path.join(__dirname, "pages");

/** BIVA pages and the Monime checkout stay inside the app; everything else opens in the normal browser. */
function isInApp(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") return url.pathname.includes("/pages/");
    if (url.protocol === "about:") return true;
    if (url.origin === APP_ORIGIN) return true;
    if (url.protocol !== "https:") return false;
    return (config.inAppHosts || []).some((host) => url.hostname === host || url.hostname.endsWith("." + host));
  } catch {
    return false;
  }
}

function openOutside(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (["https:", "http:", "mailto:", "tel:"].includes(url.protocol)) void shell.openExternal(url.toString());
  } catch {
    // ignore malformed links
  }
}

// ---------------------------------------------------------------- window size memory

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (s.width >= 800 && s.height >= 560) return s;
  } catch {
    // first run
  }
  return { width: 1360, height: 860, maximized: false };
}

function saveWindowState(win) {
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...bounds, maximized: win.isMaximized() }));
  } catch {
    // not critical
  }
}

// ---------------------------------------------------------------- windows

let mainWindow = null;

function secureWebPreferences() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: true,
    preload: path.join(__dirname, "preload.js"),
  };
}

/** Rules shared by the main window and any popup (e.g. the Monime checkout tab). */
function wireNavigation(win) {
  const contents = win.webContents;

  contents.setWindowOpenHandler(({ url }) => {
    // BIVA opens an empty tab first, then sends it to Monime — allow that inside the app.
    if (!url || url === "about:blank" || isInApp(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 800,
          autoHideMenuBar: true,
          icon: path.join(__dirname, "..", "assets", "icon.png"),
          webPreferences: secureWebPreferences(),
        },
      };
    }
    openOutside(url);
    return { action: "deny" };
  });

  contents.on("did-create-window", (child) => wireNavigation(child));

  contents.on("will-navigate", (event, url) => {
    if (!isInApp(url)) {
      event.preventDefault();
      openOutside(url);
    }
  });

  contents.on("context-menu", (_event, params) => {
    const template = [];
    if (params.misspelledWord && params.dictionarySuggestions.length) {
      for (const word of params.dictionarySuggestions.slice(0, 4)) {
        template.push({ label: word, click: () => contents.replaceMisspelling(word) });
      }
      template.push({ type: "separator" });
    }
    if (params.linkURL) {
      template.push({ label: "Open link in browser", click: () => openOutside(params.linkURL) });
      template.push({ type: "separator" });
    }
    template.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll" },
    );
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function showOffline(win, failedUrl, reason) {
  const target = failedUrl && failedUrl.startsWith(APP_ORIGIN) ? failedUrl : START_URL;
  void win.loadFile(path.join(PAGES, "offline.html"), { query: { target, reason: reason || "" } });
}

function createMainWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 600,
    title: config.windowTitle,
    backgroundColor: "#12345B",
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: secureWebPreferences(),
  });

  if (state.maximized) mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", () => saveWindowState(mainWindow));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  wireNavigation(mainWindow);

  // Keep the BIVA title instead of each page's title.
  mainWindow.on("page-title-updated", (event, title) => {
    event.preventDefault();
    const page = (title || "").replace(/\s*·\s*BIVA\s*$/i, "").trim();
    mainWindow.setTitle(page && page !== "BIVA" ? `${page} · BIVA` : "BIVA");
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 = navigation aborted (normal when a page redirects); ignore sub-frames.
    if (!isMainFrame || code === -3) return;
    showOffline(mainWindow, url, description);
  });

  mainWindow.webContents.on("render-process-gone", () => {
    if (mainWindow) showOffline(mainWindow, START_URL, "The window stopped unexpectedly.");
  });

  // Splash first (Render can take a while to wake up), then the real app.
  void mainWindow.loadFile(path.join(PAGES, "splash.html")).then(() => {
    if (mainWindow) void mainWindow.loadURL(START_URL);
  });
}

// ---------------------------------------------------------------- menu

function buildMenu() {
  const go = (url) => mainWindow && void mainWindow.loadURL(url);
  const template = [
    {
      label: "BIVA",
      submenu: [
        { label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: () => go(START_URL) },
        { type: "separator" },
        {
          label: "Check for updates",
          click: () => checkForUpdates(true),
        },
        {
          label: "About BIVA",
          click: () =>
            dialog.showMessageBox({
              type: "info",
              title: "About BIVA",
              message: `BIVA ${app.getVersion()}`,
              detail: `Business Inventory & Visibility Assistant\nConnected to ${APP_ORIGIN}\n© Roarbyte`,
            }),
        },
        { type: "separator" },
        { role: "quit", label: "Quit BIVA" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        {
          label: "Back",
          accelerator: "Alt+Left",
          click: () => mainWindow?.webContents.navigationHistory.canGoBack() && mainWindow.webContents.navigationHistory.goBack(),
        },
        {
          label: "Forward",
          accelerator: "Alt+Right",
          click: () =>
            mainWindow?.webContents.navigationHistory.canGoForward() && mainWindow.webContents.navigationHistory.goForward(),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
    {
      label: "Help",
      submenu: [
        { label: "BIVA website", click: () => openOutside(APP_URL) },
        { label: "Contact support", click: () => go(APP_URL + "/contact") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- permissions

function lockDownPermissions() {
  const ses = session.defaultSession;
  // Mark requests from the desktop app (handy in server logs).
  ses.setUserAgent(`${ses.getUserAgent()} BIVA-Desktop/${app.getVersion()}`);

  const allowed = new Set(["clipboard-sanitized-write", "clipboard-read", "media", "notifications", "fullscreen"]);
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    let origin = "";
    try {
      origin = new URL(contents.getURL()).origin;
    } catch {
      // ignore
    }
    callback(origin === APP_ORIGIN && allowed.has(permission));
  });
}

// ---------------------------------------------------------------- updates

let updaterReady = false;

function checkForUpdates(manual) {
  // Updates only work in an installed build that was published with a "publish" setting.
  const feed = path.join(process.resourcesPath || "", "app-update.yml");
  if (!app.isPackaged || !fs.existsSync(feed)) {
    if (manual) {
      void dialog.showMessageBox({
        type: "info",
        title: "Updates",
        message: "Automatic updates are not set up for this copy of BIVA.",
        detail: "Download the latest installer from the BIVA website.",
      });
    }
    return;
  }

  const { autoUpdater } = require("electron-updater");
  if (!updaterReady) {
    updaterReady = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-downloaded", (info) => {
      void dialog
        .showMessageBox({
          type: "info",
          buttons: ["Restart now", "Later"],
          defaultId: 0,
          title: "Update ready",
          message: `BIVA ${info.version} is ready to install.`,
          detail: "Restart BIVA to finish updating. It will also install the next time you close the app.",
        })
        .then(({ response }) => response === 0 && autoUpdater.quitAndInstall());
    });
    autoUpdater.on("error", (error) => console.warn("Update check failed:", error?.message || error));
  }

  autoUpdater
    .checkForUpdates()
    .then((result) => {
      if (manual && (!result || !result.isUpdateAvailable)) {
        void dialog.showMessageBox({ type: "info", title: "Updates", message: "You have the latest version of BIVA." });
      }
    })
    .catch((error) => {
      if (manual) void dialog.showMessageBox({ type: "warning", title: "Updates", message: "Could not check for updates.", detail: String(error?.message || error) });
    });
}

// ---------------------------------------------------------------- start

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.setAppUserModelId("com.roarbyte.biva");

  // Block anything that tries to attach a webview.
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  app.whenReady().then(() => {
    lockDownPermissions();
    buildMenu();
    createMainWindow();
    setTimeout(() => checkForUpdates(false), 10_000);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
