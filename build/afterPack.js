// Without an Apple Developer certificate the Mac app is "ad-hoc" signed so it can still open
// (otherwise macOS on Apple Silicon reports the app as damaged). With a certificate
// (CSC_LINK set), electron-builder signs and notarizes it properly instead.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app} (no Apple certificate configured)`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
