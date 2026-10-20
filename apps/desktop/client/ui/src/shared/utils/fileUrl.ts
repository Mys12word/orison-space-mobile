/**
 * Absolute local path → URL the host can serve.
 *
 * Desktop (Electron): custom `orison-file://` protocol registered in main.
 * Mobile / APK: the host exposes the same files over HTTP at /orison-file/<path>,
 * because browsers cannot register custom schemes.
 */
export function fileUrl(absPath: string): string {
  if (!absPath) return '';
  if (typeof window !== 'undefined' && (window as { __ORISON_MOBILE__?: boolean }).__ORISON_MOBILE__) {
    return `/orison-file/${encodeURIComponent(absPath)}`;
  }
  return `orison-file:///${absPath}`;
}
