import { useEffect } from "react";
import { Tip } from "../../components/primitives/Tip";
import { Ico } from "../../components/primitives/icons";
import { useStore } from "../../lib/store";
import { Button } from "../../ui/button";
import { HubBanner } from "./HubBanner";

// Progress strip for background GitHub repo clones started by the New Workspace
// wizard. The clone runs in the workspace container AFTER the dialog closes, so
// this is the user's only signal that it's in flight / finished / failed. Reads
// the store's `repoClones` jobs; done jobs auto-dismiss after a beat, errors stay
// until dismissed. Nothing fabricated — every row is a real job.
const DONE_LINGER_MS = 4000;

export function CloneBanner() {
  const jobs = useStore((s) => s.repoClones);
  const dismiss = useStore((s) => s.dismissRepoClone);

  // Auto-clear finished (done) jobs after a short linger so the strip doesn't
  // stick around once the clone lands. Errors persist for the user to read.
  useEffect(() => {
    const done = jobs.filter((j) => j.status === "done");
    if (done.length === 0) return;
    const h = setTimeout(() => {
      for (const j of done) dismiss(j.repo);
    }, DONE_LINGER_MS);
    return () => clearTimeout(h);
  }, [jobs, dismiss]);

  if (jobs.length === 0) return null;

  const cloning = jobs.filter((j) => j.status === "cloning");
  const errors = jobs.filter((j) => j.status === "error");
  const done = jobs.filter((j) => j.status === "done");

  // Priority: in-flight first, then errors, then the brief done confirmation.
  if (cloning.length > 0) {
    const names = cloning.map((j) => j.repo).join(", ");
    return (
      <HubBanner
        tone="info"
        icon={Ico.spinner}
        title={`Cloning ${cloning.length} ${cloning.length === 1 ? "repository" : "repositories"}…`}
        message={names}
      />
    );
  }

  if (errors.length > 0) {
    const first = errors[0];
    return (
      <HubBanner
        tone="err"
        icon={Ico.container}
        title={`Clone failed: ${first.repo}`}
        message={first.error ?? undefined}
        actions={
          <Tip text="Dismiss">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                for (const j of errors) dismiss(j.repo);
              }}
            >
              Dismiss
            </Button>
          </Tip>
        }
      />
    );
  }

  if (done.length > 0) {
    return (
      <HubBanner
        tone="ok"
        icon={Ico.check}
        title={`Cloned ${done.length} ${done.length === 1 ? "repository" : "repositories"}`}
        message={done.map((j) => j.repo).join(", ")}
      />
    );
  }

  return null;
}
