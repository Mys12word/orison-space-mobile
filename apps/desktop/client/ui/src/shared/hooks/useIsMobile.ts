import { useEffect, useState } from 'react';

const QUERY = '(max-width: 760px)';

function match(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
}

/**
 * True on phone-sized viewports (or when the browser cannot match media — then
 * assume desktop, matching the Electron build). Subscribes to orientation and
 * window resizes so a tablet rotating into portrait picks up the mobile shell.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(match);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(QUERY);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
