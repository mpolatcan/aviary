import { PaneAddBtn } from "../../components/primitives/PaneAddBtn";
import { SpawnSplitBtn } from "../../components/primitives/SpawnSplitBtn";
import { Tip } from "../../components/primitives/Tip";
import { Ico } from "../../components/primitives/icons";
import { useOverlay } from "../../lib/overlay";
import { Button } from "../../ui/button";

// Bottom action bar of the Hub, ported from design/screens/hub-states.jsx
// `ActionBar`. Left: Files / Shell / Diff pane affordances. Right: a Resume
// shortcut + the primary SpawnSplitBtn CTA.
//
// REAL wiring: Files / Shell / Diff toggle docked workspace utility panels via
// the overlay store (the chip's active fill mirrors their open state); Resume
// toggles the docked Resume drawer. Nothing here fabricates data.
export function ActionBar() {
  const filesOpen = useOverlay((s) => s.files);
  const setFiles = useOverlay((s) => s.setFiles);
  const shellOpen = useOverlay((s) => s.shell);
  const setShell = useOverlay((s) => s.setShell);
  const diffOpen = useOverlay((s) => s.diff) !== null;
  const setDiff = useOverlay((s) => s.setDiff);
  const resumeOpen = useOverlay((s) => s.resume);
  const setResume = useOverlay((s) => s.setResume);

  return (
    <div
      style={{
        height: 36,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 12px",
        background: "var(--bg-1)",
        borderTop: "1px solid var(--bd-soft)",
      }}
    >
      <PaneAddBtn
        kind="files"
        kbd="⌘E"
        active={filesOpen}
        onClick={() => setFiles(!filesOpen)}
        showLabel
      />
      <PaneAddBtn
        kind="shell"
        kbd="⌘J"
        active={shellOpen}
        onClick={() => setShell(!shellOpen)}
        showLabel
      />
      <PaneAddBtn
        kind="diff"
        kbd="⌘D"
        active={diffOpen}
        onClick={() => setDiff(diffOpen ? null : "")}
        showLabel
      />

      <span style={{ flex: 1 }} />

      <Tip text={resumeOpen ? "Hide Resume drawer" : "Resume a past session"}>
        <Button
          variant="ghost"
          size="xs"
          // Match the spawn button's 28px height so the Resume / New-agent pair lines up.
          className="h-7"
          onClick={() => setResume(!resumeOpen)}
          style={
            resumeOpen
              ? { background: "var(--bg-3)", color: "var(--fg-0)", borderColor: "var(--bd)" }
              : undefined
          }
        >
          {Ico.clock}
          Resume
        </Button>
      </Tip>
      <SpawnSplitBtn />
    </div>
  );
}
