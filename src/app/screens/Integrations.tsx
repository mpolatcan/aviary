/**
 * Source control — the GitHub connection CodeHub uses to clone, push, and open
 * PRs on the user's behalf. GitHub-only for now (other code hosts are out of
 * scope); rendered as the Settings "Source control" sub-pane.
 *
 * Everything is FACTUAL and presence-only: `github_status` reports connected/not,
 * plus (when reachable) login / scopes / token-expiry from the GitHub API. The
 * token VALUE is never read, returned, or rendered. The visible repo list comes
 * from `github_repos`. Disconnect removes the stored account profile(s)
 * (vault/env) — a shell-exported $GITHUB_TOKEN has no profile, so the UI says so
 * honestly instead of offering an inert button.
 *
 * The runtime's Claude account + MCP servers (claude_integrations) used to live
 * here too; that surface now lives only in Settings → Coding Agents (the agent
 * detail view), where it belongs — it isn't source control.
 */
import { ApiKeyDialog } from "@/app/components/ApiKeyDialog";
import { LoginTerminalDialog } from "@/app/components/LoginTerminalDialog";
import { Segmented } from "@/app/components/primitives/Segmented";
import { StatusDot } from "@/app/components/primitives/StatusDot";
import { Tag } from "@/app/components/primitives/Tag";
import { Tip } from "@/app/components/primitives/Tip";
import { Ico } from "@/app/components/primitives/icons";
import { type GithubRepo, type GithubStatus, ipc } from "@/app/lib/ipc";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { Input } from "@/app/ui/input";
import { useEffect, useMemo, useRef, useState } from "react";

// Rendered as a Settings sub-pane (Settings.tsx → NAV_GROUPS "integrations" key).
// The pane container supplies the scroll + padding, so this returns a fragment
// (header + content), not its own <main>.
export function IntegrationsPane() {
  // GitHub is independent of the runtime container, so it loads regardless of
  // container state. Presence-only.
  const githubStatus = useStore((s) => s.githubStatus);
  const githubRepos = useStore((s) => s.githubRepos);
  const loadGithubStatus = useStore((s) => s.loadGithubStatus);
  const loadGithubRepos = useStore((s) => s.loadGithubRepos);
  const loadAccountProfiles = useStore((s) => s.loadAccountProfiles);
  const connected = Boolean(githubStatus?.connected);
  useEffect(() => {
    void loadGithubStatus();
    // Needed so the connected card can offer a real Disconnect (it removes the
    // GitHub account profile from the vault).
    void loadAccountProfiles();
  }, [loadGithubStatus, loadAccountProfiles]);
  // Repos only matter once connected; fetch them when the status flips on.
  useEffect(() => {
    if (connected) void loadGithubRepos();
  }, [connected, loadGithubRepos]);

  return (
    <>
      <h1
        style={{
          margin: "0 0 4px",
          fontSize: "var(--fs-20)",
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "var(--fg-0)",
        }}
      >
        Source control
      </h1>
      <p
        style={{
          margin: "0 0 28px",
          color: "var(--fg-2)",
          fontSize: "var(--fs-13)",
          maxWidth: 640,
          lineHeight: 1.55,
        }}
      >
        Connect GitHub so agents can clone, branch, push, and open pull requests on your behalf. The
        connection is{" "}
        <strong style={{ color: "var(--fg-1)", fontWeight: 600 }}>presence-only</strong> — CodeHub
        checks that a token exists and reads what GitHub reports about it (login, scopes, expiry),
        but never reads or stores the token value itself.
      </p>

      <GitHubCard status={githubStatus} repos={githubRepos} />
    </>
  );
}

// ── GitHub featured card ────────────────────────────────────────────────────
// connected: green status, login/expiry line, scope chips, capability matrix,
// searchable repo table, and a real Disconnect. Not connected: instructional —
// OAuth / PAT / env-var methods.
function GitHubCard({
  status,
  repos,
}: {
  status: GithubStatus | null;
  repos: GithubRepo[];
}) {
  // null = not loaded yet; render a neutral state, never fake data.
  const connected = status?.connected ?? false;
  const varName = status?.varName ?? "GITHUB_TOKEN";

  const loadGithubRepos = useStore((s) => s.loadGithubRepos);
  const loadGithubStatus = useStore((s) => s.loadGithubStatus);
  const loadAccountProfiles = useStore((s) => s.loadAccountProfiles);
  const removeAccountProfile = useStore((s) => s.removeAccountProfile);
  const githubProfiles = useStore((s) => s.accountProfiles).filter((p) => p.agent === "github");

  // A shell-exported $GITHUB_TOKEN has no stored profile, so there's nothing the
  // app can remove — only vault/env profiles are removable here.
  const removable = githubProfiles.length > 0;
  const methodLabel = removable
    ? githubProfiles.some((p) => p.source === "vault")
      ? "token in vault"
      : `via $${varName}`
    : `via $${varName} (shell)`;

  const [syncing, setSyncing] = useState(false);
  const sync = () => {
    if (syncing) return;
    setSyncing(true);
    void Promise.resolve(loadGithubRepos()).finally(() => setSyncing(false));
  };

  const [disconnecting, setDisconnecting] = useState(false);
  const disconnect = async () => {
    if (disconnecting || !removable) return;
    if (
      !window.confirm(
        "Disconnect GitHub? This removes the stored token from CodeHub's vault. Agents lose clone/push/PR access until you reconnect.",
      )
    )
      return;
    setDisconnecting(true);
    try {
      for (const p of githubProfiles) await removeAccountProfile(p.id);
      await loadGithubStatus();
      await loadAccountProfiles();
    } finally {
      setDisconnecting(false);
    }
  };

  const expiry = expiryInfo(status?.tokenExpiry ?? null);

  return (
    <div className="ch-card" style={{ padding: 0, overflow: "hidden" }}>
      {/* header — connection status (presence-only) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "16px 18px",
          borderBottom: "1px solid var(--bd-soft)",
          background: connected
            ? "linear-gradient(180deg, color-mix(in oklab, var(--live) 5%, var(--bg-2)), var(--bg-2))"
            : "var(--bg-2)",
        }}
      >
        <GitHubMark connected={connected} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <span style={{ fontSize: "var(--fs-16)", fontWeight: 600, color: "var(--fg-0)" }}>
              GitHub
            </span>
            <ConnPill connected={connected} />
            <Tag>${varName}</Tag>
          </div>
          <div className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>
            {connected
              ? [
                  status?.login ? `@${status.login}` : null,
                  repos.length ? `${repos.length} repo${repos.length === 1 ? "" : "s"}` : null,
                  methodLabel,
                ]
                  .filter(Boolean)
                  .join("  ·  ") || "token active"
              : "Not connected — choose a method below."}
          </div>
        </div>
        {connected && expiry && <ExpiryPill text={expiry.text} soon={expiry.soon} />}
        {connected && removable && (
          <Tip text="Remove the stored GitHub token from CodeHub's vault">
            <span style={{ display: "inline-flex" }}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void disconnect()}
                disabled={disconnecting}
                style={{ color: "var(--err)" }}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </Button>
            </span>
          </Tip>
        )}
      </div>

      {connected ? (
        <>
          {/* token-expiry warning — only when GitHub reported a soon-expiring token */}
          {expiry?.soon && (
            <div
              className="mono"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 18px",
                borderBottom: "1px solid var(--bd-soft)",
                background: "color-mix(in oklab, var(--wait) 8%, var(--bg-2))",
                fontSize: "var(--fs-11)",
                color: "var(--wait)",
              }}
            >
              <span style={{ display: "inline-flex" }}>{Ico.bell}</span>
              Token expires {expiry.text} — renew it on github.com/settings/tokens before it lapses.
            </div>
          )}

          {/* capabilities — what agents can do, derived from reported scopes */}
          <GitHubCapabilities status={status} />

          {/* scopes granted — only those the API reported; never fabricated */}
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--bd-soft)" }}>
            <div className="lbl" style={{ marginBottom: 8, fontSize: "var(--fs-11)" }}>
              Scopes granted
            </div>
            {status && status.scopes.length > 0 ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {status.scopes.map((s) => (
                  <ScopeChip key={s} label={s} />
                ))}
              </div>
            ) : (
              <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                {status?.tokenExpiry === null && status?.login === null
                  ? "Token reachable, but the API didn't report scopes (fine-grained PATs don't list classic scopes)."
                  : "No scopes reported by the GitHub API for this token."}
              </div>
            )}
            <div
              className="mono"
              style={{ marginTop: 8, fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
            >
              Edit scopes on the token at github.com/settings/tokens — CodeHub never reads the
              value, only its presence.
            </div>
          </div>

          {/* repositories — searchable / filterable table */}
          <ReposPanel repos={repos} syncing={syncing} onSync={sync} />
        </>
      ) : (
        <GitHubNotConnected varName={varName} />
      )}
    </div>
  );
}

// The GitHub identity tile in the card header. A bold mono "gh" mark; a live ring
// when connected so the status reads even before the pill.
function GitHubMark({ connected }: { connected: boolean }) {
  return (
    <div
      className="mono"
      style={{
        width: 46,
        height: 46,
        borderRadius: 10,
        flexShrink: 0,
        background: "var(--bg-0)",
        border: connected
          ? "1px solid color-mix(in oklab, var(--live) 40%, var(--bd))"
          : "1px solid var(--bd)",
        boxShadow: connected
          ? "0 0 0 3px color-mix(in oklab, var(--live) 12%, transparent)"
          : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--fg-0)",
        fontWeight: 700,
        fontSize: "var(--fs-20)",
        letterSpacing: "-0.02em",
      }}
    >
      gh
    </div>
  );
}

function ConnPill({ connected }: { connected: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 9px",
        borderRadius: 999,
        fontSize: "var(--fs-11)",
        fontWeight: 600,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
        background: connected ? "color-mix(in oklab, var(--live) 12%, transparent)" : "var(--bg-3)",
        color: connected ? "var(--live)" : "var(--wait)",
        border: connected ? "1px solid transparent" : "1px solid var(--bd-soft)",
      }}
    >
      <StatusDot status={connected ? "live" : "wait"} />
      {connected ? "Connected" : "Not connected"}
    </span>
  );
}

function ExpiryPill({ text, soon }: { text: string; soon: boolean }) {
  return (
    <span
      className="mono"
      style={{
        flexShrink: 0,
        fontSize: "var(--fs-11)",
        color: soon ? "var(--wait)" : "var(--fg-2)",
        whiteSpace: "nowrap",
      }}
    >
      expires {text}
    </span>
  );
}

// ── Not-connected: connection methods ───────────────────────────────────────
function GitHubNotConnected({ varName }: { varName: string }) {
  const loadGithubStatus = useStore((s) => s.loadGithubStatus);
  const loadGithubRepos = useStore((s) => s.loadGithubRepos);
  const loadAccountProfiles = useStore((s) => s.loadAccountProfiles);
  const [patDialog, setPatDialog] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  // GitHub OAuth runs `gh auth login --web` in a throwaway login container's tmux
  // session, surfaced through the shared LoginTerminalDialog (same flow as the
  // Claude/Codex sign-ins). The token is captured to the vault on session exit.
  const [terminalDialog, setTerminalDialog] = useState<{
    provider: string;
    profileId: string;
    sessionName: string;
    workspace: string;
  } | null>(null);
  const pendingProfileId = useRef<string | null>(null);

  const startGithubOAuth = async () => {
    setOauthBusy(true);
    setOauthError(null);
    let createdId: string | null = null;
    try {
      const existingIds = new Set(useStore.getState().accountProfiles.map((p) => p.id));
      const list = await ipc.addAccountProfile("github", "GitHub", undefined, "vault");
      useStore.setState({ accountProfiles: list });
      const created = list.find((p) => !existingIds.has(p.id));
      if (!created) throw new Error("profile creation failed");
      createdId = created.id;
      const result = await ipc.vaultInitiateOauth("github", created.id);
      if (result?.sessionName && result?.workspace) {
        pendingProfileId.current = created.id;
        setTerminalDialog({
          provider: "github",
          profileId: created.id,
          sessionName: result.sessionName,
          workspace: result.workspace,
        });
      } else {
        throw new Error("login session did not start");
      }
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*/, "");
      setOauthError(msg);
      if (createdId) {
        void useStore.getState().removeAccountProfile(createdId);
      }
    } finally {
      setOauthBusy(false);
    }
  };

  // Mirror Settings' OAuth completion: on capture, refresh status/repos; on
  // cancel, keep the profile only if a token actually landed, else drop it.
  const handleDialogDone = (result: "captured" | "cancelled") => {
    const pendingId = pendingProfileId.current;
    setTerminalDialog(null);
    pendingProfileId.current = null;
    if (result === "captured") {
      void loadGithubStatus();
      void loadAccountProfiles();
      void loadGithubRepos();
    } else if (pendingId) {
      void (async () => {
        try {
          if (await ipc.vaultHasKey(pendingId)) {
            void loadGithubStatus();
            await loadAccountProfiles();
          } else {
            await useStore.getState().removeAccountProfile(pendingId);
          }
        } catch {
          await useStore.getState().removeAccountProfile(pendingId);
        }
      })();
    }
  };

  return (
    <div style={{ padding: "18px" }}>
      <p
        style={{
          margin: "0 0 14px",
          fontSize: "var(--fs-13)",
          color: "var(--fg-1)",
          lineHeight: 1.6,
        }}
      >
        Connect GitHub so agents can clone, push, and open PRs. Choose one method:
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <Button size="sm" disabled={oauthBusy} onClick={() => void startGithubOAuth()}>
          {oauthBusy ? "Opening browser…" : "Sign in with GitHub"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setPatDialog(true)}>
          Paste a PAT
        </Button>
      </div>

      {oauthError && (
        <div
          className="mono"
          style={{
            marginBottom: 10,
            padding: "8px 12px",
            borderRadius: 6,
            background: "color-mix(in oklab, var(--err) 8%, var(--bg-2))",
            border: "1px solid color-mix(in oklab, var(--err) 30%, var(--bd))",
            fontSize: "var(--fs-12)",
            color: "var(--err)",
          }}
        >
          {oauthError}
        </div>
      )}

      <div
        style={{
          padding: "12px 14px",
          background: "var(--bg-1)",
          border: "1px solid var(--bd-soft)",
          borderRadius: 8,
        }}
      >
        <div className="lbl" style={{ marginBottom: 6, fontSize: "var(--fs-10)" }}>
          or use an environment variable
        </div>
        <div
          className="mono"
          style={{
            padding: "6px 10px",
            background: "var(--bg-0)",
            border: "1px solid var(--bd)",
            borderRadius: 5,
            fontSize: "var(--fs-11)",
            color: "var(--fg-1)",
          }}
        >
          export {varName}=ghp_your_token_here
        </div>
        <p
          className="mono"
          style={{ margin: "8px 0 0", fontSize: "var(--fs-10)", color: "var(--fg-3)" }}
        >
          Export it in your shell before launching CodeHub. Fine-grained PAT with repo + PR access.
        </p>
      </div>

      {terminalDialog && (
        <LoginTerminalDialog
          provider={terminalDialog.provider}
          profileId={terminalDialog.profileId}
          sessionName={terminalDialog.sessionName}
          workspace={terminalDialog.workspace}
          onDone={handleDialogDone}
        />
      )}
      {patDialog && (
        <ApiKeyDialog
          agent="github"
          onClose={() => setPatDialog(false)}
          onSaved={() => {
            void loadGithubStatus();
            void loadAccountProfiles();
          }}
        />
      )}
    </div>
  );
}

// ── Capability matrix ───────────────────────────────────────────────────────
// What agents can actually do, derived from the scopes GitHub reported. Read
// capabilities (clone/fetch) are always available with any valid token; write
// ones depend on scopes.
function GitHubCapabilities({ status }: { status: GithubStatus | null }) {
  const scopes = status?.scopes ?? [];
  const caps: { label: string; ok: boolean }[] = [
    { label: "clone", ok: true },
    { label: "fetch", ok: true },
    { label: "push", ok: hasGithubScope(scopes, ["repo", "public_repo", "contents"]) },
    { label: "open PR", ok: hasGithubScope(scopes, ["repo", "pull_request", "pull_requests"]) },
    { label: "comment issues", ok: hasGithubScope(scopes, ["repo", "issues"]) },
  ];
  return (
    <div
      style={{
        padding: "14px 18px",
        borderBottom: "1px solid var(--bd-soft)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <span className="lbl" style={{ fontSize: "var(--fs-11)", marginRight: 4 }}>
        agents can
      </span>
      {caps.map((c) => (
        <CapabilityChip key={c.label} label={c.label} ok={c.ok} />
      ))}
      <span style={{ flex: 1, minWidth: 12 }} />
      <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
        writes depend on scopes
      </span>
    </div>
  );
}

function CapabilityChip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 999,
        fontSize: "var(--fs-11)",
        color: ok ? "var(--fg-1)" : "var(--fg-3)",
        background: ok ? "color-mix(in oklab, var(--live) 9%, transparent)" : "var(--bg-1)",
        border: ok
          ? "1px solid color-mix(in oklab, var(--live) 26%, transparent)"
          : "1px solid var(--bd-soft)",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ display: "inline-flex", color: ok ? "var(--live)" : "var(--fg-3)" }}>
        {ok ? Ico.check : <span style={{ lineHeight: 1 }}>–</span>}
      </span>
      {label}
    </span>
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
        fontSize: "var(--fs-11)",
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

// ── Repositories panel ──────────────────────────────────────────────────────
// The repos visible to the connected token, with client-side search, a
// visibility filter, and sort. All data is from `github_repos` — filtering/sort
// is purely presentational, never fabricated.
type Vis = "all" | "public" | "private";
type SortKey = "active" | "name";

function ReposPanel({
  repos,
  syncing,
  onSync,
}: {
  repos: GithubRepo[];
  syncing: boolean;
  onSync: () => void;
}) {
  const [q, setQ] = useState("");
  const [vis, setVis] = useState<Vis>("all");
  const [sort, setSort] = useState<SortKey>("active");

  const privateCount = repos.filter((r) => r.private).length;
  const prTotal = repos.reduce((n, r) => n + (r.openPrs ?? 0), 0);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = repos.filter((r) => {
      if (vis === "public" && r.private) return false;
      if (vis === "private" && !r.private) return false;
      if (needle && !r.nameWithOwner.toLowerCase().includes(needle)) return false;
      return true;
    });
    return [...list].sort((a, b) => {
      if (sort === "name") return a.nameWithOwner.localeCompare(b.nameWithOwner);
      const pa = a.openPrs ?? -1;
      const pb = b.openPrs ?? -1;
      if (pb !== pa) return pb - pa;
      return a.nameWithOwner.localeCompare(b.nameWithOwner);
    });
  }, [repos, q, vis, sort]);

  return (
    <div style={{ padding: "14px 18px" }}>
      {/* header row: title + stats + sync */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span className="lbl" style={{ fontSize: "var(--fs-11)" }}>
          Repositories
        </span>
        <span className="mono tnum" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
          {repos.length} total · {privateCount} private · {prTotal} open PR
          {prTotal === 1 ? "" : "s"}
        </span>
        <span style={{ flex: 1 }} />
        <Tip text="Re-fetch repositories visible to this token">
          <span style={{ display: "inline-flex" }}>
            <Button
              variant="outline"
              size="xs"
              onClick={onSync}
              disabled={syncing}
              className="font-mono"
            >
              {syncing ? "Syncing…" : "Sync"}
            </Button>
          </span>
        </Tip>
      </div>

      {/* toolbar: search + visibility + sort */}
      {repos.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 4,
            flexWrap: "wrap",
          }}
        >
          <div style={{ position: "relative", flex: "1 1 200px", minWidth: 160 }}>
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 9,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--fg-3)",
                display: "inline-flex",
                pointerEvents: "none",
              }}
            >
              {Ico.search}
            </span>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter repositories…"
              spellCheck={false}
              className="font-mono h-auto"
              style={{ paddingLeft: 30, fontSize: "var(--fs-12)" }}
            />
          </div>
          <Segmented<Vis>
            value={vis}
            onChange={setVis}
            options={[
              { key: "all", label: "All" },
              { key: "public", label: "Public" },
              { key: "private", label: "Private" },
            ]}
          />
          <Segmented<SortKey>
            value={sort}
            onChange={setSort}
            options={[
              { key: "active", label: "Active" },
              { key: "name", label: "Name" },
            ]}
          />
        </div>
      )}

      {/* list */}
      {repos.length === 0 ? (
        <div
          className="mono"
          style={{ fontSize: "var(--fs-12)", color: "var(--fg-3)", padding: "8px 0" }}
        >
          No repositories returned for this token (it may lack repo scope, or the org has none
          visible).
        </div>
      ) : filtered.length === 0 ? (
        <div
          className="mono"
          style={{ fontSize: "var(--fs-12)", color: "var(--fg-3)", padding: "8px 0" }}
        >
          No repositories match “{q}”.
        </div>
      ) : (
        <div style={{ marginTop: 4 }}>
          {filtered.map((r, i) => (
            <RepoRow key={r.nameWithOwner} repo={r} last={i === filtered.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function RepoRow({ repo, last }: { repo: GithubRepo; last: boolean }) {
  const [owner, name] = repo.nameWithOwner.includes("/")
    ? repo.nameWithOwner.split(/\/(.+)/)
    : ["", repo.nameWithOwner];
  return (
    <div
      className="hov-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 8px",
        margin: "0 -8px",
        borderRadius: 6,
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
            <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>
              {owner}/
            </span>
          )}
          <span
            className="mono"
            style={{
              fontSize: "var(--fs-13)",
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
          <div
            className="mono"
            style={{
              fontSize: "var(--fs-11)",
              color: "var(--fg-3)",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span style={{ display: "inline-flex", transform: "scale(0.85)" }}>{Ico.branch}</span>
            {repo.defaultBranch}
          </div>
        )}
      </div>
      <span
        className="mono tnum"
        style={{
          fontSize: "var(--fs-11)",
          color: repo.openPrs ? "var(--fg-1)" : "var(--fg-3)",
          whiteSpace: "nowrap",
        }}
      >
        {repo.openPrs == null ? "— PRs" : `${repo.openPrs} PR${repo.openPrs === 1 ? "" : "s"} open`}
      </span>
    </div>
  );
}

// ── Token-expiry helper ─────────────────────────────────────────────────────
// Accepts RFC3339 / ISO; falls back to the raw string when unparseable (never
// invents a date). `soon` = within a week, used to surface a renewal nudge.
function expiryInfo(s: string | null): { text: string; soon: boolean } | null {
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return { text: s, soon: false };
  const days = Math.ceil((t - Date.now()) / 86_400_000);
  const text = new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { text, soon: days <= 7 };
}

function hasGithubScope(scopes: string[], needles: string[]): boolean {
  const normalized = scopes.map((s) => s.toLowerCase().replace(/[\s:.-]+/g, "_"));
  return needles.some((needle) => normalized.some((scope) => scope.includes(needle)));
}
