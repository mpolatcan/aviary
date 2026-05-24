/**
 * Integrations — external services CodeHub connects to.
 *
 * Two real surfaces, both FACTUAL and presence-only for any credential:
 *
 *  1. GitHub (COMPLETION_PLAN decision 6) — the PAT is a HOST ENV VAR, surfaced
 *     PRESENCE-ONLY. `github_status` reports connected/not + the env var NAME,
 *     plus (when the token is reachable) login / scopes / token-expiry from the
 *     GitHub API. The token VALUE is never read, returned, rendered, or stored;
 *     there is no secret input field and no rotate/disconnect write path (a host
 *     env var is owned by the shell, not by CodeHub). When not connected, the
 *     card is INSTRUCTIONAL — it names the env var to export, never a secret box.
 *     The visible repo list comes from `github_repos`.
 *
 *  2. Claude config (claude_integrations) — the runtime's signed-in account
 *     (oauthAccount in ~/.claude.json, identity only) + configured MCP servers
 *     (name / transport / non-secret target). Secret-bearing MCP fields (env,
 *     headers) are never read by the backend, so never appear here.
 *
 * Everything the design mocks but CodeHub has no source for — other code hosts
 * (GitLab/Bitbucket/…), project trackers (Linear/Jira/…), observability
 * (Sentry/Datadog/…) — renders "Coming soon", never a fabricated "Connected".
 *
 * Claude-only for the agent-config surface: Codex stores auth in a sqlite db and
 * Antigravity has no readable connection config, so neither is surfaced.
 */
import { AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { StatusDot } from "@/app/components/primitives/StatusDot";
import { Tag } from "@/app/components/primitives/Tag";
import { Ico } from "@/app/components/primitives/icons";
import { type ClaudeIntegrations, type GithubRepo, type GithubStatus, ipc } from "@/app/lib/ipc";
import { useLauncher } from "@/app/lib/launcher";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { useEffect, useState } from "react";

export function Integrations() {
  const status = useStore((s) => s.status);
  const openLaunch = useLauncher((s) => s.open);
  const state = status?.state ?? "missing";
  const running = state === "running";

  // GitHub is independent of the runtime container (it's a host env var + the
  // GitHub API), so it loads regardless of container state. Presence-only.
  const githubStatus = useStore((s) => s.githubStatus);
  const githubRepos = useStore((s) => s.githubRepos);
  const loadGithubStatus = useStore((s) => s.loadGithubStatus);
  const loadGithubRepos = useStore((s) => s.loadGithubRepos);
  useEffect(() => {
    void loadGithubStatus();
  }, [loadGithubStatus]);
  // Repos only matter once connected; fetch them when the status flips on.
  useEffect(() => {
    if (githubStatus?.connected) void loadGithubRepos();
  }, [githubStatus?.connected, loadGithubRepos]);

  // One-shot poll (~10s) of the runtime's Claude config; it can change as the
  // user signs in or edits MCP. Alive-guarded — a failed read clears to null so
  // the UI shows an honest note rather than stale data.
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

  const summary = githubStatus?.connected
    ? `GitHub connected${githubStatus.login ? ` · ${githubStatus.login}` : ""}`
    : data
      ? `${data.account ? "1 account" : "no account"} · ${data.mcpServers.length} MCP`
      : `runtime ${state}`;

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
            {summary}
          </span>
          <span style={{ flex: 1 }} />
          <Button size="sm" onClick={() => openLaunch("newtab")}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {Ico.plus}New agent
            </span>
          </Button>
        </div>
        <p className="mono" style={{ margin: "8px 0 0", fontSize: 11, color: "var(--fg-3)" }}>
          Connections are surfaced presence-only — no credential value is read or stored. GitHub
          auth is a host env var; the Claude account + MCP config is read from the runtime
          container.
        </p>
      </div>

      <div className="scroll" style={{ flex: 1, overflow: "auto", padding: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 760 }}>
          {/* GitHub — host env var, presence-only */}
          <section>
            <SectionHead label="Source control" />
            <GitHubCard status={githubStatus} repos={githubRepos} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
              <SoonRow name="GitLab" desc="Self-hosted or saas.gitlab.com" />
              <SoonRow name="Bitbucket" desc="Cloud + Data Center" />
              <SoonRow name="Gitea" desc="Self-hosted" />
              <SoonRow name="Sourcehut" desc="git.sr.ht" />
            </div>
          </section>

          {/* Other categories — no data source yet, honestly "Coming soon" */}
          <section>
            <SectionHead label="Project trackers" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <SoonRow name="Linear" desc="Read issues, comment, transition status" />
              <SoonRow name="Jira" desc="Atlassian cloud + server" />
              <SoonRow name="Notion" desc="Read docs, append to pages" />
              <SoonRow name="Asana" desc="Tasks & projects" />
            </div>
          </section>

          <section>
            <SectionHead label="Observability" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <SoonRow name="Sentry" desc="Pipe runtime errors back to the agent for triage" />
              <SoonRow name="Datadog" desc="Logs, traces, metrics" />
              <SoonRow name="Honeycomb" desc="Distributed traces" />
              <SoonRow name="Grafana" desc="Read panels, query Prometheus" />
            </div>
          </section>

          {/* Runtime Claude config — account + MCP (identity / non-secret only) */}
          <section>
            <SectionHead label="Runtime agent config" />
            {!running ? (
              <ClaudeBody empty="Runtime not running — no Claude config to read." />
            ) : data === null ? (
              <ClaudeBody empty="Reading Claude config…" />
            ) : (
              <ClaudeBody data={data} />
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

// GitHub featured card. Two faithful modes:
//  - connected: green status, env-var-NAME tag, login/expiry line, scope chips
//    (only those the API actually reported), and the visible repo list.
//  - not connected: instructional — names the env var to export. No secret box,
//    no rotate/disconnect (a host env var is owned by the shell).
function GitHubCard({
  status,
  repos,
}: {
  status: GithubStatus | null;
  repos: GithubRepo[];
}) {
  // null = not loaded yet; render a neutral skeleton-ish state, never fake data.
  const connected = status?.connected ?? false;
  const varName = status?.varName ?? "GITHUB_TOKEN";
  return (
    <div className="ch-card" style={{ padding: 0, overflow: "hidden" }}>
      {/* header — connection status (presence-only) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "14px 18px",
          borderBottom: "1px solid var(--bd-soft)",
        }}
      >
        <div
          className="mono"
          style={{
            width: 40,
            height: 40,
            borderRadius: 8,
            background: "var(--bg-0)",
            border: "1px solid var(--bd)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-0)",
            fontWeight: 700,
            fontSize: 17,
          }}
        >
          gh
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-0)" }}>GitHub</span>
            {connected ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 11.5,
                  color: "var(--live)",
                }}
              >
                <StatusDot status="live" /> Connected
              </span>
            ) : (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 11.5,
                  color: "var(--wait)",
                }}
              >
                <StatusDot status="wait" /> Not connected
              </span>
            )}
            <Tag>${varName}</Tag>
          </div>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
            {connected
              ? [
                  status?.login,
                  repos.length ? `${repos.length} repo${repos.length === 1 ? "" : "s"}` : null,
                  status?.tokenExpiry ? `token expires ${fmtExpiry(status.tokenExpiry)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "host token present"
              : `set the ${varName} host env var to connect`}
          </div>
        </div>
      </div>

      {connected ? (
        <>
          {/* scopes granted — only those the API reported; never fabricated */}
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--bd-soft)" }}>
            <div className="lbl" style={{ marginBottom: 8, fontSize: 11 }}>
              Scopes granted
            </div>
            {status && status.scopes.length > 0 ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {status.scopes.map((s) => (
                  <ScopeChip key={s} label={s} />
                ))}
              </div>
            ) : (
              <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
                {status?.tokenExpiry === null && status?.login === null
                  ? "Token reachable, but the API didn't report scopes (fine-grained PATs don't list classic scopes)."
                  : "No scopes reported by the GitHub API for this token."}
              </div>
            )}
            <div className="mono" style={{ marginTop: 8, fontSize: 11, color: "var(--fg-3)" }}>
              Edit scopes on the token at github.com/settings/tokens — CodeHub never reads the
              value, only its presence.
            </div>
          </div>

          {/* repos visible to the connected account */}
          <div style={{ padding: "12px 18px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span className="lbl" style={{ fontSize: 11 }}>
                Available repositories · {repos.length}
              </span>
              <span style={{ flex: 1 }} />
            </div>
            {repos.length === 0 ? (
              <div
                className="mono"
                style={{ fontSize: 11.5, color: "var(--fg-3)", padding: "4px 0" }}
              >
                No repositories returned for this token (it may lack repo scope, or the org has none
                visible).
              </div>
            ) : (
              repos.map((r, i) => (
                <RepoRow key={r.nameWithOwner} repo={r} last={i === repos.length - 1} />
              ))
            )}
          </div>
        </>
      ) : (
        // Not connected → instructional. Names the env var; never a secret box.
        <div style={{ padding: "16px 18px" }}>
          <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--fg-1)", lineHeight: 1.6 }}>
            CodeHub authenticates GitHub through a host environment variable — the same model as the
            agent API keys. It never stores or reads the token value, only whether the variable is
            present.
          </p>
          <div
            className="mono"
            style={{
              padding: "10px 12px",
              background: "var(--bg-0)",
              border: "1px solid var(--bd)",
              borderRadius: 6,
              fontSize: 11.5,
              color: "var(--fg-1)",
              marginBottom: 8,
            }}
          >
            export {varName}=ghp_your_token_here
          </div>
          <p
            className="mono"
            style={{ margin: 0, fontSize: 11, color: "var(--fg-3)", lineHeight: 1.6 }}
          >
            Export it in the shell you launch CodeHub from, then relaunch. A fine-grained PAT with
            contents + pull-requests + issues access lets agents clone, push, and open PRs. Create
            one at github.com/settings/tokens.
          </p>
        </div>
      )}
    </div>
  );
}

function ScopeChip({ label }: { label: string }) {
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 8px",
        borderRadius: 4,
        fontSize: 10.5,
        color: "var(--live)",
        background: "color-mix(in oklab, var(--live) 10%, transparent)",
        border: "1px solid color-mix(in oklab, var(--live) 30%, transparent)",
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--live)" }} />
      {label}
    </span>
  );
}

function RepoRow({ repo, last }: { repo: GithubRepo; last: boolean }) {
  const [owner, name] = repo.nameWithOwner.includes("/")
    ? repo.nameWithOwner.split(/\/(.+)/)
    : ["", repo.nameWithOwner];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 0",
        borderBottom: last ? "none" : "1px solid var(--bd-soft)",
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 4,
          background: "var(--bg-3)",
          color: "var(--fg-1)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {Ico.files}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
          {owner && (
            <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
              {owner}/
            </span>
          )}
          <span
            className="mono"
            style={{
              fontSize: 12.5,
              color: "var(--fg-0)",
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
          {repo.private && <Tag>private</Tag>}
        </div>
        {repo.defaultBranch && (
          <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
            default: {repo.defaultBranch}
          </div>
        )}
      </div>
      <span
        className="mono tnum"
        style={{ fontSize: 11, color: "var(--fg-2)", whiteSpace: "nowrap" }}
      >
        {repo.openPrs == null ? "— PRs" : `${repo.openPrs} PR${repo.openPrs === 1 ? "" : "s"} open`}
      </span>
    </div>
  );
}

// A category row CodeHub can't connect yet. Honest "Coming soon" — never a faked
// connected/disconnected state and never a non-functional "Connect" button.
function SoonRow({ name, desc }: { name: string; desc: string }) {
  return (
    <div
      className="ch-card"
      style={{ padding: 12, display: "flex", alignItems: "center", gap: 12 }}
    >
      <span
        className="mono"
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          background: "var(--bg-3)",
          border: "1px solid var(--bd)",
          color: "var(--fg-2)",
          fontWeight: 700,
          fontSize: 13,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {name[0]}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: "var(--fg-1)", fontWeight: 500 }}>{name}</div>
        <div style={{ fontSize: 11, color: "var(--fg-2)" }}>{desc}</div>
      </div>
      <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", whiteSpace: "nowrap" }}>
        Coming soon
      </span>
    </div>
  );
}

// The runtime's Claude config — account (identity only) + MCP servers (name /
// transport / non-secret target). Either renders real data or an honest note.
function ClaudeBody({ data, empty }: { data?: ClaudeIntegrations; empty?: string }) {
  if (!data) {
    return (
      <div className="ch-card" style={{ padding: 0 }}>
        <Note>{empty ?? "—"}</Note>
      </div>
    );
  }
  const acct = data.account;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* connected account — identity only */}
      <Card title="Connected Claude account">
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

// Format a token-expiry string for the header. Accepts RFC3339 / ISO; falls back
// to the raw string when it isn't a parseable date (never invents one).
function fmtExpiry(s: string): string {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── small presentational helpers ──────────────────────────────────────────

function SectionHead({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 12px" }}>
      <span className="lbl" style={{ color: "var(--fg-1)", fontSize: 11 }}>
        {label}
      </span>
      <span style={{ flex: 1, height: 1, background: "var(--bd-soft)" }} />
    </div>
  );
}

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
      style={{ padding: "28px 16px", textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}
    >
      {children}
    </div>
  );
}
