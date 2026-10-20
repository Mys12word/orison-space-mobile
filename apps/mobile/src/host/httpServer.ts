/**
 * HTTP + WebSocket host for the mobile build.
 *
 *  - GET  /                         → the built renderer (PWA shell)
 *  - POST /rpc                      → Electron-IPC-shaped invoke/send bridge
 *  - GET  /events                   → WebSocket push channel (main → renderer)
 *  - GET  /orison-file/<path>       → local project file access (replaces the
 *                                     desktop `orison-file://` protocol)
 *  - POST /api/mobile/*             → folder picker + host info helpers
 *
 * Everything is bound to 127.0.0.1 and guarded by a per-process bearer token
 * that is injected into index.html at serve time.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { ipcMain } from '../shims/electron';
import { PickerService } from './picker';
import { hostBridge } from '../shims/hostBridge';
import { assertSafePath, isSafePath, getOrisonSpaceRoot } from '../../../desktop/client/shell/main/ipc/pathGuard';

export interface HttpServerOptions {
  dataRoot: string;
  projectsRoot: string;
  port: number;
  appVersion: string;
  rendererDir: string;
}

export interface HostServer {
  port: number;
  url: string;
  token: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.mp4': 'video/mp4',
};

function mimeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody<T>(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

export async function startHostServer(options: HttpServerOptions): Promise<HostServer> {
  const token = randomBytes(18).toString('hex');
  const clients = new Set<WebSocket>();

  const broadcast = (channel: string, payload: unknown): void => {
    const message = JSON.stringify({ channel, payload });
    for (const client of clients) {
      if (client.readyState === 1) client.send(message);
    }
  };

  const picker = new PickerService(broadcast, options.projectsRoot);
  hostBridge.picker = picker;
  hostBridge.broadcast = broadcast;
  hostBridge.appVersion = options.appVersion;

  // The projects root is passed explicitly by the host boot sequence. Do not
  // re-derive it from env/module state here: a mismatched copy is exactly what
  // made the picker reject its own default directory inside the APK.
  const listRoots = (): string[] => [
    path.resolve(options.projectsRoot),
    getOrisonSpaceRoot(),
    path.resolve(options.dataRoot),
    '/storage/emulated/0/Documents',
  ];

  const assertListable = (target: string): void => {
    const safe = listRoots().some((root) => isSafePath(root, target));
    if (!safe) throw new Error(`目录不在手机版允许访问的范围内: ${target}`);
  };

  // Read index.html per request: a rebuild while the host keeps running must be
  // picked up on the next reload without restarting the server.
  const readInjectedHtml = async (): Promise<string> => {
    const indexHtml = await readFile(path.join(options.rendererDir, 'index.html'), 'utf8');
    const debug = process.env.ORISON_DEBUG_VIEWPORT
      ? `<script>window.addEventListener('load',()=>{document.title='W'+window.innerWidth+' D'+window.devicePixelRatio;});</script>`
      : '';
    return indexHtml.replace(
      '</head>',
      `<script>window.__ORISON_TOKEN__=${JSON.stringify(token)};window.__ORISON_MOBILE__=true;</script>${debug}</head>`,
    );
  };

  const serveStatic = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(await readInjectedHtml());
      return true;
    }
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const target = path.join(options.rendererDir, rel);
    if (!isSafePath(options.rendererDir, target)) return false;

    // SPA fallback: unknown non-asset routes render the app shell.
    const looksLikeAsset = path.extname(target) !== '';
    let filePath = target;
    if (!existsSync(filePath)) {
      if (looksLikeAsset) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return true;
      }
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(await readInjectedHtml());
      return true;
    }
    if (statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    if (!existsSync(filePath)) return false;

    const immutable = rel.startsWith('assets/');
    res.writeHead(200, {
      'content-type': mimeFor(filePath),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'content-length': statSync(filePath).size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(filePath).pipe(res);
    return true;
  };

  const serveProjectFile = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    const encoded = pathname.slice('/orison-file/'.length);
    const raw = decodeURIComponent(encoded);
    const target = path.resolve(raw);
    try {
      assertSafePath(target);
    } catch (err) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(err instanceof Error ? err.message : 'forbidden');
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': mimeFor(target),
      'cache-control': 'no-cache',
      'content-length': statSync(target).size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(target).pipe(res);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname.startsWith('/orison-file/')) {
        await serveProjectFile(req, res, pathname);
        return;
      }

      /* ── mobile host APIs ── */
      if (pathname.startsWith('/api/mobile/')) {
        if (url.searchParams.get('token') !== token) {
          sendJson(res, 401, { ok: false, error: 'bad token' });
          return;
        }

        if (pathname === '/api/mobile/info') {
          sendJson(res, 200, {
            ok: true,
            value: {
              version: options.appVersion,
              dataRoot: options.dataRoot,
              projectsRoot: options.projectsRoot,
              platform: 'android',
              home: process.env.ORISON_MOBILE_HOME,
            },
          });
          return;
        }

        if (pathname === '/api/mobile/list-dirs' && req.method === 'POST') {
          const body = await readJsonBody<{ path?: string; kind?: 'directory' | 'file'; extensions?: string[] }>(req);
          const requested = body.path ? path.resolve(body.path) : options.projectsRoot;
          assertListable(requested);
          const entries = await readdir(requested, { withFileTypes: true });
          const extensions = body.extensions?.map((ext) => `.${ext.toLowerCase().replace(/^\./, '')}`);
          const dirs = entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => ({ name: entry.name, path: path.join(requested, entry.name) }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
          const files = (body.kind === 'file' ? entries : [])
            .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
            .filter((entry) => !extensions || extensions.includes(path.extname(entry.name).toLowerCase()))
            .map((entry) => ({ name: entry.name, path: path.join(requested, entry.name) }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
          const parent = path.dirname(requested);
          const canGoUp = listRoots().some((root) => isSafePath(root, parent));
          sendJson(res, 200, { ok: true, value: { path: requested, parent: canGoUp ? parent : null, dirs, files } });
          return;
        }

        if (pathname === '/api/mobile/mkdir' && req.method === 'POST') {
          const body = await readJsonBody<{ parent?: string; name?: string }>(req);
          if (!body.parent || !body.name) throw new Error('parent 和 name 必填');
          const target = path.join(path.resolve(body.parent), body.name);
          assertListable(body.parent);
          await mkdir(target, { recursive: true });
          sendJson(res, 200, { ok: true, value: { path: target } });
          return;
        }

        if (pathname === '/api/mobile/pick-result' && req.method === 'POST') {
          const body = await readJsonBody<{ id?: string; paths?: string[] | null }>(req);
          const ok = body.id ? picker.resolve(body.id, body.paths ?? null) : false;
          sendJson(res, 200, { ok, value: null });
          return;
        }

        sendJson(res, 404, { ok: false, error: 'unknown mobile api' });
        return;
      }

      /* ── RPC bridge ── */
      if (pathname === '/rpc' && req.method === 'POST') {
        if (req.headers['x-orison-token'] !== token) {
          sendJson(res, 401, { ok: false, error: 'bad token' });
          return;
        }
        const body = await readJsonBody<{ channel?: string; args?: unknown[]; kind?: 'invoke' | 'send' }>(req);
        const channel = body.channel;
        const args = Array.isArray(body.args) ? body.args : [];
        if (!channel || typeof channel !== 'string') {
          sendJson(res, 400, { ok: false, error: 'channel required' });
          return;
        }
        if (body.kind === 'send') {
          ipcMain.emitChannel(channel, args);
          sendJson(res, 200, { ok: true, value: null });
          return;
        }
        try {
          const value = await ipcMain.invokeChannel(channel, args);
          sendJson(res, 200, { ok: true, value: value === undefined ? null : value });
        } catch (err) {
          const error = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) };
          sendJson(res, 200, { ok: false, error });
        }
        return;
      }

      /* ── viewport diagnostic (no auth: static, no app data) ── */
      if (pathname === '/diag') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>DIAG2</title><style>
html,body{margin:0;padding:0;font:16px/1.4 sans-serif;color:#fff}
h1{font-size:20px;padding:12px}
body{background:#a33}
@media (max-width:760px){body{background:#3a3}}
</style></head>
<body><h1 id="w">?</h1>
<script>
const mq760 = window.matchMedia('(max-width:760px)').matches;
document.getElementById('w').textContent =
  'iw=' + innerWidth + ' cw=' + document.documentElement.clientWidth +
  ' dpr=' + devicePixelRatio + ' vv=' + visualViewport.width +
  ' sw=' + screen.width + ' mq760=' + mq760;
</script>
</body></html>`);
        return;
      }

      /* ── static renderer ── */
      if (req.method === 'GET' || req.method === 'HEAD') {
        const served = await serveStatic(req, res, pathname);
        if (served) return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[http] request failed', message);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: { message } });
      } else {
        res.end();
      }
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/events' || url.searchParams.get('token') !== token) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    ws.send(JSON.stringify({ channel: 'mobile:hello', payload: { version: options.appVersion } }));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/`,
    close: async () => {
      picker.cancelAll();
      for (const client of clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
