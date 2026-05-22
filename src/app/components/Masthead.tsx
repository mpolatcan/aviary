import { useStore } from "../lib/store";

// Runtime state lives in the StatusBar (bottom); the masthead stays a clean
// title bar so the status isn't shown twice.
export function Masthead() {
  const count = useStore((s) => Object.keys(s.sessionMeta).length);
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <header
      className="grid grid-cols-[1fr_auto] items-center px-[18px] bg-panel border-b-2 border-rule"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="flex items-baseline gap-[10px] pl-[70px]">
        <span className="font-mono font-extrabold text-[length:var(--fs-lg)] text-text tracking-[-0.02em] leading-none">
          <span className="text-accent font-normal">▟ </span>CodeHub
        </span>
        <span className="text-text-ghost">·</span>
        <span className="pixel text-text-faint text-[length:var(--fs-pixel)]">
          AI coding sessions, multiplexed
        </span>
      </div>

      <div className="flex justify-end items-baseline gap-[12px]">
        {count > 0 && (
          <>
            <span className="pixel text-text-faint text-[length:var(--fs-pixel)]">
              {count} {count === 1 ? "session" : "sessions"}
            </span>
            <span className="text-text-ghost">·</span>
          </>
        )}
        <span className="font-mono text-[length:var(--fs-xs)] text-text-faint">{today}</span>
      </div>
    </header>
  );
}
