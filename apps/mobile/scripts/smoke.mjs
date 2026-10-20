#!/usr/bin/env node
/**
 * End-to-end smoke test for the mobile host: exercises the same IPC channels
 * the renderer calls, through the HTTP RPC bridge.
 *
 *   node scripts/smoke.mjs [http://127.0.0.1:3210/]
 */
const base = process.argv[2] || 'http://127.0.0.1:3210/';
const origin = new URL(base).origin;

const html = await (await fetch(`${origin}/`)).text();
const tokenMatch = html.match(/__ORISON_TOKEN__="([a-f0-9]+)"/);
if (!tokenMatch) throw new Error('could not read host token from index.html');
const token = tokenMatch[1];

async function rpc(channel, args = [], kind = 'invoke') {
  const response = await fetch(`${origin}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orison-token': token },
    body: JSON.stringify({ channel, args, kind }),
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`${channel}: ${body.error?.message ?? 'failed'}`);
  return body.value;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const version = await rpc('app:get-version');
check('app:get-version', typeof version === 'string' && version.length > 0, version);

const prefs = await rpc('config:load-user-preferences');
check('config:load-user-preferences', !!prefs && typeof prefs === 'object', JSON.stringify(prefs).slice(0, 60));

const projectName = `手机版测试-${Date.now().toString(36)}`;
const projectDir = await rpc('project:create-directory', ['', projectName]);
check('project:create-directory', typeof projectDir === 'string' && projectDir.endsWith(projectName), projectDir);

const registration = await rpc('project:ensure-registration', [{
  name: projectName,
  type: 'novel',
  localFingerprint: projectDir,
  path: projectDir,
}]);
check('project:ensure-registration', !!registration?.projectId, registration?.projectId);

await rpc('project:save-meta', [projectDir, {
  name: projectName,
  type: 'novel',
  projectId: registration.projectId,
  logline: '一个用于验证手机版链路的测试项目',
  genre: '测试',
}]);
const meta = await rpc('project:load-meta', [projectDir]);
check('project:load-meta', meta?.name === projectName, JSON.stringify(meta).slice(0, 80));

const document = await rpc('project:load-document', [projectDir]);
check('project:load-document', !!document?.meta, Object.keys(document ?? {}).join(','));

const chapterPath = `${projectDir}/chapters/001.md`;
await rpc('project:write-file', [chapterPath, '# 第一章 测试\n\n手机版写入验证。\n']);
const chapter = await rpc('project:read-file', [chapterPath]);
check('project:write-file/read-file', chapter.includes('手机版写入验证'), chapter.slice(0, 40));

const tree = await rpc('project:read-directory', [projectDir, 3]);
check('project:read-directory', Array.isArray(tree), `${Array.isArray(tree) ? tree.length : 'n/a'} entries`);

const words = await rpc('project:word-count', [projectDir]);
check('project:word-count', typeof words === 'number' && words > 0, String(words));

const registrationList = await rpc('project:list-registered');
check('project:list-registered', registrationList.some((p) => p.path === projectDir), `${registrationList.length} projects`);

const isRepo = await rpc('git:is-repo', [projectDir]);
check('git:is-repo', typeof isRepo === 'boolean', String(isRepo));
if (!isRepo) {
  await rpc('git:init', [projectDir]);
}
const nodeCommit = await rpc('git:create-node', [projectDir, '手机版初始节点']);
const log = await rpc('git:log', [projectDir, 5]);
check('git:create-node/log', Array.isArray(log) && log.length > 0 && !!nodeCommit?.oid, `${log.length} commits`);
const status = await rpc('git:status-count', [projectDir]);
check('git:status-count', typeof status === 'number', String(status));

// 未初始化 git 的项目点「保存版本」应当自动建仓，而不是报 Could not find git root
const snapName = `快照测试-${Date.now().toString(36)}`;
const snapDir = await rpc('project:create-directory', ['', snapName]);
await rpc('project:save-meta', [snapDir, { name: snapName, type: 'novel', projectId: 'snapshot-test' }]);
const snapCommit = await rpc('git:create-node', [snapDir, 'snapshot: 首次保存']);
const snapRepo = await rpc('git:is-repo', [snapDir]);
check('git:create-node auto-init (无仓库直接快照)', !!snapCommit?.oid && snapRepo === true, `oid=${snapCommit?.oid?.slice(0, 7)} isRepo=${snapRepo}`);

// Event bus: the renderer subscribes to tool:event / agent:stream-event. Assert
// the websocket handshake + hello frame works.
const events = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://${origin.replace('http://', '')}/events?token=${token}`);
  const timer = setTimeout(() => resolve({ ok: false, detail: 'timeout' }), 5000);
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.channel === 'mobile:hello') {
      clearTimeout(timer);
      ws.close();
      resolve({ ok: true, detail: JSON.stringify(message.payload) });
    }
  });
  ws.addEventListener('error', () => {
    clearTimeout(timer);
    resolve({ ok: false, detail: 'socket error' });
  });
});
check('websocket /events', events.ok, events.detail);

// Project file protocol replacement: /orison-file/<abs path>
const fileResponse = await fetch(`${origin}/orison-file/${encodeURIComponent(chapterPath)}`);
check('orison-file route', fileResponse.ok, `HTTP ${fileResponse.status}`);


// ── Folder picker round-trip (mimics the mobile overlay) ──
async function withEvents(fn) {
  const ws = new WebSocket(`ws://${origin.replace('http://', '')}/events?token=${token}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    inbox.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const waitFor = (match, timeout = 5000) => new Promise((resolve, reject) => {
    const found = inbox.find(match);
    if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error('event timeout')), timeout);
    waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
  try {
    return await fn({ waitFor });
  } finally {
    ws.close();
  }
}

const pickResult = await withEvents(async ({ waitFor }) => {
  const pending = rpc('project:pick-directory', []);
  const request = await waitFor((m) => m.channel === 'mobile:pick-request');
  const payload = request.payload;
  if (!payload?.id) throw new Error('pick request missing id');
  const response = await fetch(`${origin}/api/mobile/pick-result?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: payload.id, paths: [payload.defaultPath] }),
  });
  if (!response.ok) throw new Error('pick-result failed');
  return pending;
});
check('picker round-trip (project:pick-directory)', typeof pickResult === 'string' && pickResult.length > 0, pickResult);

const cancelResult = await withEvents(async ({ waitFor }) => {
  const pending = rpc('project:pick-cover-image', []);
  const request = await waitFor((m) => m.channel === 'mobile:pick-request');
  await fetch(`${origin}/api/mobile/pick-result?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: request.payload.id, paths: null }),
  });
  return pending;
});
check('picker cancel path', cancelResult === null, String(cancelResult));

// Icon asset served by the host (PWA installability)
const icon = await fetch(`${origin}/icons/icon-192.png`);
check('PWA icon', icon.ok && icon.headers.get('content-type') === 'image/png', `HTTP ${icon.status}`);
const manifest = await (await fetch(`${origin}/manifest.webmanifest`)).json();
check('PWA manifest', manifest.display === 'standalone' && Array.isArray(manifest.icons), `${manifest.icons?.length} icons`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
