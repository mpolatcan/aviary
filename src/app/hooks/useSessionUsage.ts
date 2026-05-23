import { useEffect, useState } from "react";
import { type SessionUsage, ipc } from "../lib/ipc";

// Live token tally for one Claude conversation, polled from its own transcript
// by the `--session-id`/resumed id it launched with. Returns null when there is
// no id (non-Claude session, or before launch) and when the session has not yet
// produced a usable transcript — callers render an em-dash, never a fake zero.
//
// The cadence is deliberately slow: a transcript only grows a handful of times
// per turn and each read is a `docker exec cat`, so polling faster would just
// spend exec calls for no fresher signal. Shared by the pane header, the
// activity rail, and the always-on-top companion so all three agree.
const POLL_MS = 5000;

export function useSessionUsage(claudeId: string | null | undefined): SessionUsage | null {
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  useEffect(() => {
    if (!claudeId) {
      setUsage(null);
      return;
    }
    let alive = true;
    const tick = () => {
      ipc
        .claudeSessionUsage(claudeId)
        .then((u) => alive && setUsage(u))
        .catch(() => alive && setUsage(null));
    };
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [claudeId]);
  return usage;
}

// Compact token count for a narrow metric slot: 1_234_567 → "1.2M",
// 12_300 → "12.3K", 540 → "540".
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}
