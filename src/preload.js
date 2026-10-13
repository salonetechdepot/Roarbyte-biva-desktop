// Runs before the BIVA web page with no Node access exposed to it.
// The page can detect the desktop app with `window.bivaDesktop?.isDesktop`.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("bivaDesktop", {
  isDesktop: true,
  platform: process.platform,
});
