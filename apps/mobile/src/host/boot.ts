/**
 * Boot shim: environment must be in place BEFORE the main-process modules are
 * imported, because a few of them resolve paths at module-evaluation time
 * (pathGuard derives the OrisonSpace root from `os.homedir()`).
 */
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(moduleDir, '../..');

function readVersion(): string {
  // Desktop/dev builds have the monorepo package.json two levels above the host
  // bundle; the APK stages package.json next to the extracted runtime instead.
  const candidates = [
    path.join(appRoot, 'package.json'),
    path.join(moduleDir, '..', 'package.json'),
  ];
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* try next */ }
  }
  return '0.3.0-mobile';
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const dataRoot = path.resolve(process.env.ORISON_MOBILE_DATA || path.join(appRoot, 'data'));
const homeDir = ensureDir(process.env.ORISON_MOBILE_HOME || path.join(dataRoot, 'home'));
const userDataDir = ensureDir(path.join(dataRoot, 'userdata'));

process.env.ORISON_MOBILE_DATA = dataRoot;
process.env.ORISON_MOBILE_HOME = homeDir;
process.env.ORISON_MOBILE_USERDATA = userDataDir;
// The logger and every config path resolve through os.homedir().
process.env.HOME = homeDir;
process.env.ELEKTRON_RENDERER_URL = '';
delete process.env.ELECTRON_RENDERER_URL;

const port = Number(process.env.ORISON_MOBILE_PORT || 3210);
const appVersion = process.env.ORISON_APP_VERSION || readVersion();
const rendererDir = path.resolve(process.env.ORISON_MOBILE_RENDERER || path.join(appRoot, 'dist/renderer'));
// The APK shell points this at the app's external files dir; keep the host's
// default project root and path-guard allow-list on the SAME directory.
const projectsRoot = path.resolve(
  process.env.ORISON_PROJECTS_ROOT || path.join(homeDir, 'Documents', 'OrisonSpace'),
);
process.env.ORISON_PROJECTS_ROOT = projectsRoot;
ensureDir(projectsRoot);

const { startApp } = await import('./app.js');

startApp({ dataRoot, homeDir, userDataDir, rendererDir, projectsRoot, port, appVersion }).catch((err) => {
  console.error('[orison-mobile] fatal startup error', err);
  process.exit(1);
});
