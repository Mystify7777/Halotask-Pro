import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The one rule for the Task Tapper while the server is unavailable: it opens ONLY because the person pressed
 * "Play while you wait", and closing it puts focus back on that button (the dialog's unmount would drop it on <body>).
 * Nothing about the server's state, a timer or a request may call `play`: waiting is never a reason to show the game.
 *
 * Used by the waiting room (an unverified session) and by the status line of the working app (a trusted session).
 * The caller renders the button (`ref={playRef}`, `onClick={play}`) and, while `playing`, the existing overlay with
 * `onExited={close}` and `onDismiss={close}`.
 */
export function usePlayWhileYouWait() {
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<HTMLButtonElement>(null);
  const wasPlaying = useRef(false);

  useEffect(() => {
    if (wasPlaying.current && !playing) playRef.current?.focus();
    wasPlaying.current = playing;
  }, [playing]);

  const play = useCallback(() => setPlaying(true), []);
  const close = useCallback(() => setPlaying(false), []);
  return { playing, play, close, playRef };
}
