import { ToggleGroup, ToggleGroupItem } from "../../ui/toggle-group";

/**
 * Segmented — a row of mutually-exclusive text options in a single bordered
 * pill, monochrome to match the design's settings controls. The active option
 * gets the raised `--bg-3` background; the rest are transparent.
 *
 * Renders the shadcn <ToggleGroup type="single"> so it shares the one toggle
 * implementation. Generic over the value union so each caller keeps its own
 * string-literal type (`Theme`, density strings, …) without casting.
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
    <ToggleGroup
      type="single"
      value={value}
      // Single-select: ignore the empty value Radix emits when the active item
      // is clicked again, so the selection can't be cleared (matches the old
      // button-row behavior).
      onValueChange={(v) => v && onChange(v as T)}
      className="overflow-hidden rounded-md border border-[var(--bd)] bg-[var(--bg-1)]"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.key}
          value={o.key}
          className="h-auto rounded-none border-0 px-3.5 py-1.5 font-sans text-xs text-[var(--fg-2)] data-[state=on]:bg-[var(--bg-3)] data-[state=on]:text-[var(--fg-0)]"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
