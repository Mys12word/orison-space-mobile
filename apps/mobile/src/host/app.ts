/**
 * Mobile host entry: boots the exact same main-process service layer the
 * Electron desktop app uses (project/file IPC, model gateway, agent runtime,
 * SQLite repositories, git timeline, story-sync) and exposes it over the local
 * HTTP/WebSocket bridge implemented in httpServer.ts.
 */
import { registerProjectIpc } from '../../../desktop/client/shell/main/ipc/projectIpc';
import { registerWindowIpc } from '../../../desktop/client/shell/main/ipc/windowIpc';
import { registerConfigIpc, readUserPreferencesFromDisk } from '../../../desktop/client/shell/main/ipc/configIpc';
import { registerFieldSyncIpc } from '../../../desktop/client/shell/main/ipc/fieldSyncIpc';
import { registerModelProviderIpc } from '../../../desktop/client/shell/main/ipc/modelProviderIpc';
import { registerModelGatewayIpc } from '../../../desktop/client/shell/main/ipc/modelGatewayIpc';
import { registerStorySyncIpc } from '../../../desktop/client/shell/main/ipc/storySyncIpc';
import { registerTaskIpc } from '../../../desktop/client/shell/main/ipc/taskIpc';
import { registerAssetIpc } from '../../../desktop/client/shell/main/ipc/assetIpc';
import { registerLogIpc } from '../../../desktop/client/shell/main/ipc/logIpc';
import { registerUpdateIpc } from '../../../desktop/client/shell/main/ipc/updateIpc';
import { registerGitIpc } from '../../../desktop/client/shell/main/ipc/gitIpc';
import { registerAgentIpc } from '../../../desktop/client/shell/main/ipc/agentIpc';
import { closeDb, getDb } from '../../../desktop/client/shell/main/db';
import { installGlobalErrorHandlers, getLogger } from '../../../desktop/client/shell/main/logger';
import { BrowserWindow } from '../shims/electron';
import { startHostServer, type HostServer } from './httpServer';

export interface StartOptions {
  dataRoot: string;
  homeDir: string;
  userDataDir: string;
  rendererDir: string;
  projectsRoot: string;
  port: number;
  appVersion: string;
}

export async function startApp(options: StartOptions): Promise<HostServer> {
  installGlobalErrorHandlers();
  const logger = getLogger();
  logger.info(
    { platform: process.platform, version: options.appVersion, dataRoot: options.dataRoot },
    'mobile host starting',
  );

  // Same ordering guarantee as the desktop main process: migrate/open the DB
  // before any IPC handler or window can touch it.
  getDb();

  const getMainWindow = (): BrowserWindow | null => BrowserWindow.getAllWindows()[0] ?? null;

  registerProjectIpc();
  registerWindowIpc(getMainWindow);
  registerConfigIpc();
  registerModelProviderIpc();
  registerModelGatewayIpc();
  registerStorySyncIpc();
  registerFieldSyncIpc();
  registerTaskIpc();
  registerAssetIpc();
  registerLogIpc();
  registerUpdateIpc(getMainWindow);
  registerGitIpc();
  registerAgentIpc(getMainWindow);

  // A window is required by modules that push events through BrowserWindow.
  new BrowserWindow();

  const server = await startHostServer({
    dataRoot: options.dataRoot,
    projectsRoot: options.projectsRoot,
    port: options.port,
    appVersion: options.appVersion,
    rendererDir: options.rendererDir,
  });

  logger.info({ url: server.url }, 'mobile host ready');
  console.log(`\n  Orison Space 手机版已启动\n  → ${server.url}\n  数据目录: ${options.dataRoot}\n  作品目录: ${options.projectsRoot}\n`);

  // Surface startup preference read so a corrupted preferences file fails loudly
  // at boot instead of on the first renderer call (same as desktop).
  try {
    readUserPreferencesFromDisk();
  } catch (err) {
    logger.warn({ err }, 'failed to read user preferences at boot');
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'mobile host shutting down');
    try {
      await server.close();
      closeDb();
    } catch (err) {
      logger.warn({ err }, 'shutdown error');
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  return server;
}
