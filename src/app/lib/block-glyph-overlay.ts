import type { IBufferCell, IDisposable, Terminal } from "@xterm/xterm";

const BG = "#08090b";
const FG = "#aeb2bb";

const ANSI_0_15 = [
  "#1f242d",
  "#ff6f69",
  "#6fda75",
  "#f7bc50",
  "#98b7f8",
  "#b48ad6",
  "#17d0d8",
  "#aeb2bb",
  "#3f444d",
  "#ff8981",
  "#89f58f",
  "#ffd66c",
  "#b1d0ff",
  "#cba6e6",
  "#49eaf2",
  "#ecedf0",
];

type BlockBox = readonly [x: number, y: number, w: number, h: number];

const BLOCKS: Record<string, readonly BlockBox[]> = {
  "▀": [[0, 0, 8, 4]],
  "▁": [[0, 7, 8, 1]],
  "▂": [[0, 6, 8, 2]],
  "▃": [[0, 5, 8, 3]],
  "▄": [[0, 4, 8, 4]],
  "▅": [[0, 3, 8, 5]],
  "▆": [[0, 2, 8, 6]],
  "▇": [[0, 1, 8, 7]],
  "█": [[0, 0, 8, 8]],
  "▉": [[0, 0, 7, 8]],
  "▊": [[0, 0, 6, 8]],
  "▋": [[0, 0, 5, 8]],
  "▌": [[0, 0, 4, 8]],
  "▍": [[0, 0, 3, 8]],
  "▎": [[0, 0, 2, 8]],
  "▏": [[0, 0, 1, 8]],
  "▐": [[4, 0, 4, 8]],
  "▔": [[0, 0, 8, 1]],
  "▕": [[7, 0, 1, 8]],
  "▖": [[0, 4, 4, 4]],
  "▗": [[4, 4, 4, 4]],
  "▘": [[0, 0, 4, 4]],
  "▙": [
    [0, 0, 4, 8],
    [0, 4, 8, 4],
  ],
  "▚": [
    [0, 0, 4, 4],
    [4, 4, 4, 4],
  ],
  "▛": [
    [0, 0, 4, 8],
    [4, 0, 4, 4],
  ],
  "▜": [
    [0, 0, 8, 4],
    [4, 0, 4, 8],
  ],
  "▝": [[4, 0, 4, 4]],
  "▞": [
    [4, 0, 4, 4],
    [0, 4, 4, 4],
  ],
  "▟": [
    [4, 0, 4, 8],
    [0, 4, 8, 4],
  ],
};

function paletteColor(index: number): string {
  if (index < ANSI_0_15.length) return ANSI_0_15[index];
  if (index >= 16 && index <= 231) {
    const cube = [0, 95, 135, 175, 215, 255];
    const n = index - 16;
    const r = cube[Math.floor(n / 36) % 6];
    const g = cube[Math.floor(n / 6) % 6];
    const b = cube[n % 6];
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (index >= 232 && index <= 255) {
    const v = 8 + (index - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  return FG;
}

function rgbColor(value: number): string {
  return `rgb(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff})`;
}

function foregroundNoInverse(cell: IBufferCell): string {
  if (cell.isFgRGB()) return rgbColor(cell.getFgColor());
  if (cell.isFgPalette()) return paletteColor(cell.getFgColor());
  return FG;
}

function backgroundNoInverse(cell: IBufferCell): string {
  if (cell.isBgRGB()) return rgbColor(cell.getBgColor());
  if (cell.isBgPalette()) return paletteColor(cell.getBgColor());
  return BG;
}

function foreground(cell: IBufferCell): string {
  return cell.isInverse() ? backgroundNoInverse(cell) : foregroundNoInverse(cell);
}

function background(cell: IBufferCell): string {
  return cell.isInverse() ? foregroundNoInverse(cell) : backgroundNoInverse(cell);
}

function drawBlock(
  ctx: CanvasRenderingContext2D,
  boxes: readonly BlockBox[],
  x: number,
  y: number,
  cellW: number,
  cellH: number,
) {
  const eighthW = cellW / 8;
  const eighthH = cellH / 8;
  for (const [bx, by, bw, bh] of boxes) {
    ctx.fillRect(x + bx * eighthW, y + by * eighthH, bw * eighthW, bh * eighthH);
  }
}

export function installBlockGlyphOverlay(term: Terminal, surface: HTMLElement): IDisposable {
  const canvas = document.createElement("canvas");
  canvas.className = "xterm-block-glyph-overlay";
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.zIndex = "20";
  canvas.style.pointerEvents = "none";
  canvas.style.display = "block";

  let frame = 0;
  let disposed = false;
  let observedScreen: HTMLElement | null = null;

  const findScreen = () => surface.querySelector<HTMLElement>(".xterm-screen");

  const ensureAttached = (): HTMLElement | null => {
    const screen = findScreen();
    if (!screen) return null;
    if (canvas.parentElement !== screen || screen.lastElementChild !== canvas) {
      screen.appendChild(canvas);
    }
    if (observedScreen !== screen) {
      if (observedScreen) resizeObserver.unobserve(observedScreen);
      observedScreen = screen;
      resizeObserver.observe(screen);
    }
    return screen;
  };

  const render = () => {
    frame = 0;
    const screen = ensureAttached();
    if (!screen) return;

    const reference =
      screen.querySelector<HTMLCanvasElement>("canvas.xterm-text-layer") ??
      screen.querySelector<HTMLCanvasElement>("canvas:not(.xterm-block-glyph-overlay)");
    const ratio = window.devicePixelRatio || 1;
    const rect = reference?.getBoundingClientRect() ?? screen.getBoundingClientRect();
    const cssWidth = reference?.style.width || `${rect.width || screen.clientWidth}px`;
    const cssHeight = reference?.style.height || `${rect.height || screen.clientHeight}px`;
    const width = reference?.width ?? Math.round((rect.width || screen.clientWidth) * ratio);
    const height = reference?.height ?? Math.round((rect.height || screen.clientHeight) * ratio);

    if (width <= 0 || height <= 0) return;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    canvas.style.width = cssWidth;
    canvas.style.height = cssHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx || term.cols <= 0 || term.rows <= 0) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const cellW = width / term.cols;
    const cellH = height / term.rows;
    const buffer = term.buffer.active;

    for (let row = 0; row < term.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (!line) continue;

      for (let col = 0; col < Math.min(term.cols, line.length); col += 1) {
        const cell = line.getCell(col);
        if (!cell || cell.getWidth() === 0 || cell.isInvisible()) continue;

        const boxes = BLOCKS[cell.getChars()];
        if (!boxes) continue;

        const x = col * cellW;
        const y = row * cellH;
        ctx.fillStyle = background(cell);
        ctx.fillRect(x, y, cellW, cellH);
        ctx.fillStyle = foreground(cell);
        drawBlock(ctx, boxes, x, y, cellW, cellH);
      }
    }
  };

  const schedule = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(render);
  };

  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(surface);
  const mutationObserver = new MutationObserver(schedule);
  mutationObserver.observe(surface, { childList: true, subtree: true });
  const renderDisposable = term.onRender(schedule);
  const resizeDisposable = term.onResize(schedule);
  const scrollDisposable = term.onScroll(schedule);
  // The pane may still be in the hidden stash when this is installed. Queue a few
  // early paints so the overlay catches the first real mounted size.
  schedule();
  setTimeout(schedule, 0);
  setTimeout(schedule, 50);
  setTimeout(schedule, 250);

  return {
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      renderDisposable.dispose();
      resizeDisposable.dispose();
      scrollDisposable.dispose();
      canvas.remove();
    },
  };
}
