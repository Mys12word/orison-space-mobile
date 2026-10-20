// Mobile renderer entry. Same App tree as the Electron build; the only
// difference is that window.orisonDesktop is bound to the local HTTP bridge
// instead of contextBridge + ipcRenderer, plus a host-level folder picker.
//
// `./bridgeBoot` MUST stay the first import: it installs window.orisonDesktop
// before any shared module (appStore → shared/api/*) is evaluated.
import './bridgeBoot';
import 'material-symbols/outlined.css';
import '@desktop-ui/shared/styles/global.css';
import './mobile.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@desktop-ui/app/App';
import { ErrorBoundary } from '@desktop-ui/shared/components/ErrorBoundary';
import { MobilePicker } from './MobilePicker';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
      <MobilePicker />
    </ErrorBoundary>
  </StrictMode>,
);

if ('serviceWorker' in navigator && location.protocol === 'http:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[mobile] service worker registration failed', err);
    });
  });
}
