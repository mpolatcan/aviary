import { cn } from "../lib/cn";
import type { ContainerState } from "../lib/ipc";

const STATE_LABEL: Record<ContainerState, string> = {
  missing: "no runtime",
  stopped: "stopped",
  starting: "waking",
  running: "running",
  unreachable: "unreachable",
};

const DOT: Record<ContainerState, string> = {
  missing: "bg-accent",
  stopped: "bg-accent",
  starting: "bg-accent-bright animate-pulse",
  running: "bg-ok shadow-[0_0_7px_rgba(110,231,135,0.55)]",
  unreachable: "bg-danger",
};

export function Masthead({ state }: { state: ContainerState | null }) {
  const s = state ?? "starting";
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <header
      className="grid grid-cols-[1fr_auto_1fr] items-center px-[18px] bg-panel border-b-2 border-rule"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="flex items-baseline gap-[10px] pl-[70px]">
        <span className="font-mono font-extrabold text-[17px] text-text tracking-[-0.02em] leading-none">
          <span className="text-accent font-normal">▟ </span>Aviary
        </span>
        <span className="text-text-ghost">·</span>
        <span className="pixel text-text-faint text-[length:var(--fs-pixel)]">
          AI coding sessions, multiplexed
        </span>
      </div>

      <div
        className="inline-flex items-center gap-2 px-3 py-[5px] border-2 border-rule rounded-sm bg-bg-deep pixel text-text-dim text-[length:var(--fs-pixel)]"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <span className={cn("w-[7px] h-[7px]", DOT[s])} />
        <span>{STATE_LABEL[s]}</span>
      </div>

      <div className="flex justify-end items-baseline">
        <span className="font-mono text-[12px] text-text-faint">{today}</span>
      </div>
    </header>
  );
}
