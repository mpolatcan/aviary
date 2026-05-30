const ESC = "\x1b";
const BG_16_256_COLOR = ["48", "5", "16"];

type Color =
  | { kind: "default" }
  | { kind: "palette"; value: number }
  | { kind: "rgb"; r: number; g: number; b: number };

interface Rendition {
  fg: Color;
  bg: Color;
  inverse: boolean;
}

function defaultRendition(): Rendition {
  return {
    fg: { kind: "default" },
    bg: { kind: "default" },
    inverse: false,
  };
}

function isCsiFinal(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function parseParams(params: string): string[] {
  return params === "" ? ["0"] : params.split(";");
}

function updateRendition(state: Rendition, params: string): string {
  const parts = parseParams(params);
  const next: string[] = [];
  let changed = false;

  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i] === "" ? "0" : parts[i];
    const value = Number(raw);

    if (raw.includes(":") || !Number.isFinite(value)) {
      next.push(parts[i]);
      continue;
    }

    if (value === 0) {
      state.fg = { kind: "default" };
      state.bg = { kind: "default" };
      state.inverse = false;
      next.push(raw);
      continue;
    }
    if (value === 7) {
      state.inverse = true;
      next.push(raw);
      continue;
    }
    if (value === 27) {
      state.inverse = false;
      next.push(raw);
      continue;
    }
    if (value === 39) {
      state.fg = { kind: "default" };
      next.push(raw);
      continue;
    }
    if (value === 49) {
      state.bg = { kind: "default" };
      next.push(raw);
      continue;
    }
    if (value >= 30 && value <= 37) {
      state.fg = { kind: "palette", value: value - 30 };
      next.push(raw);
      continue;
    }
    if (value >= 90 && value <= 97) {
      state.fg = { kind: "palette", value: value - 90 + 8 };
      next.push(raw);
      continue;
    }
    if (value >= 40 && value <= 47) {
      state.bg = { kind: "palette", value: value - 40 };
      next.push(raw);
      continue;
    }
    if (value >= 100 && value <= 107) {
      state.bg = { kind: "palette", value: value - 100 + 8 };
      next.push(raw);
      continue;
    }

    if (raw === "38" && parts[i + 1] === "5" && parts[i + 2] !== undefined) {
      const color = Number(parts[i + 2]);
      if (Number.isFinite(color)) {
        state.fg = { kind: "palette", value: color };
      }
      next.push(raw, parts[i + 1], parts[i + 2]);
      i += 2;
      continue;
    }
    if (
      raw === "38" &&
      parts[i + 1] === "2" &&
      parts[i + 2] !== undefined &&
      parts[i + 3] !== undefined &&
      parts[i + 4] !== undefined
    ) {
      const r = Number(parts[i + 2]);
      const g = Number(parts[i + 3]);
      const b = Number(parts[i + 4]);
      if ([r, g, b].every(Number.isFinite)) {
        state.fg = { kind: "rgb", r, g, b };
      }
      next.push(raw, parts[i + 1], parts[i + 2], parts[i + 3], parts[i + 4]);
      i += 4;
      continue;
    }

    if (
      raw === BG_16_256_COLOR[0] &&
      parts[i + 1] === BG_16_256_COLOR[1] &&
      parts[i + 2] === BG_16_256_COLOR[2]
    ) {
      // Claude's banner uses palette bg-16 behind block glyphs. Reset only that
      // background and keep the foreground/art intact.
      state.bg = { kind: "default" };
      next.push("49");
      i += 2;
      changed = true;
      continue;
    }
    if (raw === "48" && parts[i + 1] === "5" && parts[i + 2] !== undefined) {
      const color = Number(parts[i + 2]);
      if (Number.isFinite(color)) {
        state.bg = { kind: "palette", value: color };
      }
      next.push(raw, parts[i + 1], parts[i + 2]);
      i += 2;
      continue;
    }
    if (
      raw === "48" &&
      parts[i + 1] === "2" &&
      parts[i + 2] !== undefined &&
      parts[i + 3] !== undefined &&
      parts[i + 4] !== undefined
    ) {
      const r = Number(parts[i + 2]);
      const g = Number(parts[i + 3]);
      const b = Number(parts[i + 4]);
      if ([r, g, b].every(Number.isFinite)) {
        state.bg = { kind: "rgb", r, g, b };
      }
      next.push(raw, parts[i + 1], parts[i + 2], parts[i + 3], parts[i + 4]);
      i += 4;
      continue;
    }

    next.push(raw);
  }

  return changed ? `${ESC}[${next.join(";")}m` : `${ESC}[${params}m`;
}

export function normalizePtyOutput(data: string): string {
  const state = defaultRendition();
  return normalizeChunk(data, state).output;
}

function normalizeChunk(data: string, state: Rendition): { output: string; carry: string } {
  let output = "";

  for (let i = 0; i < data.length; ) {
    if (data[i] === ESC && i === data.length - 1) {
      return { output, carry: data.slice(i) };
    }

    if (data[i] === ESC && data[i + 1] === "[") {
      let end = i + 2;
      while (end < data.length && !isCsiFinal(data[end])) end += 1;
      if (end >= data.length) return { output, carry: data.slice(i) };

      const final = data[end];
      const params = data.slice(i + 2, end);
      const sequence = data.slice(i, end + 1);
      output += final === "m" ? updateRendition(state, params) : sequence;
      i = end + 1;
      continue;
    }

    const code = data.codePointAt(i);
    if (code === undefined) break;
    const ch = String.fromCodePoint(code);
    output += ch;
    i += ch.length;
  }

  return { output, carry: "" };
}

export function createPtyOutputNormalizer(): (chunk: string) => string {
  let carry = "";
  const state = defaultRendition();

  return (chunk: string) => {
    const result = normalizeChunk(carry + chunk, state);
    carry = result.carry;
    return result.output;
  };
}
