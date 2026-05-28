import { motion } from "motion/react";
import type { DragEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PaneMount } from "../../components/PaneMount";
import { IconBtn } from "../../components/primitives/IconBtn";
import { StatusDot } from "../../components/primitives/StatusDot";
import { Ico } from "../../components/primitives/icons";
import { slideUp } from "../../hooks/useSlideIn";
import { useOverlay } from "../../lib/overlay";
import { activeWorkspace, useStore } from "../../lib/store";

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

  const running = status?.state === "running";
  const containerKey = ws?.containerKey ?? null;

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
      if (tabs.length <= 1) return;
      setTabs((prev) => {
        const next = prev.filter((_, i) => i !== idx);
        setActiveIdx((a) => (a >= next.length ? next.length - 1 : a > idx ? a - 1 : a));
        return next;
      });
    },
    [tabs.length],
  );

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
      {...slideUp}
      style={{
        flexShrink: 0,
        height: 224,
        background: "var(--bg-0)",
        borderTop: "1px solid var(--bd-soft)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          height: 32,
          flexShrink: 0,
          background: "var(--bg-1)",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 10px",
        }}
      >
        <span style={{ color: "var(--live)", display: "inline-flex" }}>{Ico.terminal}</span>
        <div
          className="scroll"
          style={{
            display: "flex",
            gap: 2,
            marginLeft: 4,
            minWidth: 0,
            flex: 1,
            overflow: "auto hidden",
          }}
        >
          {tabs.map((tab, i) => (
            <ShellTabBtn
              key={tab.name}
              label={tab.label}
              active={i === activeIdx}
              closable={tabs.length > 1}
              dragging={dragIdx === i}
              dropTarget={dropIdx === i && dragIdx !== i}
              onClick={() => setActiveIdx(i)}
              onClose={() => closeTab(i)}
              onDragStart={() => onDragStart(i)}
              onDragOver={() => onDragOver(i)}
              onDragEnd={onDragEnd}
            />
          ))}
          {tabs.length === 0 && !loading && (
            <span
              className="mono"
              style={{ fontSize: 11, color: "var(--fg-3)", padding: "2px 8px" }}
            >
              workspace shell
            </span>
          )}
        </div>
        <IconBtn
          title="New shell tab"
          style={{ width: 22, height: 22 }}
          onClick={addTab}
          disabled={!running || loading}
        >
          {Ico.plus}
        </IconBtn>
        <span style={{ width: 1, height: 14, background: "var(--bd-soft)", flexShrink: 0 }} />
        <span
          className="mono"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            minWidth: 0,
            color: "var(--fg-3)",
            fontSize: 10,
            flexShrink: 0,
          }}
          title={status?.name ?? containerKey ?? undefined}
        >
          <StatusDot status={running ? "live" : "off"} pulse={running} />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 140,
            }}
          >
            {status?.name ?? containerKey ?? "no workspace"}
          </span>
        </span>
        <IconBtn
          title="Hide shell (⌘⇧B)"
          onClick={() => setShell(false)}
          style={{ width: 22, height: 22 }}
        >
          {Ico.close}
        </IconBtn>
      </div>

      <div className="pane-body" style={{ background: "var(--bg-0)" }}>
        {activeTab ? (
          <PaneMount session={activeTab.name} />
        ) : (
          <ShellEmpty loading={loading} running={running} err={err} />
        )}
      </div>
    </motion.div>
  );
}

function ShellTabBtn({
  label,
  active,
  closable,
  dragging,
  dropTarget,
  onClick,
  onClose,
  onDragStart,
  onDragOver,
  onDragEnd,
}: {
  label: string;
  active: boolean;
  closable: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onClick: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
}) {
  return (
    <span
      draggable
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
        gap: 5,
        padding: "2px 8px",
        borderRadius: 4,
        fontFamily: "var(--mono)",
        fontSize: 11,
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
        transition: "background .12s, border-color .12s, opacity .12s",
      }}
    >
      <button
        type="button"
        onClick={onClick}
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
      {closable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close shell tab"
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: "var(--fg-3)",
            fontSize: 11,
            lineHeight: 1,
            display: "inline-flex",
          }}
        >
          ×
        </button>
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
        fontSize: 12,
        padding: 18,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}
