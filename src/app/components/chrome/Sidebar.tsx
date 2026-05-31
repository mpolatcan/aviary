import { Logo } from "@/app/components/primitives/Logo";
/**
 * Sidebar — full sidebar panel with Logo header + nav groups using .side-item.
 */
import type { ReactNode } from "react";

export interface SidebarNavItem {
  key: string;
  label: string;
  icon?: ReactNode;
  active?: boolean;
}

export interface SidebarNavGroup {
  label?: string;
  items: SidebarNavItem[];
}

export interface SidebarProps {
  groups?: SidebarNavGroup[];
  footer?: ReactNode;
  onSelect?: (key: string) => void;
}

const DEFAULT_GROUPS: SidebarNavGroup[] = [
  {
    label: "Workspaces",
    items: [
      { key: "hub", label: "Hub" },
      { key: "containers", label: "Containers" },
    ],
  },
  {
    label: "Library",
    items: [{ key: "resume", label: "Resume" }],
  },
  {
    items: [
      { key: "settings", label: "Settings" },
      { key: "integrations", label: "Source control" },
    ],
  },
];

export function Sidebar({ groups = DEFAULT_GROUPS, footer, onSelect }: SidebarProps) {
  return (
    <div
      style={{
        width: 220,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-0)",
        borderRight: "1px solid var(--bd-soft)",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Logo header */}
      <div
        style={{
          padding: "14px 14px 10px",
          borderBottom: "1px solid var(--bd-soft)",
          flexShrink: 0,
        }}
      >
        <Logo size={16} withText />
      </div>

      {/* Nav groups */}
      <div style={{ flex: 1, overflow: "auto", padding: "8px 4px" }}>
        {groups.map((group, gi) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: nav groups have no stable id
          <div key={gi} style={{ marginBottom: 16 }}>
            {group.label && (
              <div className="lbl" style={{ padding: "4px 10px 6px", display: "block" }}>
                {group.label}
              </div>
            )}
            {group.items.map((item) => (
              <div
                key={item.key}
                className={`side-item${item.active ? " active" : ""}`}
                onClick={() => onSelect?.(item.key)}
              >
                {item.icon && <span style={{ flexShrink: 0 }}>{item.icon}</span>}
                <span style={{ fontSize: "var(--fs-13)" }}>{item.label}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Optional footer slot */}
      {footer && (
        <div style={{ flexShrink: 0, borderTop: "1px solid var(--bd-soft)", padding: "8px 4px" }}>
          {footer}
        </div>
      )}
    </div>
  );
}
