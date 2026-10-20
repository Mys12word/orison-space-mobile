/**
 * Side-effect bootstrap imported FIRST by main.tsx.
 *
 * Several shared modules capture `window.orisonDesktop` at module-evaluation
 * time (shared/api/agent.ts, assets.ts, filesystem.ts, git.ts,
 * agentSettingsSlice.ts). Electron guarantees the preload runs before the
 * renderer graph, but in the mobile WebView the bridge must be installed before
 * any of those modules evaluate — importing this file first pins that order.
 */
import { installBridge } from './bridge';

installBridge();
