/**
 * Mobile directory/file picker.
 *
 * Android browsers cannot hand an absolute filesystem path to a web app, and a
 * headless Node host has no native dialog. Instead the picker round-trips
 * through the renderer: the host broadcasts `mobile:pick-request`, the mobile
 * UI renders a folder browser (backed by /api/mobile/list-dirs) and posts the
 * selection back to /api/mobile/pick-result, which resolves the pending
 * `dialog.showOpenDialog` promise in the Electron shim.
 */
import { randomUUID } from 'node:crypto';
import type { OpenDialogOptionsLike, OpenDialogResult } from '../shims/hostBridge';

export interface PickRequestEvent {
  id: string;
  kind: 'directory' | 'file';
  defaultPath: string;
  title?: string;
  extensions?: string[];
  multiple: boolean;
}

type Resolver = (result: OpenDialogResult) => void;

export class PickerService {
  private pending = new Map<string, Resolver>();

  constructor(
    private broadcast: (channel: string, payload: unknown) => void,
    private fallbackDir: string,
  ) {}

  pick(options: OpenDialogOptionsLike): Promise<OpenDialogResult> {
    const id = randomUUID();
    const properties = options.properties ?? [];
    const kind = properties.includes('openDirectory') ? 'directory' : 'file';
    const extensions = options.filters?.flatMap((f) => f.extensions) ?? undefined;
    const event: PickRequestEvent = {
      id,
      kind,
      defaultPath: options.defaultPath || this.fallbackDir,
      title: options.title,
      extensions,
      multiple: properties.includes('multiSelections'),
    };
    this.broadcast('mobile:pick-request', event);
    return new Promise<OpenDialogResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        resolve({ canceled: true, filePaths: [] });
      }, 10 * 60 * 1000);
      this.pending.set(id, (result) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        resolve(result);
      });
    });
  }

  /** Resolve a pending picker request; returns false when the id is unknown. */
  resolve(id: string, filePaths: string[] | null): boolean {
    const resolver = this.pending.get(id);
    if (!resolver) return false;
    resolver(filePaths && filePaths.length > 0
      ? { canceled: false, filePaths }
      : { canceled: true, filePaths: [] });
    return true;
  }

  cancelAll(): void {
    for (const resolve of this.pending.values()) resolve({ canceled: true, filePaths: [] });
    this.pending.clear();
  }
}
