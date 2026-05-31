import type { CSSProperties } from "react";
import { Input } from "../../ui/input";
import { IconBtn } from "./IconBtn";
import { Ico } from "./icons";

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  // When set, a clear (×) IconBtn appears while `value` is non-empty.
  onClear?: () => void;
  // Mono font for the field text (default true — matches the filter inputs).
  mono?: boolean;
  // Box-level style override (e.g. flex / minWidth / maxWidth for layout).
  style?: CSSProperties;
  "aria-label"?: string;
}

// Reusable filter/search field: a bordered box wrapping a leading search glyph,
// a borderless shadcn <Input>, and an optional clear button. Replaces the
// hand-rolled search boxes that were duplicated across Welcome / Resume so every
// filter field looks and behaves identically.
export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  onClear,
  mono = true,
  style,
  "aria-label": ariaLabel,
}: SearchInputProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 10px",
        background: "var(--bg-2)",
        border: "1px solid var(--bd-soft)",
        borderRadius: 8,
        minWidth: 0,
        ...style,
      }}
    >
      <span style={{ color: "var(--fg-3)", display: "inline-flex", flexShrink: 0 }}>
        {Ico.search}
      </span>
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        spellCheck={false}
        className={`h-auto border-0 bg-transparent px-0 shadow-none focus-visible:ring-0${mono ? " mono" : ""}`}
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--fg-0)",
          fontSize: "var(--fs-12)",
        }}
      />
      {onClear && value && (
        <IconBtn size={20} title="Clear search" onClick={onClear}>
          {Ico.close}
        </IconBtn>
      )}
    </div>
  );
}
