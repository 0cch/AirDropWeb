import { useEffect } from 'react';

export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;

    const request = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        if (!('wakeLock' in navigator)) return;
        sentinel = await navigator.wakeLock.request('screen');
        if (disposed) await sentinel?.release();
      } catch {
        // Wake Lock is an enhancement; unsupported or blocked requests are ignored.
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void request();
    };

    void request();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      void sentinel?.release();
    };
  }, [active]);
}
