/**
 * Minimal `electron` implementation for the mobile host.
 *
 * The desktop main process talks to the renderer over Electron IPC and touches a
 * small, well-defined slice of the Electron API (see docs/ipc/desktop-ipc.md).
 * This module re-implements exactly that slice on top of plain Node + a
 * WebSocket broadcast bus, so the existing main-process modules (project/file
 * handlers, model gateway, agent runtime, SQLite repositories, ...) run
 * unchanged on Android.
 */
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hostBridge } from './hostBridge';

/* ── paths ── */

function dataHome(): string {
  return process.env.ORISON_MOBILE_HOME || process.env.HOME || '/tmp';
}

function userDataDir(): string {
  return process.env.ORISON_MOBILE_USERDATA || path.join(dataHome(), '.orison', 'userdata');
}

const PATH_MAP: Record<string, () => string> = {
  home: dataHome,
  appData: () => path.join(dataHome(), '.orison'),
  userData: userDataDir,
  sessionData: userDataDir,
  logs: () => path.join(dataHome(), '.orison', 'logs'),
  temp: () => process.env.TMPDIR || '/tmp',
  desktop: dataHome,
  documents: () => path.join(dataHome(), 'Documents'),
  downloads: () => path.join(dataHome(), 'Downloads'),
  music: dataHome,
  pictures: dataHome,
  videos: dataHome,
};

/* ── app ── */

type Listener = (...args: unknown[]) => void;

class FakeApp {
  private listeners = new Map<string, Set<Listener>>();
  isPackaged = false;

  getVersion(): string {
    return hostBridge.appVersion;
  }

  getName(): string {
    return 'Orison Space';
  }

  getLocale(): string {
    return 'zh-CN';
  }

  getPath(name: string): string {
    const dir = (PATH_MAP[name] ?? dataHome)();
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch { /* read-only dirs are fine */ }
    }
    return dir;
  }

  getAppPath(): string {
    return process.cwd();
  }

  whenReady(): Promise<void> {
    return Promise.resolve();
  }

  isReady(): boolean {
    return true;
  }

  on(event: string, listener: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  quit(): void {
    process.exit(0);
  }

  exit(code = 0): void {
    process.exit(code);
  }

  setAppUserModelId(): void {}
  disableHardwareAcceleration(): void {}
}

export const app = new FakeApp();

/* ── ipcMain ── */

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpcMain {
  private handlers = new Map<string, IpcHandler>();
  private listeners = new Map<string, Set<IpcHandler>>();

  handle(channel: string, handler: IpcHandler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    }
    this.handlers.set(channel, handler);
  }

  handleOnce(channel: string, handler: IpcHandler): void {
    this.handle(channel, (event, ...args) => {
      this.handlers.delete(channel);
      return handler(event, ...args);
    });
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  on(channel: string, listener: IpcHandler): this {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
    this.listeners.get(channel)!.add(listener);
    return this;
  }

  once(channel: string, listener: IpcHandler): this {
    const wrapped: IpcHandler = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    return this.on(channel, wrapped);
  }

  removeListener(channel: string, listener: IpcHandler): this {
    this.listeners.get(channel)?.delete(listener);
    return this;
  }

  removeAllListeners(channel: string): this {
    this.listeners.delete(channel);
    return this;
  }

  /** Called by the HTTP RPC layer for `invoke` channels. */
  async invokeChannel(channel: string, args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No IPC handler registered for '${channel}'`);
    return await handler({}, ...args);
  }

  /** Called by the HTTP RPC layer for fire-and-forget `send` channels. */
  emitChannel(channel: string, args: unknown[]): void {
    const handlers = this.listeners.get(channel);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler({}, ...args);
      } catch (err) {
        console.error(`[ipcMain] listener for '${channel}' failed`, err);
      }
    }
  }

  hasChannel(channel: string): boolean {
    return this.handlers.has(channel) || (this.listeners.get(channel)?.size ?? 0) > 0;
  }

  registeredChannels(): string[] {
    return [...this.handlers.keys()];
  }
}

export const ipcMain = new FakeIpcMain();

/* ── BrowserWindow ── */

class FakeWebContents {
  send(channel: string, ...args: unknown[]): void {
    // Renderer event channels carry a single payload; keep the shape simple.
    hostBridge.broadcast(channel, args.length > 1 ? args : args[0]);
  }

  on(): void {}
  once(): void {}
  setWindowOpenHandler(): void {}
  getURL(): string {
    return process.env.ORISON_MOBILE_URL ?? 'http://127.0.0.1/';
  }
}

class FakeBrowserWindow {
  webContents = new FakeWebContents();
  static singleton: FakeBrowserWindow | null = null;

  constructor(_options?: Record<string, unknown>) {
    FakeBrowserWindow.singleton = this;
  }

  static getAllWindows(): FakeBrowserWindow[] {
    return FakeBrowserWindow.singleton ? [FakeBrowserWindow.singleton] : [];
  }

  static getFocusedWindow(): FakeBrowserWindow | null {
    return FakeBrowserWindow.singleton;
  }

  on(): this {
    return this;
  }

  once(): this {
    return this;
  }

  isMaximized(): boolean {
    // A phone browser window is always "full screen" from the app's point of view.
    return true;
  }

  isMinimized(): boolean {
    return false;
  }

  isFullScreen(): boolean {
    return false;
  }

  minimize(): void {}
  maximize(): void {}
  unmaximize(): void {}
  restore(): void {}
  close(): void {}
  focus(): void {}
  show(): void {}
  hide(): void {}
  setTitle(title: string): void {
    hostBridge.broadcast('window:title', title);
  }
  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  loadFile(): Promise<void> {
    return Promise.resolve();
  }
}

export const BrowserWindow = FakeBrowserWindow;

/* ── dialog ── */

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export const dialog = {
  async showOpenDialog(options: {
    title?: string;
    defaultPath?: string;
    properties?: string[];
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<OpenDialogResult> {
    return hostBridge.picker.pick(options);
  },
  async showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }> {
    return { canceled: true };
  },
  async showMessageBox(): Promise<{ response: number }> {
    return { response: 0 };
  },
};

/* ── shell ── */

function log(): (message: string) => void {
  return (message: string) => console.log(`[shell] ${message}`);
}

export const shell = {
  async openPath(target: string): Promise<string> {
    // The phone has no association API from a background Node process; surface
    // the path in the UI instead of failing silently.
    log()(`openPath: ${target}`);
    hostBridge.broadcast('mobile:open-path', target);
    return '';
  },
  async openExternal(url: string): Promise<void> {
    log()(`openExternal: ${url}`);
    hostBridge.broadcast('mobile:open-external', url);
  },
  showItemInFolder(target: string): void {
    log()(`showItemInFolder: ${target}`);
    hostBridge.broadcast('mobile:reveal-path', target);
  },
  async trashItem(target: string): Promise<void> {
    // Android has no system trash. Projects live on shared storage
    // (/storage/emulated/0/Android/data/<pkg>/...), while the app's own trash
    // folder is on internal storage — rename() across those filesystems fails
    // with EXDEV, which used to make "delete project" fail outright.
    const { mkdir, rename, cp, rm } = await import('node:fs/promises');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${path.basename(target)}`;
    const candidates = [
      path.join(dataHome(), '.orison', 'trash'),
      path.join(path.dirname(target), '.orison-trash'),
    ];
    let lastError: unknown = null;
    for (const dir of candidates) {
      try {
        await mkdir(dir, { recursive: true });
        await rename(target, path.join(dir, name));
        return;
      } catch (error) {
        lastError = error;
        console.warn(`[shell] trash rename failed (${dir})`, error);
      }
    }
    // Last resort: copy next to the project (same volume) and delete the source.
    try {
      const dir = path.join(path.dirname(target), '.orison-trash');
      await mkdir(dir, { recursive: true });
      await cp(target, path.join(dir, name), { recursive: true });
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      console.error('[shell] trash fallback failed', error, lastError);
      throw error;
    }
  },
};

/* ── net ── */

export const net = {
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('file:')) {
      const { readFile } = await import('node:fs/promises');
      const filePath = decodeURIComponent(new URL(url).pathname);
      const buffer = await readFile(filePath);
      return new Response(buffer as unknown as BodyInit, {
        headers: { 'content-type': guessMime(filePath) },
      });
    }
    return fetch(url, init);
  },
};

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json',
    '.yaml': 'text/yaml; charset=utf-8',
    '.yml': 'text/yaml; charset=utf-8',
  };
  return map[ext] ?? 'application/octet-stream';
}

/* ── safeStorage ── */

/**
 * Android has no desktop-style OS keyring reachable from plain Node, so API
 * keys are encrypted with an app-local AES-256-GCM key stored under the app's
 * private data root (mode 0600). This is weaker than a hardware-backed keystore
 * but strictly better than plaintext, and keeps the ModelConfig format intact.
 */
function keystoreFile(): string {
  return path.join(dataHome(), '.orison', 'mobile', 'keystore.bin');
}

function keystoreKey(): Buffer {
  const file = keystoreFile();
  if (existsSync(file)) return readFileSync(file);
  mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return true;
  },
  encryptString(plainText: string): Buffer {
    const key = keystoreKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
  },
  decryptString(encrypted: Buffer): string {
    const key = keystoreKey();
    const iv = encrypted.subarray(0, 12);
    const tag = encrypted.subarray(12, 28);
    const payload = encrypted.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
  },
  getSelectedStorageBackend(): string {
    return 'app-local-aes-256-gcm';
  },
  /** Stable id used by some Electron paths to namespace secrets. */
  getSelectedStorageBackendId(): string {
    return createHash('sha256').update(keystoreKey()).digest('hex').slice(0, 16);
  },
};

/* ── unused-by-host stubs (present so the aliased module is import-complete) ── */

export const protocol = {
  handle(): void {},
  registerFileProtocol(): void {},
};
export const session = {
  defaultSession: {
    webRequest: { onHeadersReceived(): void {} },
  },
};
export const contextBridge = { exposeInMainWorld(): void {} };
export const ipcRenderer = {
  invoke: async (): Promise<unknown> => undefined,
  send(): void {},
  on(): void {},
  removeListener(): void {},
};
export const webUtils = { getPathForFile: (): string => '' };
export const Menu = { buildFromTemplate: (): null => null, setApplicationMenu(): void {} };
export const nativeTheme = { shouldUseDarkColors: false, on(): void {} };

const electronDefault = {
  app,
  ipcMain,
  BrowserWindow,
  dialog,
  shell,
  net,
  safeStorage,
  protocol,
  session,
  contextBridge,
  ipcRenderer,
  webUtils,
  Menu,
  nativeTheme,
};

export default electronDefault;
