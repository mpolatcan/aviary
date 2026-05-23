/**
 * Segmented — a row of mutually-exclusive text options in a single bordered
 * pill, monochrome to match the design's settings controls. The active option
 * gets the raised `--bg-3` background; the rest are transparent.
 *
 * Extracted from the duplicated Theme / Density selectors in Settings. Generic
 * over the value union so each caller keeps its own string-literal type
 * (`Theme`, density strings, …) without casting.
 */
export interface SegmentedOption<T extends string> {
  key: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (key: T) => void;
}

export function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>) {
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--bd)",
        borderRadius: 6,
        overflow: "hidden",
        background: "var(--bg-1)",
      }}
    >
      {options.map((o) => {
        const on = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            style={{
              padding: "6px 14px",
              border: "none",
              fontSize: 12,
              fontFamily: "var(--sans)",
              cursor: "pointer",
              background: on ? "var(--bg-3)" : "transparent",
              color: on ? "var(--fg-0)" : "var(--fg-2)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
