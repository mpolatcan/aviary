/**
 * Integrations — what the runtime's Claude is actually connected to, read from
 * on-disk config (claude_integrations): the signed-in account (oauthAccount in
 * ~/.claude.json) + configured MCP servers (~/.claude.json + workspace .mcp.json).
 *
 * Honesty contract: every value is FACTUAL, read locally — nothing is fabricated
 * and no credential is surfaced. The account fields are the user's own metadata
 * already on disk (identity only — no token, no billing). MCP servers show only
 * name / transport / a non-secret target (command or URL); secret-bearing fields
 * (env, headers) are never read by the backend. An empty MCP list is the honest
 * truth ("none configured"), not a placeholder.
 *
 * Claude-only: Codex stores auth in a sqlite db and Antigravity has no readable
 * connection config, so neither is surfaced rather than guessed (stated in UI).
 */
import { AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { Ico } from "@/app/components/primitives/icons";
import { type ClaudeIntegrations, ipc } from "@/app/lib/ipc";
import { useLauncher } from "@/app/lib/launcher";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { useEffect, useState } from "react";

export function Integrations() {
  const status = useStore((s) => s.status);
  const openLaunch = useLauncher((s) => s.open);
  const state = status?.state ?? "missing";
  const running = state === "running";

  // One-shot poll (~10s); config can change as the user signs in or edits MCP.
  // Alive-guarded, same contract as the other screens — a failed read clears to
  // null so the UI shows an honest note rather than stale data.
  const [data, setData] = useState<ClaudeIntegrations | null>(null);
  useEffect(() => {
    if (!running) {
      setData(null);
      return;
    }
    let alive = true;
    const tick = () => {
      ipc
        .claudeIntegrations()
        .then((d) => alive && setData(d))
        .catch(() => alive && setData(null));
    };
    tick();
    const h = setInterval(tick, 10000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running]);

  return (
    <main
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-1)",
        minWidth: 0,
        color: "var(--fg-1)",
      }}
    >
      <div style={{ padding: "20px 28px 14px", borderBottom: "1px solid var(--bd-soft)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>
            Integrations
          </h1>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
            {data
              ? `${data.account ? "1 account" : "no account"} · ${data.mcpServers.length} MCP`
              : `runtime ${state}`}
          </span>
          <span style={{ flex: 1 }} />
          <Button size="sm" onClick={() => openLaunch("newtab")}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {Ico.plus}New agent
            </span>
          </Button>
        </div>
        <p className="mono" style={{ margin: "8px 0 0", fontSize: 11, color: "var(--fg-3)" }}>
          Read from the runtime's Claude config. The account is yours, shown locally; MCP
          credentials (env / headers) are never read.
        </p>
      </div>

      <div className="scroll" style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {!running ? (
          <Note>Runtime not running — no config to read.</Note>
        ) : data === null ? (
          <Note>Reading Claude config…</Note>
        ) : (
          <Body data={data} />
        )}
      </div>
    </main>
  );
}

function Body({ data }: { data: ClaudeIntegrations }) {
  const acct = data.account;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 }}>
      {/* connected account — identity only */}
      <Card title="Connected account">
        {acct ? (
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px" }}>
            <AgentGlyph agent="claude" size={20} color="var(--a-claude)" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 500, color: "var(--fg-0)" }}>
                {acct.name ?? acct.email ?? "Claude"}
              </div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
                {acct.email ?? "—"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 18, flexShrink: 0 }}>
              <Field label="plan" value={acct.plan} />
              <Field label="org" value={acct.org} />
              <Field label="role" value={acct.role} />
            </div>
          </div>
        ) : (
          <Empty>Not signed in — no Claude account found in the runtime's config.</Empty>
        )}
      </Card>

      {/* MCP servers — name / transport / non-secret target */}
      <Card title="MCP servers" count={data.mcpServers.length}>
        {data.mcpServers.length === 0 ? (
          <Empty>
            No MCP servers configured. Add them to ~/.claude.json or a workspace .mcp.json and they
            appear here.
          </Empty>
        ) : (
          <div style={{ padding: "4px 8px" }}>
            {data.mcpServers.map((s) => (
              <div
                key={`${s.scope}/${s.name}`}
                className="rail-file"
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px" }}
              >
                <span
                  style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-0)", flexShrink: 0 }}
                >
                  {s.name}
                </span>
                <Chip>{s.transport}</Chip>
                <Chip muted>{s.scope}</Chip>
                <span
                  className="mono"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: "right",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 11,
                    color: "var(--fg-3)",
                  }}
                  title={s.target ?? undefined}
                >
                  {s.target ?? "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <p className="mono" style={{ margin: "2px 4px", fontSize: 10.5, color: "var(--fg-3)" }}>
        Claude-only: Codex and Antigravity have no readable connection config, so they're not shown
        here rather than guessed.
      </p>
    </div>
  );
}

// ── small presentational helpers ──────────────────────────────────────────

function Card({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="ch-card" style={{ padding: 0, minWidth: 0 }}>
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>{title}</span>
        <span style={{ flex: 1 }} />
        {count !== undefined && (
          <span className="mono tnum" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, textAlign: "right" }}>
      <span className="lbl">{label}</span>
      <span className="mono" style={{ fontSize: 12, color: "var(--fg-0)" }}>
        {value ?? "—"}
      </span>
    </div>
  );
}

function Chip({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      className="mono"
      style={{
        flexShrink: 0,
        fontSize: 9.5,
        padding: "1px 6px",
        borderRadius: 4,
        border: "1px solid var(--bd-soft)",
        color: muted ? "var(--fg-3)" : "var(--fg-2)",
      }}
    >
      {children}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{ padding: "20px 16px", fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.6 }}
    >
      {children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{ padding: "40px 16px", textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}
    >
      {children}
    </div>
  );
}
