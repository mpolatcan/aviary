import { Tip } from "../../components/primitives/Tip";
import { Ico } from "../../components/primitives/icons";
import { activeWorkspace, useStore } from "../../lib/store";
import { workspaceLeaves } from "../../lib/tree";
import { Button } from "../../ui/button";
import { HubBanner } from "./HubBanner";

// The "Workspace offline" state from design/screens/hub-states.jsx
// (HubStateDisconnected), wired to REAL runtime state instead of the mock's
// fabricated retry-counter / last-seen / burn-rate.
//
// Honest trigger: the runtime is `unreachable` (was running, stopped answering)
// — or a lifecycle action errored — WHILE the active tab still has a live pane
// grid. That's the genuine "my agents' container dropped" moment; a plain
// `stopped`/`missing` runtime with no open work is the EmptyHero/sidebar's job,
// not an alarm. Reconnect = the real restartRuntime() (re-starts the container;
// panes re-bootstrap on the next running status). Nothing here is invented.
export function RuntimeBanner() {
  const state = useStore((s) => s.status?.state);
  const name = useStore((s) => s.status?.name);
  const error = useStore((s) => s.error);
  const restartRuntime = useStore((s) => s.restartRuntime);
  const active = useStore(activeWorkspace);

  // Only alarm when there's live work to lose a connection to.
  const hasGrid = !!active && workspaceLeaves(active).length > 0;
  const disconnected = state === "unreachable";
  if (!hasGrid || (!disconnected && !error)) return null;

  const message = error
    ? error
    : `${name ?? "the runtime container"} stopped responding — sessions are paused until it reconnects.`;

  return (
    <HubBanner
      tone="err"
      icon={Ico.container}
      title="Workspace offline"
      message={message}
      actions={
        <Tip text="Reconnect workspace runtime">
          <Button size="sm" onClick={() => void restartRuntime()}>
            Reconnect
          </Button>
        </Tip>
      }
    />
  );
}
