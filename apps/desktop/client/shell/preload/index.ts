import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createDesktopApi } from './api';

// Electron host: bind the shared API surface to ipcRenderer. The mobile host
// (apps/mobile) binds the same factory to an HTTP/WebSocket adapter, so both
// renderer builds see an identical window.orisonDesktop.
const ipc = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
  on: (channel: string, listener: (payload: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped as never);
    return () => { ipcRenderer.removeListener(channel, wrapped as never); };
  },
};

export const exposedDesktopApi = createDesktopApi(ipc, {
  platform: process.platform,
  getLocale: () => navigator.language,
  pathForFile: (file: File) => webUtils.getPathForFile(file),
});

contextBridge.exposeInMainWorld('orisonDesktop', exposedDesktopApi);
