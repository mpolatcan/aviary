import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";
import { DiffBody, diffCounts, parseDiff } from "./DiffBody";

// Renders a unified diff in a modal. With a path it's one /workspace file
// (container_git_diff); with the empty-string sentinel it's the combined diff
// of every tracked change (container_git_diff_all). The diff parsing + row
// rendering live in DiffBody, shared with the session-detail inspector.

export function DiffViewer({ path, onClose }: { path: string | null; onClose: () => void }) {
  const [diff, setDiff] = useState<string | null>(null);

  useEffect(() => {
    if (path === null) {
      setDiff(null);
      return;
    }
    let alive = true;
    setDiff(null);
    // Empty-string sentinel → combined diff of every change; a path → that file.
    const load = path === "" ? ipc.containerGitDiffAll() : ipc.containerGitDiff(path);
    load.then((d) => alive && setDiff(d)).catch(() => alive && setDiff(""));
    return () => {
      alive = false;
    };
  }, [path]);

  const counts = diff ? diffCounts(parseDiff(diff)) : null;

  return (
    <Dialog open={path !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent style={{ maxWidth: 860, padding: 0 }}>
        <DialogHeader style={{ padding: "16px 18px 10px" }}>
          <DialogTitle
            className="mono"
            style={{
              fontSize: 13,
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {path === "" ? "All changes" : (path ?? "")}
          </DialogTitle>
          {counts && (counts.added > 0 || counts.removed > 0) && (
            <span className="mono tnum" style={{ fontSize: 11, color: "var(--fg-2)" }}>
              <span style={{ color: "var(--live)" }}>+{counts.added}</span>{" "}
              <span style={{ color: "var(--err)" }}>−{counts.removed}</span>
            </span>
          )}
        </DialogHeader>
        <DiffBody
          diff={diff}
          emptyLabel={
            path === ""
              ? "No tracked changes — the working tree is clean."
              : "No diff to show — the file may be unchanged or binary."
          }
          style={{ maxHeight: "62vh", borderTop: "1px solid var(--bd-soft)" }}
        />
      </DialogContent>
    </Dialog>
  );
}
