/**
 * Host bridge — the tiny seam between the fake Electron APIs and the mobile
 * Node host. The host installs the real implementations at boot; shims fall
 * back to inert defaults so modules can be imported before boot completes.
 */

export interface OpenDialogOptionsLike {
  title?: string;
  defaultPath?: string;
  properties?: Array<
    | 'openFile'
    | 'openDirectory'
    | 'multiSelections'
    | 'createDirectory'
    | 'showHiddenFiles'
    | 'promptToCreate'
  >;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface PickerService {
  /** Show the mobile directory/file picker; resolves with the selection. */
  pick(options: OpenDialogOptionsLike): Promise<OpenDialogResult>;
}

export interface HostBridgeState {
  appVersion: string;
  broadcast(channel: string, payload: unknown): void;
  picker: PickerService;
  /** Toggle the renderer-side blocker overlay while a modal picker runs. */
  setAwaitingPicker(active: boolean): void;
}

const inertPicker: PickerService = {
  pick: async () => ({ canceled: true, filePaths: [] }),
};

export const hostBridge: HostBridgeState = {
  appVersion: '0.3.0-mobile.1',
  broadcast: () => {},
  picker: inertPicker,
  setAwaitingPicker: () => {},
};
