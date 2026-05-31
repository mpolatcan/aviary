import { motion } from "motion/react";
import type { DragEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PaneMount } from "../../components/PaneMount";
import { IconBtn } from "../../components/primitives/IconBtn";
import { Tip } from "../../components/primitives/Tip";
import { Ico } from "../../components/primitives/icons";
import { useResizableDock } from "../../hooks/useResizableDock";
import { EASE } from "../../hooks/useSlideIn";
import { useOverlay } from "../../lib/overlay";
import { activeWorkspace, useStore } from "../../lib/store";
import { Input } from "../../ui/input";
import { ResizeHandle } from "./ResizeHandle";

interface ShellTab {
  name: string;
  label: string;
}

export function ShellPanel() {
  const ws = useStore(activeWorkspace);
  const status = useStore((s) => s.status);
  const ensureDockedShell = useStore((s) => s.ensureDockedShell);
  const createExtraShell = useStore((s) => s.createExtraShell);
  const setShell = useOverlay((s) => s.setShell);
  const [tabs, setTabs] = useState<ShellTab[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const initDone = useRef(false);

  // Tab-strip scroll: chevrons appear once the tabs overflow the strip, and hide
  // at each extent so a dead-end arrow never shows (mirrors HubTabs).
  const stripRef = useRef<HTMLDivElement>(null);
  const prevTabCount = useRef(0);
  const [overflowing, setOverflowing] = useState(false);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const scrollTabs = (dir: -1 | 1) =>
    stripRef.current?.scrollBy({ left: dir * 160, behavior: "smooth" });

  const running = status?.state === "running";
  const containerKey = ws?.containerKey ?? null;
  const { size, dragging, ref, beginResize, reset } = useResizableDock("ch.shell.h", 224, {
    min: 120,
    max: () => Math.min(window.innerHeight * 0.7, 520),
    edge: "top",
  });

  useEffect(() => {
    let alive = true;
    setTabs([]);
    setActiveIdx(0);
    setErr(null);
    initDone.current = false;
    if (!containerKey || !running) {
      setLoading(false);
      return;
    }

    setLoading(true);
    ensureDockedShell()
      .then((name) => {
        if (!alive) return;
        if (name) {
          setTabs([{ name, label: "Shell 1" }]);
          setActiveIdx(0);
        } else {
          setErr("No workspace shell is available.");
        }
        initDone.current = true;
      })
      .catch((e) => {
        if (alive) setErr(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [containerKey, ensureDockedShell, running]);

  const addTab = useCallback(async () => {
    try {
      const name = await createExtraShell();
      if (!name) return;
      setTabs((prev) => {
        const next = [...prev, { name, label: `Shell ${prev.length + 1}` }];
        setActiveIdx(next.length - 1);
        return next;
      });
    } catch (e) {
      console.warn("Failed to create extra shell:", e);
    }
  }, [createExtraShell]);

  const closeTab = useCallback(
    (idx: number) => {
      // Closing the only remaining tab has nothing left to show → hide the dock
      // (reopen via ⌘J or the ActionBar shell toggle, which re-runs init).
      if (tabs.length <= 1) {
        setShell(false);
        return;
      }
      setTabs((prev) => {
        const next = prev.filter((_, i) => i !== idx);
        setActiveIdx((a) => (a >= next.length ? next.length - 1 : a > idx ? a - 1 : a));
        return next;
      });
    },
    [tabs.length, setShell],
  );

  const renameTab = useCallback((idx: number, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    setTabs((prev) => prev.map((t, i) => (i === idx ? { ...t, label: trimmed } : t)));
  }, []);

  // Keep the newest tab (and the trailing "+") in view when a tab is added.
  useEffect(() => {
    const strip = stripRef.current;
    if (strip && tabs.length > prevTabCount.current) {
      strip.scrollTo({ left: strip.scrollWidth, behavior: "smooth" });
    }
    prevTabCount.current = tabs.length;
  }, [tabs.length]);

  // Measure overflow + scroll extents on tab change, scroll, and resize.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on tab count change — add/remove shifts scrollWidth, which the ResizeObserver alone won't catch.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => {
      setOverflowing(strip.scrollWidth > strip.clientWidth + 4);
      setAtStart(strip.scrollLeft <= 0);
      setAtEnd(strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    strip.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      strip.removeEventListener("scroll", measure);
    };
  }, [tabs.length]);

  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const onDragStart = useCallback((idx: number) => setDragIdx(idx), []);
  const onDragOver = useCallback((idx: number) => setDropIdx(idx), []);
  const onDragEnd = useCallback(() => {
    if (dragIdx !== null && dropIdx !== null && dragIdx !== dropIdx) {
      setTabs((prev) => {
        const next = [...prev];
        const [moved] = next.splice(dragIdx, 1);
        next.splice(dropIdx, 0, moved);
        setActiveIdx(dropIdx);
        return next;
      });
    }
    setDragIdx(null);
    setDropIdx(null);
  }, [dragIdx, dropIdx]);

  const activeTab = tabs[activeIdx] ?? null;

  return (
    <motion.div
      ref={ref as React.Ref<HTMLDivElement>}
      initial={{ height: 0 }}
      animate={{ height: size }}
      exit={{ height: 0 }}
      transition={{ duration: dragging ? 0 : 0.28, ease: EASE }}
      style={{ flexShrink: 0, overflow: "hidden", position: "relative" }}
    >
      {/* fixed-height inner so the xterm pane keeps a constant size during the
          open/close tween; a resize drag changes it → PaneMount refits live */}
      <div
        style={{
          height: size,
          background: "var(--bg-0)",
          borderTop: "1px solid var(--bd-soft)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <ResizeHandle edge="top" onMouseDown={beginResize} onDoubleClick={reset} />
        <div
          style={{
            height: 32,
            flexShrink: 0,
            background: "var(--bg-1)",
            borderBottom: "1px solid var(--bd-soft)",
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "0 8px",
          }}
        >
          <span style={{ color: "var(--live)", display: "inline-flex", flexShrink: 0 }}>
            {Ico.terminal}
          </span>
          {overflowing && !atStart && (
            <IconBtn
              title="Scroll tabs left"
              onClick={() => scrollTabs(-1)}
              size={22}
              style={{ flexShrink: 0 }}
            >
              {Ico.chevL}
            </IconBtn>
          )}
          <div
            ref={stripRef}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              marginLeft: 4,
              minWidth: 0,
              flex: 1,
              overflowX: "auto",
              overflowY: "hidden",
              scrollbarWidth: "none",
            }}
          >
            {tabs.map((tab, i) => (
              <ShellTabBtn
                key={tab.name}
                label={tab.label}
                active={i === activeIdx}
                dragging={dragIdx === i}
                dropTarget={dropIdx === i && dragIdx !== i}
                onClick={() => setActiveIdx(i)}
                onClose={() => closeTab(i)}
                onRename={(label) => renameTab(i, label)}
                onDragStart={() => onDragStart(i)}
                onDragOver={() => onDragOver(i)}
                onDragEnd={onDragEnd}
              />
            ))}
            {tabs.length === 0 && !loading ? (
              <span
                className="mono"
                style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)", padding: "2px 8px" }}
              >
                workspace shell
              </span>
            ) : (
              <IconBtn
                title="New shell tab"
                size={22}
                style={{ flexShrink: 0, marginLeft: 2 }}
                onClick={addTab}
                disabled={!running || loading}
              >
                {Ico.plus}
              </IconBtn>
            )}
          </div>
          {overflowing && !atEnd && (
            <IconBtn
              title="Scroll tabs right"
              onClick={() => scrollTabs(1)}
              size={22}
              style={{ flexShrink: 0 }}
            >
              {Ico.chevR}
            </IconBtn>
          )}
        </div>

        <div className="pane-body" style={{ background: "var(--bg-0)" }}>
          {activeTab ? (
            <PaneMount session={activeTab.name} />
          ) : (
            <ShellEmpty loading={loading} running={running} err={err} />
          )}
        </div>
      </div>
    </motion.div>
  );
}

function ShellTabBtn({
  label,
  active,
  dragging,
  dropTarget,
  onClick,
  onClose,
  onRename,
  onDragStart,
  onDragOver,
  onDragEnd,
}: {
  label: string;
  active: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onClick: () => void;
  onClose: () => void;
  onRename: (label: string) => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <span
      className={`shell-tab${active ? " active" : ""}`}
      draggable={!editing}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        onDragEnd();
      }}
      onDragEnd={onDragEnd}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "0 4px 0 10px",
        height: 24,
        borderRadius: 6,
        fontFamily: "var(--mono)",
        fontSize: "var(--fs-12)",
        background: dropTarget
          ? "color-mix(in oklab, var(--pri) 20%, var(--bg-3))"
          : active
            ? "var(--bg-3)"
            : "transparent",
        color: active ? "var(--fg-0)" : "var(--fg-2)",
        border: dropTarget
          ? "1px solid var(--pri)"
          : active
            ? "1px solid var(--bd-soft)"
            : "1px solid transparent",
        minWidth: 0,
        cursor: dragging ? "grabbing" : "grab",
        whiteSpace: "nowrap",
        flexShrink: 0,
        opacity: dragging ? 0.4 : 1,
      }}
    >
      {editing ? (
        <Input
          className="pane-name-input h-auto"
          defaultValue={label}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => {
            onRename(e.currentTarget.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onRename(e.currentTarget.value);
              setEditing(false);
            } else if (e.key === "Escape") {
              setEditing(false);
            }
            e.stopPropagation();
          }}
          style={{ width: 76, fontSize: "var(--fs-12)" }}
        />
      ) : (
        <>
          <Tip text="Double-click to rename">
            <button
              type="button"
              onClick={onClick}
              onDoubleClick={() => setEditing(true)}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "inherit",
                color: "inherit",
                fontFamily: "inherit",
                fontSize: "inherit",
              }}
            >
              {label}
            </button>
          </Tip>
          <Tip text="Close shell tab">
            <button
              type="button"
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              {Ico.close}
            </button>
          </Tip>
        </>
      )}
    </span>
  );
}

function ShellEmpty({
  loading,
  running,
  err,
}: {
  loading: boolean;
  running: boolean;
  err: string | null;
}) {
  const text = err
    ? err
    : loading
      ? "Starting shell session..."
      : running
        ? "Shell session is not ready."
        : "Start the workspace container to open shell.";
  return (
    <div
      className="mono"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: err ? "var(--err)" : "var(--fg-3)",
        fontSize: "var(--fs-12)",
        padding: 18,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}
