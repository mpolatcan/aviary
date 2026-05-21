export function TabBar({ onNewTab }: { onNewTab?: () => void }) {
  return (
    <nav
      className="relative flex items-stretch bg-bg border-b-2 border-rule"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <button
        type="button"
        title="Open a new tab"
        onClick={onNewTab}
        className="group flex items-center gap-[7px] px-[14px] border-r border-rule-soft text-text-dim hover:text-accent transition-colors"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <span className="text-[15px] leading-none">＋</span>
        <span className="flex flex-col leading-[1.05] text-left">
          <span className="font-pixel text-[length:var(--fs-pixel)] uppercase tracking-[0.06em]">
            new
          </span>
          <span className="font-pixel text-[length:var(--fs-pixel)] uppercase tracking-[0.06em] text-text-faint group-hover:text-accent">
            tab
          </span>
        </span>
      </button>
      <div className="flex flex-1 overflow-x-auto [scrollbar-width:none]" />
    </nav>
  );
}
