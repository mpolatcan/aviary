import type { ContainerState } from "../lib/ipc";

const STATE_LABEL: Record<ContainerState, string> = {
  missing: "no runtime",
  stopped: "stopped",
  starting: "waking",
  running: "running",
  unreachable: "unreachable",
};

const STATE_COLOR: Record<ContainerState, string> = {
  missing: "text-accent",
  stopped: "text-accent",
  starting: "text-accent-bright",
  running: "text-ok",
  unreachable: "text-danger",
};

interface Props {
  state: ContainerState | null;
  sessionName?: string | null;
  plate?: string | null;
}

function Cell({
  caps,
  children,
  className,
}: {
  caps: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 px-[14px] h-full border-r border-rule-soft ${className ?? ""}`}
    >
      <span className="text-text-faint">{caps}</span>
      <span className="text-rule">|</span>
      <span className="font-mono normal-case tracking-normal text-[12px] text-text">
        {children}
      </span>
    </span>
  );
}

export function StatusBar({ state, sessionName, plate }: Props) {
  const s = state ?? "starting";
  return (
    <footer className="flex items-center bg-panel border-t-2 border-rule font-pixel text-[length:var(--fs-pixel)] text-text-dim tracking-[0.05em] uppercase">
      <Cell caps="Session">{sessionName ?? "—"}</Cell>
      <Cell caps="Tab">{plate ?? "—"}</Cell>
      <span className="inline-flex items-center gap-2 px-[14px] h-full border-r border-rule-soft">
        <span className="text-text-faint">Runtime</span>
        <span className="text-rule">|</span>
        <span className={STATE_COLOR[s]}>{STATE_LABEL[s]}</span>
      </span>
      <span className="inline-flex items-center px-[14px] h-full ml-auto">
        <span className="font-mono normal-case tracking-normal text-[11px] text-text-faint">
          ad libitum
        </span>
      </span>
    </footer>
  );
}
