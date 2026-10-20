import { useCallback, useEffect, useMemo, useState } from 'react';
import { onHostEvent } from './bridge';

/**
 * Folder/file picker for the mobile host.
 *
 * The Android host cannot open a native dialog, so `dialog.showOpenDialog` is
 * served by this overlay: it browses directories through /api/mobile/list-dirs
 * and posts the choice back through /api/mobile/pick-result, which resolves the
 * pending Electron-shim promise.
 */

interface PickRequest {
  id: string;
  kind: 'directory' | 'file';
  defaultPath: string;
  title?: string;
  extensions?: string[];
  multiple: boolean;
}

interface DirEntry {
  name: string;
  path: string;
}

interface ListResult {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
  files: DirEntry[];
}

const TOKEN = window.__ORISON_TOKEN__ ?? '';

async function post<T>(pathname: string, body: unknown): Promise<T> {
  const response = await fetch(`${pathname}?token=${encodeURIComponent(TOKEN)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { ok: boolean; value?: T; error?: { message?: string } };
  if (!payload.ok) throw new Error(payload.error?.message ?? '请求失败');
  return payload.value as T;
}

function shortenPath(target: string): string {
  const home = '/storage/emulated/0';
  if (target.startsWith(home)) return target.replace(home, '手机存储');
  return target;
}

export function MobilePicker() {
  const [request, setRequest] = useState<PickRequest | null>(null);
  const [list, setList] = useState<ListResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (target: string, req: PickRequest) => {
    setBusy(true);
    setError(null);
    try {
      const result = await post<ListResult>('/api/mobile/list-dirs', {
        path: target,
        kind: req.kind,
        extensions: req.extensions,
      });
      setList(result);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => onHostEvent('mobile:pick-request', (payload) => {
    const req = payload as PickRequest;
    setRequest(req);
    void load(req.defaultPath, req);
  }), [load]);

  const finish = useCallback(async (paths: string[] | null) => {
    if (!request) return;
    setBusy(true);
    try {
      await post('/api/mobile/pick-result', { id: request.id, paths });
    } finally {
      setRequest(null);
      setList(null);
      setSelected(new Set());
      setBusy(false);
    }
  }, [request]);

  const toggleFile = (path: string) => {
    if (!request?.multiple) {
      setSelected(new Set([path]));
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const currentPath = list?.path ?? request?.defaultPath ?? '';
  const canConfirmDir = request?.kind === 'directory' && !!list;
  const canConfirmFiles = request?.kind === 'file' && selected.size > 0;

  const selectedLabel = useMemo(() => (selected.size > 0 ? `已选 ${selected.size} 个文件` : ''), [selected]);

  if (!request) return null;

  return (
    <div className="mobile-picker" role="dialog" aria-modal="true" aria-label={request.title ?? '选择位置'}>
      <div className="mobile-picker-sheet">
        <header className="mobile-picker-head">
          <button type="button" className="mobile-picker-close" onClick={() => void finish(null)} aria-label="取消">
            <span className="material-symbols-outlined">close</span>
          </button>
          <div className="mobile-picker-title">{request.title ?? (request.kind === 'directory' ? '选择文件夹' : '选择文件')}</div>
          <div className="mobile-picker-spacer" />
        </header>

        <div className="mobile-picker-path" title={currentPath}>{shortenPath(currentPath)}</div>

        {error && <div className="mobile-picker-error">{error}</div>}

        <div className="mobile-picker-list">
          {list?.parent && (
            <button
              type="button"
              className="mobile-picker-row"
              onClick={() => list.parent && void load(list.parent, request)}
            >
              <span className="material-symbols-outlined">arrow_upward</span>
              <span className="mobile-picker-row-label">上一级</span>
            </button>
          )}
          {list?.dirs.map((dir) => (
            <button
              key={dir.path}
              type="button"
              className="mobile-picker-row"
              onClick={() => void load(dir.path, request)}
            >
              <span className="material-symbols-outlined">folder</span>
              <span className="mobile-picker-row-label">{dir.name}</span>
              <span className="material-symbols-outlined mobile-picker-chevron">chevron_right</span>
            </button>
          ))}
          {list?.files.map((file) => (
            <button
              key={file.path}
              type="button"
              className={`mobile-picker-row${selected.has(file.path) ? ' is-selected' : ''}`}
              onClick={() => toggleFile(file.path)}
            >
              <span className="material-symbols-outlined">
                {selected.has(file.path) ? 'check_circle' : 'draft'}
              </span>
              <span className="mobile-picker-row-label">{file.name}</span>
            </button>
          ))}
          {list && list.dirs.length === 0 && list.files.length === 0 && (
            <div className="mobile-picker-empty">这里没有可选内容</div>
          )}
          {busy && <div className="mobile-picker-loading">载入中…</div>}
        </div>

        <footer className="mobile-picker-foot">
          <button
            type="button"
            className="mobile-picker-secondary"
            onClick={() => {
              if (!list) return;
              const name = window.prompt('新建文件夹名称');
              if (!name) return;
              void post<{ path: string }>('/api/mobile/mkdir', { parent: list.path, name })
                .then((created) => load(created.path, request))
                .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
            }}
          >
            新建文件夹
          </button>
          <button
            type="button"
            className="mobile-picker-primary"
            disabled={!canConfirmDir && !canConfirmFiles}
            onClick={() => {
              if (canConfirmDir) void finish([currentPath]);
              else if (canConfirmFiles) void finish([...selected]);
            }}
          >
            {request.kind === 'directory' ? '选择此文件夹' : selectedLabel || '选择文件'}
          </button>
        </footer>
      </div>
    </div>
  );
}
