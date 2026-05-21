import { useEffect, useState } from "react";
import { type ContainerStatus, ipc, onLifecycle, onLifecycleError } from "../lib/ipc";

export interface StatusState {
  status: ContainerStatus | null;
  error: string | null;
}

// Initial fetch + live subscription to lifecycle events. In a plain browser
// (no Tauri) invoke rejects; we surface that as `unreachable` rather than throw.
export function useContainerStatus(): StatusState {
  const [status, setStatus] = useState<ContainerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const unlisteners: (() => void)[] = [];

    // listen() resolves its UnlistenFn asynchronously. If the effect is cleaned
    // up first (guaranteed under StrictMode's mount→unmount→remount), unlisten
    // immediately instead of parking the fn in an array no one reads again —
    // otherwise the Tauri subscription leaks.
    const track = (p: Promise<() => void>) => p.then((u) => (alive ? unlisteners.push(u) : u()));

    ipc
      .containerStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setError("unreachable"));

    track(onLifecycle((s) => alive && setStatus(s)));
    track(onLifecycleError((msg) => alive && setError(msg)));

    return () => {
      alive = false;
      for (const u of unlisteners) u();
    };
  }, []);

  return { status, error };
}
