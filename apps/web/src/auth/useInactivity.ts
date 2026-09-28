import { useCallback, useEffect, useRef, useState } from "react";

const WARN_BEFORE_SECONDS = 60;
const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "scroll", "touchstart", "mousemove"];

/**
 * Inactivity timer driven by the server's `inactivityTimeoutSeconds`. Warns 60 s before
 * expiry and calls `onExpire` when it lapses. Activity is sampled at most once per 2 s.
 */
export function useInactivity(timeoutSeconds: number | null | undefined, onExpire: () => void) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const lastActivity = useRef(Date.now());
  const expired = useRef(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  const extend = useCallback(() => {
    lastActivity.current = Date.now();
    setSecondsLeft(null);
  }, []);

  useEffect(() => {
    if (!timeoutSeconds || timeoutSeconds <= 0) return;
    expired.current = false;
    let lastSample = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastSample < 2000) return;
      lastSample = now;
      // While the warning is showing, only an explicit "stay signed in" extends the session.
      if (now - lastActivity.current < (timeoutSeconds - WARN_BEFORE_SECONDS) * 1000) lastActivity.current = now;
    };
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true });
    const tick = window.setInterval(() => {
      const idle = (Date.now() - lastActivity.current) / 1000;
      const left = Math.round(timeoutSeconds - idle);
      if (left <= 0) {
        if (!expired.current) { expired.current = true; onExpireRef.current(); }
        return;
      }
      setSecondsLeft(left <= WARN_BEFORE_SECONDS ? left : null);
    }, 1000);
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
      window.clearInterval(tick);
    };
  }, [timeoutSeconds]);

  return { warning: secondsLeft !== null, secondsLeft, extend };
}
