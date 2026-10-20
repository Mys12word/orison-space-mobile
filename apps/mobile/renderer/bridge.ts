/**
 * Browser bridge: binds the shared desktop API surface to the mobile host over
 * HTTP (invoke/send) + WebSocket (main → renderer events). Installed before the
 * React app mounts so every component sees the same window.orisonDesktop it
 * would get from the Electron preload.
 */
import { createDesktopApi, type DesktopIpcAdapter } from '../../desktop/client/shell/preload/api';

declare global {
  interface Window {
    __ORISON_TOKEN__?: string;
    __ORISON_MOBILE__?: boolean;
    orisonDesktop: unknown;
  }
}

const TOKEN = window.__ORISON_TOKEN__ ?? '';

type HostListener = (payload: unknown) => void;
const listeners = new Map<string, Set<HostListener>>();

function dispatch(channel: string, payload: unknown): void {
  const set = listeners.get(channel);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(payload);
    } catch (err) {
      console.error(`[bridge] listener for ${channel} failed`, err);
    }
  }
}

/** Subscribe to a host push channel (also used by host-level UI such as the picker). */
export function onHostEvent(channel: string, listener: HostListener): () => void {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel)!.add(listener);
  return () => listeners.get(channel)?.delete(listener);
}

let socket: WebSocket | null = null;
let reconnectDelay = 500;

function connectEvents(): void {
  const url = `ws://${location.host}/events?token=${encodeURIComponent(TOKEN)}`;
  const ws = new WebSocket(url);
  socket = ws;

  ws.addEventListener('open', () => {
    reconnectDelay = 500;
  });
  ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(String(event.data)) as { channel?: string; payload?: unknown };
      if (message.channel) dispatch(message.channel, message.payload);
    } catch (err) {
      console.error('[bridge] bad event payload', err);
    }
  });
  ws.addEventListener('close', () => {
    socket = null;
    // Keep retrying with backoff: the host may be restarting underneath a PWA.
    setTimeout(connectEvents, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  });
  ws.addEventListener('error', () => {
    ws.close();
  });
}

async function rpc(channel: string, args: unknown[], kind: 'invoke' | 'send'): Promise<unknown> {
  const response = await fetch('/rpc', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-orison-token': TOKEN,
    },
    body: JSON.stringify({ channel, args, kind }),
  });
  if (!response.ok) {
    throw new Error(`RPC ${channel} failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as
    | { ok: true; value: unknown }
    | { ok: false; error?: { message?: string; stack?: string } };
  if (!body.ok) {
    const error = new Error(body.error?.message ?? `RPC ${channel} failed`);
    if (body.error?.stack) error.stack = body.error.stack;
    throw error;
  }
  return body.value;
}

const adapter: DesktopIpcAdapter = {
  invoke: (channel, ...args) => rpc(channel, args, 'invoke'),
  send: (channel, ...args) => {
    void rpc(channel, args, 'send').catch((err) => console.error('[bridge] send failed', err));
  },
  on: (channel, listener) => onHostEvent(channel, listener),
};

const api = createDesktopApi(adapter, {
  platform: 'android' as NodeJS.Platform,
  getLocale: () => navigator.language,
  // Browsers deliberately hide absolute paths; drag-and-drop import is handled
  // by the mobile host's own folder picker instead.
  pathForFile: () => '',
});

export function installBridge(): void {
  window.orisonDesktop = api;
  connectEvents();

  // Host-level events the browser cannot handle itself. The APK shell exposes
  // window.AndroidHost; a plain browser falls back to window.open.
  onHostEvent('mobile:open-external', (url) => {
    if (typeof url !== 'string' || !url) return;
    const host = (window as unknown as { AndroidHost?: { openExternal?: (target: string) => void } }).AndroidHost;
    if (host && typeof host.openExternal === 'function') host.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  });
}

export { api as desktopApi };
