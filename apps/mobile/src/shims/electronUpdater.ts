/**
 * `electron-updater` replacement. The mobile build never self-updates through
 * the desktop NSIS/AppImage channel; updateIpc falls back to the "manual"
 * GitHub-release path (app.isPackaged === false), so this only needs to exist
 * for module evaluation.
 */
const autoUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  currentVersion: { version: '0.0.0' },
  on: () => autoUpdater,
  once: () => autoUpdater,
  removeListener: () => autoUpdater,
  checkForUpdates: async () => ({ updateInfo: null }),
  downloadUpdate: async () => [],
  quitAndInstall: () => undefined,
  setFeedURL: () => undefined,
};

export { autoUpdater };
export default { autoUpdater };
