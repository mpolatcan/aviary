import type { CSSProperties, ReactNode } from "react";

// Section-nav tab bar — the underline pattern shared by Settings (agent tabs) and
// AgentDetail. One definition so they stay identical: a bottom-ruled container +
// tabs whose active state is a 2px brand-accent (--pri) underline. Tabs take
// arbitrary children (glyph + label + status), not just a string.

export function TabBar({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid var(--bd-soft)",
        flexShrink: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Tab({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 16px",
        background: "transparent",
        border: "none",
        // -1px overlaps the container's bottom rule so the active underline sits on it.
        marginBottom: -1,
        borderBottom: `2px solid ${active ? "var(--pri)" : "transparent"}`,
        color: active ? "var(--fg-0)" : "var(--fg-2)",
        cursor: active || disabled ? "default" : "pointer",
        fontSize: "var(--fs-13)",
        fontFamily: "var(--sans)",
        fontWeight: active ? 500 : 400,
        transition: "color .12s ease, border-color .12s ease",
      }}
    >
      {children}
    </button>
  );
}
