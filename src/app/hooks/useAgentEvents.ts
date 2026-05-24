import { useEffect } from "react";
import { onAgentEvent } from "../lib/ipc";
import { useStore } from "../lib/store";

// Wires the agent-native hook event stream (§7) into the store: subscribes to
// codehub://agent-event (live awaiting-input / turn / done / edit events for
// Claude + Codex; Antigravity never emits) and keeps the pending-prompt list +
// activity-history feed fresh. Both are STUB-backed until the BE track lands —
// `pending_prompts` returns [] and no events fire — so the Hub renders the
// honest-empty bell + feed gracefully until then.
//
// Strategy: poll the two reads on a slow cadence (the authoritative state) AND
// refresh immediately whenever a live event arrives (so the bell/toast react
// without waiting for the next poll). Mount ONCE in the Hub view.
const POLL_MS = 4000;

export function useAgentEvents() {
  const running = useStore((s) => s.status?.state === "running");

  useEffect(() => {
    if (!running) {
      // Clear stale state when the runtime goes down so the bell/feed don't
      // freeze a dead snapshot.
      useStore.setState({ pendingPrompts: [], activityHistory: [] });
      return;
    }
    let alive = true;
    const store = useStore.getState();
    const refresh = () => {
      if (!alive) return;
      void store.loadPendingPrompts();
      void store.loadActivityHistory();
    };
    refresh();
    const h = setInterval(refresh, POLL_MS);

    // Live nudge: any normalized event means the awaiting/turn state may have
    // changed — re-read both rather than mutate locally, so the backend stays
    // the single source of truth (and the stub's empties win cleanly).
    let unlisten: (() => void) | undefined;
    void onAgentEvent(() => refresh()).then((u) => {
      if (alive) unlisten = u;
      else u();
    });

    return () => {
      alive = false;
      clearInterval(h);
      unlisten?.();
    };
  }, [running]);
}
