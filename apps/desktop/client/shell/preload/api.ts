// Shared renderer API surface — the single source of truth for
// window.orisonDesktop. Derived from the upstream Electron preload
// (apps/desktop/client/shell/preload/index.ts) and bound to two adapters:
//
//   • Electron:  preload/index.ts       (contextBridge + ipcRenderer)
//   • Mobile:    apps/mobile/renderer/bridge.ts (HTTP RPC + WebSocket events)
//
// When adding a channel upstream, add the method here too (and to the desktop
// preload, which now delegates to this factory).
import type {
  AssetRecord,
  AssetUpsertInput,
  GenerateImagePayload,
  GenerateTextPayload,
  GitCommitEntry,
  GitFileDiff,
  ImportedFont,
  ImageGenerationResponse,
  ListRemoteModelsRequest,
  ModelConfig,
  OrisonDesktopApi,
  ProjectLifecycleResult,
  ProjectSearchResult,
  RegisteredProject,
  RemoteModel,
  RunStorySyncPayload,
  RunStorySyncResult,
  SaveBase64ImageInput,
  TaskRecord,
  TaskUpsertInput,
  TextGenerationResponse,
  UpdateCheckResult,
  UpdateEvent,
  UserPreferencesConfig,
} from '@orison/shared-contracts';

export interface DesktopIpcAdapter {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  /** Subscribe to a main -> renderer event; returns the unsubscribe function. */
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

export interface DesktopEnv {
  platform: NodeJS.Platform;
  getLocale(): string;
  /** Absolute path for a dropped file, or '' when the host cannot resolve one. */
  pathForFile(file: File): string;
}

/** The shared implementation; hosts pass their own IPC adapter. */
export function createDesktopApi(ipc: DesktopIpcAdapter, env: DesktopEnv): OrisonDesktopApi {
  return buildApi(ipc, env);
}


function buildApi(ipc: DesktopIpcAdapter, env: DesktopEnv): OrisonDesktopApi {
  return {
  pickProjectDirectory: () => ipc.invoke('project:pick-directory'),
  createProjectDirectory: (parentDir: string, name: string) =>
    ipc.invoke('project:create-directory', parentDir, name) as Promise<string>,
  pickCoverImage: () => ipc.invoke('project:pick-cover-image') as Promise<string | null>,
  copyCoverImage: (src: string, projectDir: string) =>
    ipc.invoke('project:copy-cover-image', src, projectDir) as Promise<string>,
  importDocx: (projectDir: string) =>
    ipc.invoke('project:import-docx', projectDir) as Promise<string | null>,
  docxToHtml: (fullPath: string) =>
    ipc.invoke('project:docx-to-html', fullPath) as Promise<string | null>,
  docxToMarkdown: (fullPath: string, projectDir: string) =>
    ipc.invoke('project:docx-to-markdown', fullPath, projectDir) as Promise<string | null>,
  saveProjectMeta: (projectDir: string, meta: Record<string, unknown>) =>
    ipc.invoke('project:save-meta', projectDir, meta) as Promise<void>,
  ensureProjectDocument: (projectDir: string, meta: Record<string, unknown>) =>
    ipc.invoke('project:ensure-document', projectDir, meta) as Promise<void>,
  syncProjectMeta: (projectDir: string, meta: Record<string, unknown>) =>
    ipc.invoke('project:sync-meta', projectDir, meta),
  syncChaptersMeta: (projectDir: string, chapters: Array<{
    id: string;
    title: string;
    sort_order: number;
    status: string;
    summary?: string;
    summary_source?: string;
    sections?: Array<{
      id: string;
      title?: string;
      sort_order: number;
      content_file: string;
      word_count?: number;
    }>;
  }>) =>
    ipc.invoke('project:sync-chapters-meta', projectDir, chapters),
  loadProjectMeta: (projectDir: string) =>
    ipc.invoke('project:load-meta', projectDir) as Promise<Record<string, unknown> | null>,
  getLocale: () => env.getLocale(),
  // 窗口控制
  minimize: () => ipc.send('window:minimize'),
  maximize: () => ipc.send('window:maximize'),
  close: () => ipc.send('window:close'),
  isMaximized: () => ipc.invoke('window:is-maximized') as Promise<boolean>,
  platform: env.platform,
  // 字段同步
  syncField: (projectPath: string, field: string, data: unknown) =>
    ipc.invoke('field:sync', projectPath, field, data) as Promise<void>,
  applyAgentFieldPatch: (projectPath: string, fieldPatch: unknown) =>
    ipc.invoke('field:apply-agent-patch', projectPath, fieldPatch) as Promise<unknown>,
  loadProjectDocument: (projectDir: string) =>
    ipc.invoke('project:load-document', projectDir) as Promise<Record<string, unknown> | null>,
  // 模型配置
  loadModelConfig: () => ipc.invoke('config:load-model') as Promise<ModelConfig>,
  saveModelConfig: (config: ModelConfig) => ipc.invoke('config:save-model', config) as Promise<void>,
  isKeyEncryptionAvailable: () => ipc.invoke('config:is-key-encryption-available') as Promise<boolean>,
  listRemoteModels: (request: ListRemoteModelsRequest) =>
    ipc.invoke('model:list-remote-models', request) as Promise<RemoteModel[]>,
  // 模型生成（desktop main 直连 provider）
  generateText: (payload: GenerateTextPayload) =>
    ipc.invoke('model:generate-text', payload) as Promise<TextGenerationResponse>,
  generateImage: (payload: GenerateImagePayload) =>
    ipc.invoke('model:generate-image', payload) as Promise<ImageGenerationResponse>,
  // Story-sync 桥（renderer -> desktop main 调 LLM 提补丁）
  runStorySync: (payload: RunStorySyncPayload) =>
    ipc.invoke('storySync:run', payload) as Promise<RunStorySyncResult>,
  loadUserPreferences: () =>
    ipc.invoke('config:load-user-preferences') as Promise<UserPreferencesConfig>,
  saveUserPreferences: (config: UserPreferencesConfig) =>
    ipc.invoke('config:save-user-preferences', config) as Promise<void>,
  listImportedFonts: () =>
    ipc.invoke('config:list-imported-fonts') as Promise<ImportedFont[]>,
  importFonts: () => ipc.invoke('config:import-fonts') as Promise<ImportedFont[]>,
  showItemInFolder: (fullPath: string) => ipc.send('shell:show-item-in-folder', fullPath),
  openPath: (fullPath: string) => ipc.send('shell:open-path', fullPath),
  openExternal: (url: string) => ipc.send('shell:open-external', url),
  // 文件树操作
  readDirectory: (projectDir: string, maxDepth?: number) =>
    ipc.invoke('project:read-directory', projectDir, maxDepth),
  deleteEntry: (fullPath: string) =>
    ipc.invoke('project:delete-entry', fullPath) as Promise<boolean>,
  renameEntry: (oldPath: string, newPath: string) =>
    ipc.invoke('project:rename-entry', oldPath, newPath) as Promise<boolean>,
  createEntry: (fullPath: string, isDir: boolean) =>
    ipc.invoke('project:create-entry', fullPath, isDir) as Promise<boolean>,
  readFile: (fullPath: string) =>
    ipc.invoke('project:read-file', fullPath) as Promise<string | null>,
  searchProject: (projectDir: string, query: string, maxResults?: number) =>
    ipc.invoke('project:search', projectDir, query, maxResults) as Promise<ProjectSearchResult[]>,
  readFileBinary: (fullPath: string) =>
    ipc.invoke('project:read-file-binary', fullPath) as Promise<{ base64: string; mimeType: string } | null>,
  writeFile: (fullPath: string, content: string) =>
    ipc.invoke('project:write-file', fullPath, content) as Promise<boolean>,
  wordCount: (projectDir: string) =>
    ipc.invoke('project:word-count', projectDir) as Promise<number>,
  pathExists: (fullPath: string) =>
    ipc.invoke('project:path-exists', fullPath) as Promise<boolean>,
  saveBase64Image: (projectDir: string, input: SaveBase64ImageInput) =>
    ipc.invoke('project:save-base64-image', projectDir, input),
  moveProjectFile: (projectDir: string, fromRelativePath: string, toRelativePath: string) =>
    ipc.invoke('project:move-file', projectDir, fromRelativePath, toRelativePath) as Promise<string>,
  deleteProjectFile: (projectDir: string, relativePath: string) =>
    ipc.invoke('project:delete-file', projectDir, relativePath) as Promise<boolean>,
  // Drag-drop import of external OS files into the project tree
  importFiles: (projectDir: string, targetRelDir: string, sourcePaths: string[]) =>
    ipc.invoke('project:import-files', projectDir, targetRelDir, sourcePaths) as Promise<string[]>,
  // Resolve the absolute path of a dropped File (Electron 32+ removed File.path)
  pathForFile: (file: File) => env.pathForFile(file),
  // Filesystem watcher for external-change auto-refresh
  watchProject: (projectDir: string) =>
    ipc.invoke('project:watch', projectDir) as Promise<void>,
  unwatchProject: () => ipc.invoke('project:unwatch') as Promise<void>,
  ensureProjectRegistration: (input: { projectId?: string; name: string; type: 'novel' | 'script'; localFingerprint: string; path?: string; coverImage?: string }) =>
    ipc.invoke('project:ensure-registration', input) as Promise<{ projectId: string; name: string; type: string }>,
  listRegisteredProjects: () =>
    ipc.invoke('project:list-registered') as Promise<RegisteredProject[]>,
  touchProjectRegistration: (input: { localFingerprint: string; coverImage?: string }) =>
    ipc.invoke('project:touch-registration', input) as Promise<void>,
  duplicateProject: (projectPath: string, name: string) =>
    ipc.invoke('project:duplicate', projectPath, name) as Promise<ProjectLifecycleResult>,
  renameProject: (projectPath: string, name: string) =>
    ipc.invoke('project:rename', projectPath, name) as Promise<ProjectLifecycleResult>,
  deleteProject: (projectPath: string) =>
    ipc.invoke('project:delete', projectPath) as Promise<ProjectLifecycleResult>,
  // Task persistence (SQLite)
  listTasks: (projectId: string, limit?: number) =>
    ipc.invoke('task:list', projectId, limit) as Promise<TaskRecord[]>,
  upsertTask: (input: TaskUpsertInput) =>
    ipc.invoke('task:upsert', input) as Promise<void>,
  updateTaskStatus: (taskId: string, status: string, errorMessage?: string) =>
    ipc.invoke('task:update-status', taskId, status, errorMessage) as Promise<void>,
  deleteTask: (taskId: string) =>
    ipc.invoke('task:delete', taskId) as Promise<void>,
  // Asset persistence (SQLite)
  listAssets: (projectId: string) =>
    ipc.invoke('asset:list', projectId) as Promise<AssetRecord[]>,
  upsertAsset: (input: AssetUpsertInput) =>
    ipc.invoke('asset:upsert', input) as Promise<void>,
  updateAsset: (projectId: string, assetId: string, fields: Partial<Pick<AssetRecord, 'assetName' | 'assetGroup' | 'summary' | 'assetStatus'>>) =>
    ipc.invoke('asset:update', projectId, assetId, fields) as Promise<void>,
  deleteAsset: (projectId: string, assetId: string) =>
    ipc.invoke('asset:delete', projectId, assetId) as Promise<void>,
  importAssets: (projectDir: string, projectId: string) =>
    ipc.invoke('asset:import-files', projectDir, projectId) as Promise<string[]>,
  // Logging
  openLogsDir: () => ipc.invoke('log:open-dir') as Promise<string>,
  writeLog: (payload: { level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'; message: string; meta?: Record<string, unknown> }) =>
    ipc.invoke('log:write', payload) as Promise<void>,
  getAppVersion: () => ipc.invoke('app:get-version') as Promise<string>,
  checkForUpdate: () => ipc.invoke('update:check') as Promise<UpdateCheckResult>,
  downloadUpdate: () => ipc.invoke('update:download') as Promise<void>,
  installUpdate: () => ipc.invoke('update:install') as Promise<void>,
  onUpdateEvent: (callback: (event: UpdateEvent) => void) => {
    return ipc.on('update:event', (payload) => callback(payload as UpdateEvent));
  },
  gitIsRepo: (dir: string) => ipc.invoke('git:is-repo', dir) as Promise<boolean>,
  gitInit: (dir: string) => ipc.invoke('git:init', dir) as Promise<{ initialized: boolean }>,
  gitLog: (dir: string, depth?: number) => ipc.invoke('git:log', dir, depth) as Promise<GitCommitEntry[]>,
  gitCommitDiff: (dir: string, oid: string) => ipc.invoke('git:commit-diff', dir, oid) as Promise<GitFileDiff[]>,
  gitFileAtCommit: (dir: string, oid: string, filepath: string) => ipc.invoke('git:file-at-commit', dir, oid, filepath) as Promise<string | null>,
  gitCreateNode: (dir: string, message: string, tag?: string) => ipc.invoke('git:create-node', dir, message, tag) as Promise<{ oid: string }>,
  gitListBranches: (dir: string) => ipc.invoke('git:list-branches', dir) as Promise<string[]>,
  gitCurrentBranch: (dir: string) => ipc.invoke('git:current-branch', dir) as Promise<string>,
  gitCreateBranch: (dir: string, name: string, fromOid?: string) => ipc.invoke('git:create-branch', dir, name, fromOid) as Promise<void>,
  gitCheckoutBranch: (dir: string, name: string) => ipc.invoke('git:checkout-branch', dir, name) as Promise<void>,
  gitRestoreVersion: (dir: string, oid: string, message: string) => ipc.invoke('git:restore-version', dir, oid, message) as Promise<{ oid: string }>,
  gitStatusCount: (dir: string) => ipc.invoke('git:status-count', dir) as Promise<number>,
  // Tool event notifications (pushed from Shell when Agent executes tools)
  onToolEvent: (callback: (data: { type: string; [key: string]: unknown }) => void) => {
    return ipc.on('tool:event', (payload) => callback(payload as { type: string; [key: string]: unknown }));
  },
  // Agent
  createAgentSession: (input: { agentName: string; projectPath: string; mode?: 'readonly' | 'suggest' | 'auto'; modelRef?: { keyId: string; modelId: string } }) =>
    ipc.invoke('agent:create-session', input),
  getAgentSession: (id: string, projectPath?: string) =>
    ipc.invoke('agent:get-session', id, projectPath),
  setAgentSessionModel: (sessionId: string, projectPath: string | undefined, modelRef: { keyId: string; modelId: string } | undefined) =>
    ipc.invoke('agent:set-session-model', sessionId, projectPath, modelRef),
  setAgentSessionMode: (sessionId: string, projectPath: string | undefined, mode: 'readonly' | 'suggest' | 'auto') =>
    ipc.invoke('agent:set-session-mode', sessionId, projectPath, mode),
  listAgentSessions: (projectPath?: string) =>
    ipc.invoke('agent:list-sessions', projectPath),
  deleteAgentSession: (id: string, projectPath?: string) =>
    ipc.invoke('agent:delete-session', id, projectPath),
  streamAgentMessage: (input: { sessionId: string; content: string; attachments?: unknown[] }) =>
    ipc.invoke('agent:stream-message', input),
  onAgentStreamEvent: (callback: (event: { type: string; data: unknown }) => void) => {
    return ipc.on('agent:stream-event', (payload) => callback(payload as { type: string; data: unknown }));
  },
  resolveAgentConfirmation: (sessionId: string, callId: string, approved: boolean) =>
    ipc.invoke('agent:resolve-confirmation', sessionId, callId, approved),
  listAgentSkills: (projectPath: string) =>
    ipc.invoke('agent:list-skills', projectPath),
  executeAgentSkill: (sessionId: string, skillName: string, request?: unknown) =>
    ipc.invoke('agent:execute-skill', sessionId, skillName, request),
  listAgentContinuations: (sessionId: string) =>
    ipc.invoke('agent:list-continuations', sessionId),
  restoreAgentContinuation: (sessionId: string, continuationId: string) =>
    ipc.invoke('agent:restore-continuation', sessionId, continuationId),
  abortAgentRun: (sessionId: string) =>
    ipc.invoke('agent:abort-run', sessionId),
  retractAgentTurn: (sessionId: string) =>
    ipc.invoke('agent:retract-last-turn', sessionId) as Promise<{ text: string } | null>,
  // Skill package management
  listSkillPackages: (projectPath?: string) =>
    ipc.invoke('agent:list-skill-packages', projectPath),
  setPackageEnabled: (packageName: string, enabled: boolean) =>
    ipc.invoke('agent:set-package-enabled', packageName, enabled),
  setSkillEnabled: (packageName: string, skillName: string, enabled: boolean) =>
    ipc.invoke('agent:set-skill-enabled', packageName, skillName, enabled),
  // Window lifecycle
  onBeforeClose: (callback: () => void) => {
    return ipc.on('app:before-close', () => callback());
  },
  confirmClose: () => ipc.send('app:close-confirmed'),
  } satisfies OrisonDesktopApi;
}
