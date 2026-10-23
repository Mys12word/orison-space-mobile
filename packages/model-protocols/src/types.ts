import type { ModelProtocol } from '@orison/shared-contracts';

export type ProtocolCallContext = {
  signal?: AbortSignal;
  /**
   * Called with each incremental text chunk while a streaming request is in
   * flight, so the UI can show prose as it is written instead of staring at a
   * spinner until the whole chapter is finished.
   */
  onTextDelta?: (text: string) => void;
};

export type ListModelsRequest = {
  protocol?: ModelProtocol;
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
};
