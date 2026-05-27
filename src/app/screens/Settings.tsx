/**
 * Settings — sectioned left-nav + right pane. Ported from design/screens/settings.jsx.
 *
 * Every pane is now ported and reads real data:
 *  - Agents & API keys: versions from `agent_versions`, connection state from
 *    `agent_key_status` (host-env presence, never the value); default agent is
 *    live (config store → launcher); "Stop all" is real (closeAllSessions).
 *  - Container runtime / Repositories: live `docker_*` / git reads.
 *  - Appearance: theme (useTheme) + terminal font size (config store → panes) +
 *    density (config store → data-density on <html> → compact chrome).
 *  - General: "confirm before closing a running agent" (config store + ⌘W guard)
 *    + Startup restore/reopen (config store → boot lifecycle session adoption).
 *  - Notifications: the three prefs persist for real (config store); OS delivery
 *    isn't wired yet, stated honestly in the pane (no fabricated capability).
 *  - About: build/host identity from `app_info` / `docker_info`; update status
 *    from `check_update` (honest "up to date" — the updater plugin isn't wired,
 *    so `available` is null and there is no in-app install).
 *
 * The persisted preferences live in the config store (config::Settings, written
 * to settings.json) — get/set via `ipc.getConfig`/`setConfig`, surfaced through
 * the store's `config` + `updateConfig`. Controls whose feature isn't built yet
 * (per-agent permissions, cost/context budgets) render disabled until they wire.
 *
 * Copy note: keys are forwarded from the host environment, NOT an OS keychain —
 * wording corrected from the design.
 */
import { SHORTCUT_GROUPS } from "@/app/components/hub/Shortcuts";
import { AGENT_META, AgentGlyph, type AgentId } from "@/app/components/primitives/AgentGlyph";
import { Logo } from "@/app/components/primitives/Logo";
import { Segmented } from "@/app/components/primitives/Segmented";
import { StatusDot } from "@/app/components/primitives/StatusDot";
import { Tag } from "@/app/components/primitives/Tag";
import { Ico } from "@/app/components/primitives/icons";
import { CLIS } from "@/app/lib/catalog";
import {
  type AgentCli,
  type AgentVersion,
  type AppInfo,
  type AppSettings,
  type AuthProgress,
  type Cli,
  type DockerInfo,
  type GitStatus,
  type ImageInfo,
  type MountInfo,
  type RuntimeHealth,
  ipc,
  onAuthProgress,
} from "@/app/lib/ipc";
import { activeWorkspace, useStore } from "@/app/lib/store";
import { type Theme, useTheme } from "@/app/lib/theme";
import { Button } from "@/app/ui/button";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { ApiKeyDialog } from "../components/ApiKeyDialog";
import { LoginTerminalDialog } from "../components/LoginTerminalDialog";
import { AgentDetail } from "./AgentDetail";
import { IntegrationsPane } from "./Integrations";

export interface SettingsProps {
  /** Kill every running session. Defaults to the store's closeAllSessions. */
  onStopAll?: () => void;
  /** Dev preview hook: open Agents directly on one agent's factual detail view. */
  initialAgentDetail?: AgentCli;
}

const NAV_GROUPS: { label: string; items: { key: string; label: string; soon?: boolean }[] }[] = [
  {
    label: "Workspace",
    items: [
      { key: "general", label: "General" },
      { key: "agents", label: "Agents & API keys" },
      { key: "runtime", label: "Container runtime" },
      { key: "integrations", label: "Integrations" },
      { key: "repos", label: "Repositories" },
      { key: "platform", label: "Platform" },
    ],
  },
  {
    label: "Experience",
    items: [
      { key: "shortcuts", label: "Keyboard shortcuts" },
      { key: "notifications", label: "Notifications" },
      { key: "appearance", label: "Appearance" },
    ],
  },
  {
    label: "Account",
    items: [
      { key: "billing", label: "Usage & billing", soon: true },
      { key: "team", label: "Team", soon: true },
    ],
  },
  {
    label: "About",
    items: [{ key: "about", label: "About CodeHub" }],
  },
];

export function Settings({ onStopAll, initialAgentDetail }: SettingsProps) {
  // Every pane is now ported. Panes with a real backend (Agents, Container
  // runtime, Repositories, Keyboard shortcuts, Appearance, About) show live
  // data; the rest (General, Notifications) render honest disabled controls
  // until the Tier-2 config store lands (BACKEND_PLAN.md).
  // Active sub-pane is lifted to the store so other surfaces can deep-link into a
  // pane (the sidebar's "Integrations" entry, Welcome's "From GitHub" card, the
  // palette's GitHub repo rows) by setting it before navigating to Settings.
  const active = useStore((s) => s.settingsSection);
  const setActive = useStore((s) => s.setSettingsSection);
  const agentVersions = useStore((s) => s.agentVersions);
  const dockerInfo = useStore((s) => s.dockerInfo);

  // App/platform identity is static (build + host consts), so fetch it once.
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let alive = true;
    ipc
      .appInfo()
      .then((info) => alive && setAppInfo(info))
      .catch(() => alive && setAppInfo(null));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main
      style={{
        flex: 1,
        display: "flex",
        background: "var(--bg-1)",
        minWidth: 0,
        height: "100%",
        color: "var(--fg-1)",
      }}
    >
      {/* settings nav */}
      <nav
        style={{
          width: 220,
          flexShrink: 0,
          background: "var(--bg-1)",
          borderRight: "1px solid var(--bd-soft)",
          padding: "20px 12px",
          overflow: "auto",
        }}
      >
        <h2 style={{ margin: "0 6px 14px", fontSize: 17, fontWeight: 600, color: "var(--fg-0)" }}>
          Settings
        </h2>
        {NAV_GROUPS.map((group) => (
          <div key={group.label} style={{ marginBottom: 14 }}>
            <div className="lbl" style={{ padding: "0 6px 4px" }}>
              {group.label}
            </div>
            {group.items.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => !item.soon && setActive(item.key)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  textAlign: "left",
                  padding: "7px 10px",
                  borderRadius: 6,
                  border: "none",
                  fontSize: 12.5,
                  fontFamily: "var(--sans)",
                  color: item.soon
                    ? "var(--fg-3)"
                    : active === item.key
                      ? "var(--fg-0)"
                      : "var(--fg-1)",
                  background: active === item.key ? "var(--bg-3)" : "transparent",
                  cursor: item.soon ? "default" : "pointer",
                  marginBottom: 1,
                }}
              >
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.soon && (
                  <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-3)" }}>
                    soon
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* pane */}
      <div style={{ flex: 1, overflow: "auto", padding: "24px 32px" }}>
        {active === "agents" ? (
          <AgentsPane onStopAll={onStopAll} initialDetail={initialAgentDetail} />
        ) : active === "runtime" ? (
          <RuntimePane dockerInfo={dockerInfo} />
        ) : active === "integrations" ? (
          <IntegrationsPane />
        ) : active === "repos" ? (
          <ReposPane />
        ) : active === "platform" ? (
          <PlatformPane appInfo={appInfo} />
        ) : active === "shortcuts" ? (
          <ShortcutsPane />
        ) : active === "notifications" ? (
          <NotificationsPane />
        ) : active === "appearance" ? (
          <AppearancePane />
        ) : active === "about" ? (
          <AboutPane appInfo={appInfo} dockerInfo={dockerInfo} agentVersions={agentVersions} />
        ) : (
          <GeneralPane />
        )}
      </div>
    </main>
  );
}

// Page header shared by every pane: title + lead paragraph, capped width.
function PaneHead({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h1
        style={{
          margin: "0 0 4px",
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "var(--fg-0)",
        }}
      >
        {title}
      </h1>
      <p style={{ margin: "0 0 28px", color: "var(--fg-2)", fontSize: 13 }}>{children}</p>
    </>
  );
}

// Agents & API keys — REAL Tier-1 data (versions + host-env key presence).
// Default agent is live (config store); the approve/budget controls stay
// disabled until per-agent permissions land; "Stop all" is real (closeAllSessions).
function AgentsPane({
  onStopAll,
  initialDetail,
}: {
  onStopAll?: () => void;
  initialDetail?: AgentCli;
}) {
  const keyStatus = useStore((s) => s.keyStatus);
  const agentVersions = useStore((s) => s.agentVersions);
  const sessionCount = useStore((s) => Object.keys(s.sessionMeta).length);
  const closeAllSessions = useStore((s) => s.closeAllSessions);
  const [detail, setDetail] = useState<AgentCli | null>(initialDetail ?? null);

  const stopAll = () => {
    if (sessionCount === 0) return;
    if (!window.confirm(`Stop all ${sessionCount} running session(s)? Scrollback is kept.`)) return;
    (onStopAll ?? (() => void closeAllSessions()))();
  };

  if (detail)
    return <AgentDetail agent={detail} onBack={() => setDetail(null)} onSwitch={setDetail} />;

  return (
    <div style={{ maxWidth: 720 }}>
      <PaneHead title="Agents & API keys">
        Configure the coding agents available in the spawn dialog. Keys are read from your host
        environment (e.g. <span className="mono">CLAUDE_CODE_OAUTH_TOKEN</span>) and forwarded into
        running containers — CodeHub never stores them.
      </PaneHead>

      <SectionHead label="Agents" />
      {CLIS.map((c) => {
        // Real Tier-1 reads; null until the bootstrap fetch resolves (or if a
        // binary/key is absent — then version/varName render as em-dash).
        const key = keyStatus?.[c.id];
        const ver = agentVersions?.[c.id];
        return (
          <AgentRow
            key={c.id}
            agent={c.id}
            name={c.label}
            version={ver?.version ?? null}
            present={key?.present ?? false}
            varName={key?.varName ?? null}
            source={key?.source ?? null}
            onConfigure={() => setDetail(c.id)}
          />
        );
      })}

      <div style={{ display: "flex", gap: 8, margin: "14px 0 32px" }}>
        <Button variant="outline" size="sm" disabled>
          {Ico.plus}Add custom agent
        </Button>
        <RefreshVersionsButton />
      </div>

      <VaultAuthSection />

      <AccountsSection />

      <SectionHead label="Defaults for new sessions" />
      {/* Default agent is live (config store → launcher pre-selection). The
          approve/budget controls have no agent-level hook yet, so they stay
          disabled rather than faking persistence. */}
      <SettingRow
        label="Default agent"
        desc="Pre-selected in the spawn dialog (⌘N)."
        control={<DefaultAgentSelect />}
        live
      />
      <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--fg-2)" }}>
        The controls below aren't wired yet — they arrive with per-agent permission settings.
      </p>
      <SettingRow
        label="Auto-approve safe commands"
        desc="Read-only operations (ls, cat, git status) run without prompting."
        control={<Toggle on />}
      />
      <SettingRow
        label="Approve writes"
        desc="Always ask before edits, branch ops, or shell execution."
        control={<Toggle on />}
      />
      <SettingRow
        label="Cost budget per turn"
        desc="Auto-pause when a turn exceeds this. 0 disables."
        control={<InputStub value="$1.00" suffix="USD" />}
      />
      <SettingRow
        label="Context budget"
        desc="Stop loading more context once this fills."
        control={<InputStub value="800k" suffix="tokens" />}
        last
      />

      <SectionHead label="Danger zone" tone="err" />
      <div
        className="ch-card"
        style={{
          padding: 14,
          borderColor: "color-mix(in oklab, var(--err) 30%, var(--bd))",
          background: "color-mix(in oklab, var(--err) 4%, var(--bg-2))",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>
              Stop all running agents
            </div>
            <div style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
              SIGTERMs every session and persists their tmux scrollback.
              {sessionCount > 0 ? ` ${sessionCount} running.` : " None running."}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <Button variant="destructive" size="sm" onClick={stopAll} disabled={sessionCount === 0}>
            Stop all
          </Button>
        </div>
      </div>
    </div>
  );
}

// Vault-backed credential management: "Sign in" (container-mediated login)
// or "Add key" (paste) per built-in agent. Stored in OS keychain, never on disk.
function VaultAuthSection() {
  const profiles = useStore((s) => s.accountProfiles);
  const loadAccountProfiles = useStore((s) => s.loadAccountProfiles);
  const removeAccountProfile = useStore((s) => s.removeAccountProfile);
  const [keyDialog, setKeyDialog] = useState<string | null>(null);
  const [profileLabel, setProfileLabel] = useState("");
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginProgress, setLoginProgress] = useState<AuthProgress | null>(null);
  // Active terminal dialog: set when a login session is ready.
  const [terminalDialog, setTerminalDialog] = useState<{
    provider: string;
    profileId: string;
    sessionName: string;
    workspace: string;
  } | null>(null);
  // Profile id to clean up if login is cancelled.
  const pendingProfileId = useRef<string | null>(null);

  const vaultProfiles = profiles.filter((p) => p.source === "vault");
  const defaultLoginLabel = (provider: string) =>
    provider === "github"
      ? "GitHub"
      : provider === "codex"
        ? "Codex"
        : provider === "antigravity"
          ? "Antigravity"
          : "Claude";

  useEffect(() => {
    let unsub: (() => void) | null = null;
    onAuthProgress((p) => {
      setLoginProgress(p);
      if (p.stage === "success") {
        setLoginBusy(null);
        setLoginError(null);
        setProfileLabel("");
        void loadAccountProfiles();
        setTimeout(() => setLoginProgress(null), 3000);
      } else if (p.stage === "error") {
        setLoginBusy(null);
        setLoginError(p.message ?? "Login failed");
      }
    }).then((u) => {
      unsub = u;
    });
    return () => unsub?.();
  }, [loadAccountProfiles]);

  const startLogin = async (provider: string, agent: string) => {
    setLoginBusy(provider);
    setLoginError(null);
    setLoginProgress(null);
    let createdId: string | null = null;
    try {
      const label = profileLabel.trim() || defaultLoginLabel(provider);
      const existingIds = new Set(profiles.map((p) => p.id));
      const list = await ipc.addAccountProfile(agent, label, undefined, "vault");
      useStore.setState({ accountProfiles: list });
      const created = list.find((p) => !existingIds.has(p.id));
      if (!created) throw new Error("profile creation failed");
      createdId = created.id;

      const result = await ipc.vaultInitiateOauth(provider, created.id);

      if (result?.sessionName && result?.workspace) {
        // Open the inline terminal dialog. Dialog handles attach + capture.
        pendingProfileId.current = created.id;
        setTerminalDialog({
          provider,
          profileId: created.id,
          sessionName: result.sessionName,
          workspace: result.workspace,
        });
        setLoginBusy(null);
      }
      // GitHub: device flow runs in background, auth-progress events carry status.
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*/, "");
      setLoginError(msg);
      setLoginBusy(null);
      if (createdId) {
        void useStore.getState().removeAccountProfile(createdId);
      }
    }
  };

  const handleDialogDone = (result: "captured" | "cancelled") => {
    const pendingId = pendingProfileId.current;
    setTerminalDialog(null);
    pendingProfileId.current = null;
    if (result === "captured") {
      setProfileLabel("");
      void loadAccountProfiles();
    } else if (pendingId) {
      void (async () => {
        try {
          if (await ipc.vaultHasKey(pendingId)) {
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
    <>
      <SectionHead label="Credential vault" />
      <p style={{ margin: "0 0 12px", fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.5 }}>
        Store credentials in your OS keychain so they persist across sessions without exporting env
        vars. Each workspace picks which account to use at creation time.
      </p>
      <p style={{ margin: "0 0 12px", fontSize: 11, color: "var(--fg-3)", lineHeight: 1.45 }}>
        Codex device sign-in requires ChatGPT Settings &gt; Security &gt; Enable device code
        authorization for Codex. If your workspace manages this setting, an admin must enable it.
      </p>

      <div style={{ marginBottom: 10 }}>
        <Field label="Profile name">
          <input
            value={profileLabel}
            onChange={(e) => setProfileLabel(e.target.value)}
            placeholder="Work"
            disabled={loginBusy != null}
            spellCheck={false}
            style={{ ...inputStyle, minWidth: 240 }}
          />
        </Field>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <Button
          variant="outline"
          size="sm"
          disabled={loginBusy != null}
          onClick={() => startLogin("claude", "claude")}
        >
          {loginBusy === "claude" ? "Signing in..." : "Sign in with Claude"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={loginBusy != null}
          onClick={() => startLogin("codex", "codex")}
        >
          {loginBusy === "codex" ? "Signing in..." : "Sign in with Codex"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={loginBusy != null}
          onClick={() => startLogin("antigravity", "antigravity")}
        >
          {loginBusy === "antigravity" ? "Signing in..." : "Sign in with Antigravity"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={loginBusy != null}
          onClick={() => startLogin("github", "github")}
        >
          {loginBusy === "github" ? "Signing in..." : "Sign in with GitHub"}
        </Button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <Button variant="ghost" size="sm" onClick={() => setKeyDialog("codex")}>
          Paste OpenAI key
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setKeyDialog("antigravity")}>
          Paste Google key
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setKeyDialog("github")}>
          Paste GitHub PAT
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setKeyDialog("claude")}>
          Paste Claude token
        </Button>
      </div>

      {loginProgress && loginProgress.stage !== "success" && (
        <div
          className="ch-card mono"
          style={{
            padding: "10px 14px",
            marginBottom: 10,
            fontSize: 11.5,
            color: loginProgress.stage === "error" ? "var(--err)" : "var(--fg-1)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {loginProgress.stage === "starting" && (
              <span style={{ color: "var(--fg-2)" }}>Starting...</span>
            )}
            {loginProgress.stage === "url" && (
              <span>Browser opened — authenticate to continue</span>
            )}
            {loginProgress.stage === "device_code" && <span>Enter code in your browser:</span>}
            {loginProgress.stage === "waiting" && (
              <span style={{ color: "var(--fg-2)" }}>Waiting for authentication...</span>
            )}
            {loginProgress.stage === "error" && <span>{loginProgress.message}</span>}
          </div>
          {loginProgress.userCode && (
            <div
              style={{
                padding: "6px 12px",
                background: "var(--bg-0)",
                border: "1px solid var(--bd)",
                borderRadius: 6,
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: "0.15em",
                color: "var(--fg-0)",
                textAlign: "center",
              }}
            >
              {loginProgress.userCode}
            </div>
          )}
          {loginProgress.url && loginProgress.stage !== "error" && (
            <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{loginProgress.url}</div>
          )}
          {loginProgress.message && loginProgress.stage !== "error" && (
            <div style={{ fontSize: 10.5, color: "var(--fg-2)" }}>{loginProgress.message}</div>
          )}
        </div>
      )}

      {loginProgress?.stage === "success" && (
        <div
          className="mono"
          style={{
            marginBottom: 10,
            padding: "8px 12px",
            borderRadius: 6,
            background: "color-mix(in oklab, var(--live) 8%, var(--bg-2))",
            border: "1px solid color-mix(in oklab, var(--live) 30%, var(--bd))",
            fontSize: 11.5,
            color: "var(--live)",
          }}
        >
          {loginProgress.message ?? "Signed in successfully"}
        </div>
      )}

      {loginError && !loginProgress && (
        <div
          className="mono"
          style={{
            marginBottom: 10,
            padding: "8px 12px",
            borderRadius: 6,
            background: "color-mix(in oklab, var(--err) 8%, var(--bg-2))",
            border: "1px solid color-mix(in oklab, var(--err) 30%, var(--bd))",
            fontSize: 11.5,
            color: "var(--err)",
          }}
        >
          {loginError}
        </div>
      )}

      {vaultProfiles.length > 0 && (
        <div className="ch-card" style={{ padding: 0, marginBottom: 12 }}>
          {vaultProfiles.map((p, i) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 14px",
                borderBottom: i === vaultProfiles.length - 1 ? "none" : "1px solid var(--bd-soft)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: p.present ? "var(--live)" : "var(--err)",
                  flexShrink: 0,
                }}
                title={p.present ? "stored in keychain" : "not in keychain"}
              />
              <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-0)" }}>
                {p.label}
              </span>
              <Tag>{p.agent}</Tag>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
                keychain
              </span>
              {!p.present && (
                <span className="mono" style={{ fontSize: 10.5, color: "var(--err)" }}>
                  missing from keychain
                </span>
              )}
              <span style={{ flex: 1 }} />
              <Button
                variant="outline"
                size="xs"
                onClick={() => void removeAccountProfile(p.id)}
                aria-label={`Remove ${p.label}`}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}

      {keyDialog && (
        <ApiKeyDialog
          agent={keyDialog}
          onClose={() => setKeyDialog(null)}
          onSaved={() => void loadAccountProfiles()}
        />
      )}

      {terminalDialog && (
        <LoginTerminalDialog
          provider={terminalDialog.provider}
          profileId={terminalDialog.profileId}
          sessionName={terminalDialog.sessionName}
          workspace={terminalDialog.workspace}
          onDone={handleDialogDone}
        />
      )}
    </>
  );
}

// Accounts — env-backed label-only profiles (legacy Tier-3). Each maps an agent
// to a host env var NAME. The credential value is never stored or read, only
// its presence is probed. Vault-backed profiles are managed above.
function AccountsSection() {
  const allProfiles = useStore((s) => s.accountProfiles);
  const profiles = allProfiles.filter((p) => p.source !== "vault");
  const loadAccountProfiles = useStore((s) => s.loadAccountProfiles);
  const addAccountProfile = useStore((s) => s.addAccountProfile);
  const removeAccountProfile = useStore((s) => s.removeAccountProfile);

  const [agent, setAgent] = useState<AgentCli>("claude");
  const [label, setLabel] = useState("");
  const [varName, setVarName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadAccountProfiles();
  }, [loadAccountProfiles]);

  const canAdd = label.trim() !== "" && varName.trim() !== "" && !busy;
  const add = async () => {
    setError(null);
    setBusy(true);
    try {
      await addAccountProfile(agent, label.trim(), varName.trim());
      setLabel("");
      setVarName("");
    } catch (e) {
      // The backend rejects empty labels + invalid env names with a message.
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHead label="Accounts" />
      <p style={{ margin: "0 0 12px", fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.5 }}>
        Run an agent under a second login by pointing it at another host environment variable.
        CodeHub stores the variable <strong>name</strong> only — never the credential. Export the
        variable in your shell, then pick the account in the spawn dialog.
      </p>

      {profiles.length > 0 && (
        <div className="ch-card" style={{ padding: 0, marginBottom: 12 }}>
          {profiles.map((p, i) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 14px",
                borderBottom: i === profiles.length - 1 ? "none" : "1px solid var(--bd-soft)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: p.present ? "var(--live)" : "var(--err)",
                  flexShrink: 0,
                }}
                title={p.present ? "credential available" : "credential missing"}
              />
              <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-0)" }}>
                {p.label}
              </span>
              <Tag>{p.agent}</Tag>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
                {p.source === "vault" ? "keychain" : p.varName}
              </span>
              {!p.present && (
                <span className="mono" style={{ fontSize: 10.5, color: "var(--err)" }}>
                  {p.source === "vault" ? "not in keychain" : "not set on host"}
                </span>
              )}
              <span style={{ flex: 1 }} />
              <Button
                variant="outline"
                size="xs"
                onClick={() => void removeAccountProfile(p.id)}
                aria-label={`Remove ${p.label}`}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="ch-card" style={{ padding: 14 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field label="Agent">
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value as AgentCli)}
              className="mono"
              style={selectStyle}
            >
              {CLIS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Work"
              spellCheck={false}
              style={inputStyle}
            />
          </Field>
          <Field label="Host env var">
            <input
              value={varName}
              onChange={(e) => setVarName(e.target.value.toUpperCase())}
              placeholder="CLAUDE_TOKEN_WORK"
              spellCheck={false}
              className="mono"
              style={{ ...inputStyle, minWidth: 220 }}
            />
          </Field>
          <Button size="sm" disabled={!canAdd} onClick={() => void add()}>
            {Ico.plus}Add account
          </Button>
        </div>
        {error && <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--err)" }}>{error}</div>}
      </div>
      <div style={{ height: 24 }} />
    </>
  );
}

// Small labelled field wrapper for the inline account form.
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="lbl">{label}</span>
      {children}
    </div>
  );
}

const inputStyle: CSSProperties = {
  background: "var(--bg-0)",
  border: "1px solid var(--bd)",
  borderRadius: 6,
  padding: "7px 10px",
  fontSize: 12,
  color: "var(--fg-1)",
  outline: "none",
  fontFamily: "var(--sans)",
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

// About pane — every value is real: version/os/arch from `app_info` (build +
// host consts), Docker from `docker_info`, agent versions from `agent_versions`,
// update status from `check_update`. No changelog, no fabricated build metadata;
// absent reads render as em-dash. The update check is honest: the updater plugin
// isn't wired (available is null today), so it reads "up to date" with no in-app
// install affordance — never a fabricated release.
function AboutPane({
  appInfo,
  dockerInfo,
  agentVersions,
}: {
  appInfo: AppInfo | null;
  dockerInfo: DockerInfo | null;
  agentVersions: Record<AgentCli, AgentVersion> | null;
}) {
  const dash = "—";
  const platform = appInfo ? `${appInfo.os}-${appInfo.arch}` : dash;
  const dockerLine = dockerInfo?.reachable ? (dockerInfo.version ?? "reachable") : "not reachable";
  return (
    <div style={{ maxWidth: 720 }}>
      <h1
        style={{
          margin: "0 0 4px",
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "var(--fg-0)",
        }}
      >
        About CodeHub
      </h1>
      <p style={{ margin: "0 0 28px", color: "var(--fg-2)", fontSize: 13 }}>
        Build and host platform details for this install. Everything here is read from the running
        binary and the local Docker daemon.
      </p>

      {/* hero */}
      <div
        className="ch-card"
        style={{ padding: 18, display: "flex", alignItems: "center", gap: 16, marginBottom: 8 }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 12,
            background: "var(--bg-0)",
            border: "1px solid var(--bd)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Logo size={30} withText={false} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>CodeHub</div>
          <div
            className="mono"
            style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 3, display: "flex", gap: 8 }}
          >
            <span>v{appInfo?.version ?? dash}</span>
            <span style={{ color: "var(--fg-3)" }}>·</span>
            <span>{platform}</span>
          </div>
        </div>
        <UpdateBadge fallbackVersion={appInfo?.version ?? null} />
      </div>

      <UpdateRow />

      <SectionHead label="Environment" />
      <div
        className="ch-card"
        style={{
          padding: 16,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "10px 24px",
        }}
      >
        <Kv k="Version" v={appInfo ? `v${appInfo.version}` : dash} />
        <Kv k="Docker" v={dockerLine} />
        <Kv k="OS" v={appInfo?.os ?? dash} />
        <Kv k="Architecture" v={appInfo?.arch ?? dash} />
        <Kv k="Family" v={appInfo?.family ?? dash} />
        <Kv k="Docker API" v={dockerInfo?.apiVersion ?? dash} />
      </div>

      <SectionHead label="Agents" />
      <div className="ch-card" style={{ padding: 16, display: "grid", gap: "10px 24px" }}>
        {CLIS.map((c) => (
          <Kv key={c.id} k={c.label} v={agentVersions?.[c.id]?.version || "not installed"} />
        ))}
      </div>

      <SectionHead label="Credits" />
      <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.6 }}>
        CodeHub runs Claude Code, Codex, and Antigravity side by side in workspace containers. Built
        with Tauri, React, and xterm.js. Agent CLIs and their model providers are owned by their
        respective vendors.
      </p>
    </div>
  );
}

// Compact hero badge reflecting the update check. Honest by construction: the
// backend's check_update returns available:null today (the Tauri updater plugin
// isn't wired — Platform pane marks self-update "planned"), so this reads
// "up to date" rather than inventing a release. When a newer version IS reported
// it surfaces it; nothing here is fabricated.
function UpdateBadge({ fallbackVersion }: { fallbackVersion: string | null }) {
  const update = useStore((s) => s.updateStatus);
  if (!update) return null;
  const hasUpdate = update.available != null;
  const color = hasUpdate ? "var(--wait)" : "var(--live)";
  return (
    <div
      className="mono"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 1,
        padding: "6px 10px",
        borderRadius: 6,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 35%, transparent)`,
        color,
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 11 }}>{hasUpdate ? "update available" : "up to date"}</span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>
        v{hasUpdate ? update.available : (update.current ?? fallbackVersion ?? "—")}
      </span>
    </div>
  );
}

// Update-check row: triggers check_update on mount + on demand. The install
// affordance only appears when a newer version is actually reported; today the
// backend has no updater wired so it stays honest ("up to date", no install).
function UpdateRow() {
  const update = useStore((s) => s.updateStatus);
  const loadUpdateStatus = useStore((s) => s.loadUpdateStatus);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void loadUpdateStatus();
  }, [loadUpdateStatus]);
  const check = async () => {
    setBusy(true);
    try {
      await loadUpdateStatus();
    } finally {
      setBusy(false);
    }
  };
  const hasUpdate = update?.available != null;
  return (
    <div
      className="ch-card"
      style={{ padding: 14, display: "flex", alignItems: "center", gap: 14, marginBottom: 8 }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)", marginBottom: 2 }}>
          {hasUpdate ? `Update available — v${update?.available}` : "Software update"}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
          {update == null
            ? "Checking for updates…"
            : hasUpdate
              ? (update.notes ?? "A newer version is available.")
              : "You're on the latest version. In-app install isn't wired yet — updates arrive with the auto-updater."}
        </div>
      </div>
      {hasUpdate && (
        <Button variant="success" size="sm" disabled>
          Install (soon)
        </Button>
      )}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void check()}>
        {busy ? "Checking…" : "Check now"}
      </Button>
    </div>
  );
}

// General — workspace-level defaults, all live (config store). "Confirm before
// closing" gates the ⌘W / close-button kill; the Startup toggles gate the boot
// lifecycle's tmux-session adoption + last-tab restore (store bootstrap).
function GeneralPane() {
  const restore = useStore((s) => s.config?.restoreSessionsOnLaunch ?? true);
  return (
    <div style={{ maxWidth: 720 }}>
      <PaneHead title="General">
        Workspace-wide defaults. Saved to this machine and applied immediately.
      </PaneHead>

      <SectionHead label="Closing" />
      <SettingRow
        label="Confirm before closing a running agent"
        desc="Ask before ⌘W or the close button kills a session whose agent is working."
        control={<LiveToggle field="confirmCloseRunningAgent" />}
        live
        last
      />

      <SectionHead label="Startup" />
      <SettingRow
        label="Restore sessions on launch"
        desc="Reattach to the tmux sessions that survived the last quit. Off leaves them running in the container but starts the Hub clean."
        control={<LiveToggle field="restoreSessionsOnLaunch" />}
        live
      />
      <SettingRow
        label="Reopen last workspace"
        desc="Re-select the tab whose session was focused when you quit. Needs session restore on."
        control={<LiveToggle field="reopenLastWorkspace" disabled={!restore} />}
        live
        last
      />
    </div>
  );
}

// Container runtime — all REAL reads. Daemon from the bootstrap `docker_info`;
// image identity + liveness fetched once from `container_image` /
// `container_health`. Read-only: the container is configured via env knobs
// (CODEHUB_IMAGE, CODEHUB_NETWORK_MODE), not from here.
function RuntimePane({ dockerInfo }: { dockerInfo: DockerInfo | null }) {
  const dash = "—";
  const runtimeState = useStore((s) => s.status?.state);
  const notRunning = runtimeState !== "running";
  const [image, setImage] = useState<ImageInfo | null>(null);
  const [health, setHealth] = useState<RuntimeHealth | null>(null);
  useEffect(() => {
    let alive = true;
    ipc
      .containerImage()
      .then((i) => alive && setImage(i))
      .catch(() => {});
    ipc
      .containerHealth()
      .then((h) => alive && setHealth(h))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const uptime = health?.startedAt ? fmtUptime(health.startedAt) : null;
  return (
    <div style={{ maxWidth: 720 }}>
      <PaneHead title="Container runtime">
        The shared Docker container every agent runs inside. Read-only here — the image and network
        mode are set with the <span className="mono">CODEHUB_IMAGE</span> /{" "}
        <span className="mono">CODEHUB_NETWORK_MODE</span> env vars. Full inspection lives in the
        Containers view.
      </PaneHead>

      {notRunning && (
        <div
          className="ch-card"
          style={{
            padding: "12px 16px",
            marginBottom: 16,
            borderColor: "color-mix(in oklab, var(--wait) 35%, var(--bd))",
            background: "color-mix(in oklab, var(--wait) 5%, var(--bg-2))",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12.5,
            color: "var(--fg-1)",
          }}
        >
          <StatusDot status="wait" />
          Container not running — image and health fields below may be stale.
        </div>
      )}

      <SectionHead label="Daemon" />
      <div className="ch-card" style={{ padding: 16, display: "grid", gap: "10px 24px" }}>
        <Kv k="Reachable" v={dockerInfo ? (dockerInfo.reachable ? "yes" : "no") : dash} />
        <Kv k="Docker version" v={dockerInfo?.version ?? dash} />
        <Kv k="API version" v={dockerInfo?.apiVersion ?? dash} />
      </div>

      <SectionHead label="Image" />
      <div className="ch-card" style={{ padding: 16, display: "grid", gap: "10px 24px" }}>
        <Kv k="Tag" v={image?.tag ?? dash} />
        <Kv k="Digest" v={shortHash(image?.digest) ?? dash} />
        <Kv k="Size" v={image?.size != null ? fmtBytes(image.size) : dash} />
        <Kv
          k="Platform"
          v={image?.os && image?.arch ? `${image.os}-${image.arch}` : (image?.arch ?? dash)}
        />
      </div>

      <SectionHead label="Health" />
      <div className="ch-card" style={{ padding: 16, display: "grid", gap: "10px 24px" }}>
        <Kv k="Status" v={health?.status ?? dash} />
        <Kv k="Uptime" v={uptime ?? dash} />
        <Kv k="Restarts" v={health?.restartCount != null ? String(health.restartCount) : dash} />
        <Kv k="OOM killed" v={health?.oomKilled == null ? dash : health.oomKilled ? "yes" : "no"} />
      </div>
    </div>
  );
}

// Platform — static capability matrix mapping every feature to where it works:
// Desktop (this build) vs Web (planned). Ported from design/screens/platform.jsx.
// This is a factual reference doc, not live telemetry — the only dynamic value is
// the running build's version (real, from app_info). The desktop column states
// what THIS build ships today; the web column states the planned web build's
// shape. Where the design's mock implied features CodeHub hasn't built yet
// (self-update, push, OS toasts), the desktop cell is marked "planned" too rather
// than claiming support we don't have.
type Support = "full" | "server" | "degraded" | "planned" | "none";
type MatrixRow = { group: string } | { name: string; d: Support; w: Support; note?: string };

const PLATFORM_MATRIX: MatrixRow[] = [
  { group: "Core surfaces" },
  {
    name: "Main Hub (workspace tabs, panes, terminals)",
    d: "full",
    w: "full",
    note: "xterm.js inside the browser tab",
  },
  { name: "Command palette · ⌘K", d: "full", w: "full" },
  { name: "Session detail · diff inspector", d: "full", w: "full" },
  { name: "Resume library · past sessions", d: "full", w: "full" },
  { name: "Dashboard · Usage · Settings", d: "full", w: "full" },

  { group: "Container runtime" },
  {
    name: "Docker daemon access",
    d: "full",
    w: "server",
    note: "Web needs a CodeHub server bridging to a remote daemon",
  },
  {
    name: "Workspace filesystem mount",
    d: "full",
    w: "server",
    note: "Local path on desktop · git URL → server-side checkout on web",
  },
  {
    name: "Built-in container shell (tmux)",
    d: "full",
    w: "full",
    note: "WebSocket from server to xterm.js",
  },
  {
    name: "File browser pane",
    d: "full",
    w: "server",
    note: "Reads container fs through the server proxy",
  },
  { name: "Container exec / restart / stop", d: "full", w: "server" },

  { group: "Notifications & ambient" },
  { name: "In-app notifications (right rail)", d: "full", w: "full" },
  {
    name: "Dynamic Island · live activity",
    d: "full",
    w: "degraded",
    note: "macOS only on desktop · pinned top-center widget in the tab on web",
  },
  {
    name: "OS-native toast (macOS / Win / GNOME)",
    d: "full",
    w: "degraded",
    note: "Fires on await-input / turn-finish · web would use the browser Notification API",
  },
  {
    name: "Push notifications when app is closed",
    d: "planned",
    w: "full",
    note: "Web Push API via the server",
  },
  {
    name: "Companion · floating monitor window",
    d: "full",
    w: "none",
    note: "Requires an always-on-top window — not possible in a browser",
  },
  { name: "Menu bar tray icon", d: "planned", w: "none" },

  { group: "Shortcuts & interactions" },
  { name: "Per-tab keyboard shortcuts (when focused)", d: "full", w: "full" },
  {
    name: "Global shortcuts (when not focused)",
    d: "full",
    w: "none",
    note: "⌘⇧J toggles the companion / island from any app",
  },
  {
    name: "Drag-and-drop files into container",
    d: "planned",
    w: "degraded",
    note: "Browser drop area · no global drop targets",
  },

  { group: "Storage & security" },
  {
    name: "API keys forwarded from host env",
    d: "full",
    w: "server",
    note: "Desktop reads host env vars · web stores secrets server-side",
  },
  {
    name: "Multiple OS users / profiles",
    d: "full",
    w: "full",
    note: "Single-tenant desktop · multi-tenant server on web",
  },
  {
    name: "Offline mode",
    d: "degraded",
    w: "none",
    note: "Local container work still functions on desktop",
  },

  { group: "Integrations" },
  { name: "GitHub auth · clone/push/PR", d: "full", w: "full" },
  {
    name: "MCP servers (stdio)",
    d: "full",
    w: "server",
    note: "A browser cannot spawn local processes",
  },
  { name: "MCP servers (SSE / HTTP)", d: "full", w: "full" },

  { group: "Auto-update & telemetry" },
  {
    name: "Self-update from About",
    d: "planned",
    w: "none",
    note: "Updater not wired yet · web is always latest",
  },
  { name: "Update notification banner", d: "planned", w: "full" },
];

const SUPPORT_META: Record<Support, { color: string; icon: string; label: string }> = {
  full: { color: "var(--live)", icon: "✓", label: "full" },
  server: { color: "var(--idle)", icon: "◐", label: "server" },
  degraded: { color: "var(--wait)", icon: "~", label: "degraded" },
  planned: { color: "var(--fg-2)", icon: "·", label: "planned" },
  none: { color: "var(--err)", icon: "×", label: "no" },
};

const MATRIX_COLS = "1fr 104px 104px 1.1fr";

function PlatformPane({ appInfo }: { appInfo: AppInfo | null }) {
  return (
    <div style={{ maxWidth: 880 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 16,
          marginBottom: 26,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h1
            style={{
              margin: "0 0 6px",
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: "var(--fg-0)",
            }}
          >
            Platform
          </h1>
          <p
            style={{
              margin: 0,
              color: "var(--fg-2)",
              fontSize: 13,
              maxWidth: 540,
              lineHeight: 1.5,
            }}
          >
            CodeHub ships desktop-first; web support is on the roadmap. This page maps every feature
            to where it works — so you and your team know what to expect per build. It is a static
            reference, not live status.
          </p>
        </div>
        <span style={{ flex: 1 }} />
        <PlatformPill version={appInfo?.version ?? null} />
      </div>

      {/* legend */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginBottom: 16,
          padding: "10px 14px",
          background: "var(--bg-2)",
          border: "1px solid var(--bd)",
          borderRadius: 8,
          flexWrap: "wrap",
        }}
      >
        <span className="lbl" style={{ fontSize: 11 }}>
          legend
        </span>
        <Legend tone="full" label="full support" />
        <Legend tone="server" label="via server" />
        <Legend tone="degraded" label="degraded UX" />
        <Legend tone="planned" label="planned" />
        <Legend tone="none" label="unavailable" />
      </div>

      {/* matrix */}
      <div className="ch-card" style={{ padding: 0, overflow: "hidden" }}>
        <div
          className="mono"
          style={{
            display: "grid",
            gridTemplateColumns: MATRIX_COLS,
            background: "var(--bg-1)",
            borderBottom: "1px solid var(--bd-soft)",
            padding: "10px 16px",
            gap: 12,
            fontSize: 10.5,
            color: "var(--fg-2)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          <span>feature</span>
          <span style={{ textAlign: "center" }}>desktop</span>
          <span style={{ textAlign: "center" }}>web</span>
          <span>note</span>
        </div>
        {PLATFORM_MATRIX.map((r, i) =>
          "group" in r ? (
            <div
              key={r.group}
              className="mono"
              style={{
                padding: "14px 16px 6px",
                fontSize: 10.5,
                color: "var(--fg-3)",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                background: "var(--bg-1)",
                borderTop: i === 0 ? "none" : "1px solid var(--bd-soft)",
              }}
            >
              {r.group}
            </div>
          ) : (
            <div
              key={r.name}
              style={{
                display: "grid",
                gridTemplateColumns: MATRIX_COLS,
                gap: 12,
                padding: "10px 16px",
                borderBottom: "1px solid var(--bd-soft)",
                alignItems: "center",
                fontSize: 12,
              }}
            >
              <span style={{ color: "var(--fg-0)" }}>{r.name}</span>
              <span style={{ textAlign: "center" }}>
                <SupportChip tone={r.d} />
              </span>
              <span style={{ textAlign: "center" }}>
                <SupportChip tone={r.w} />
              </span>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
                {r.note ?? ""}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

// Two-state pill: which platform this build is. Desktop is live (real version);
// web is "planned" until that build exists.
function PlatformPill({ version }: { version: string | null }) {
  const cells: { id: "desktop" | "web"; label: string; on: boolean }[] = [
    { id: "desktop", label: version ? `Desktop · v${version}` : "Desktop", on: true },
    { id: "web", label: "Web · planned", on: false },
  ];
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 2,
        padding: 3,
        background: "var(--bg-2)",
        border: "1px solid var(--bd)",
        borderRadius: 999,
      }}
    >
      {cells.map((c) => (
        <span
          key={c.id}
          className="mono"
          style={{
            padding: "6px 14px",
            borderRadius: 999,
            fontSize: 12,
            background: c.on ? "var(--bg-0)" : "transparent",
            color: c.on ? "var(--fg-0)" : "var(--fg-2)",
            border: c.on ? "1px solid var(--bd)" : "1px solid transparent",
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontWeight: c.on ? 500 : 400,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: c.on ? "var(--live)" : "var(--fg-3)",
            }}
          />
          {c.label}
        </span>
      ))}
    </div>
  );
}

function Legend({ tone, label }: { tone: Support; label: string }) {
  const color = SUPPORT_META[tone].color;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11.5,
        color: "var(--fg-1)",
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          background: `color-mix(in oklab, ${color} 25%, transparent)`,
          border: `1px solid ${color}`,
        }}
      />
      {label}
    </span>
  );
}

function SupportChip({ tone }: { tone: Support }) {
  const m = SUPPORT_META[tone];
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 500,
        color: m.color,
        background: `color-mix(in oklab, ${m.color} 12%, transparent)`,
        border: `1px solid color-mix(in oklab, ${m.color} 30%, transparent)`,
      }}
    >
      <span>{m.icon}</span>
      {m.label}
    </span>
  );
}

// Repositories — REAL. CodeHub mounts a single host repo at /workspace; this
// surfaces that bind (host path) plus its live git state. Multi-repo support
// would need a backend, so "add" is a disabled stub.
function ReposPane() {
  const dash = "—";
  const [mounts, setMounts] = useState<MountInfo[] | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const containerKey = useStore((s) => activeWorkspace(s)?.containerKey ?? null);
  const loadWorkspaceInfo = useStore((s) => s.loadWorkspaceInfo);
  useEffect(() => {
    let alive = true;
    if (!containerKey) {
      setMounts([]);
      setGit(null);
      void loadWorkspaceInfo();
      return () => {
        alive = false;
      };
    }
    ipc
      .containerMounts(containerKey)
      .then((m) => alive && setMounts(m))
      .catch(() => alive && setMounts([]));
    ipc
      .containerGitStatus(containerKey)
      .then((g) => alive && setGit(g))
      .catch(() => {});
    void loadWorkspaceInfo();
    return () => {
      alive = false;
    };
  }, [containerKey, loadWorkspaceInfo]);

  const workspace = mounts?.find((m) => m.destination === "/workspace");
  const branchLine = git?.isRepo
    ? `${git.branch ?? "detached"}${git.ahead ? ` ↑${git.ahead}` : ""}${git.behind ? ` ↓${git.behind}` : ""}`
    : "not a git repo";

  return (
    <div style={{ maxWidth: 720 }}>
      <PaneHead title="Repositories">
        CodeHub mounts one host directory at <span className="mono">/workspace</span>, shared by
        every agent in the container. This is what they read and edit.
      </PaneHead>

      <SectionHead label="Workspace mount" />
      {workspace ? (
        <div className="ch-card" style={{ padding: 16, display: "grid", gap: "10px 24px" }}>
          <Kv k="Host path" v={workspace.source} />
          <Kv k="Mounted at" v={workspace.destination} />
          <Kv k="Access" v={workspace.rw ? "read-write" : "read-only"} />
          <Kv k="Branch" v={branchLine} />
          <Kv
            k="Working tree"
            v={
              git?.isRepo
                ? git.total === 0
                  ? "clean"
                  : `${git.total} changed file${git.total === 1 ? "" : "s"}`
                : dash
            }
          />
        </div>
      ) : (
        <div className="ch-card" style={{ padding: 16, fontSize: 12.5, color: "var(--fg-2)" }}>
          {mounts == null ? "Loading…" : "No /workspace mount — the container isn't running."}
        </div>
      )}

      <SectionHead label="Change workspace" />
      <WorkspaceChanger />
      <p style={{ margin: "12px 0 0", fontSize: 11.5, color: "var(--fg-2)" }}>
        One shared workspace per container. Mounting multiple repositories at once needs the
        multi-container work (Tier-3) and is not built yet.
      </p>
    </div>
  );
}

// Real Tier-2 workspace changer: shows the effective host dir, lets it change via
// the native folder dialog or an MRU recent, and offers a runtime recreate (the
// bind-mount source is fixed at create-time) when the choice differs from what's
// mounted. Shared concern with the spawn dialog's RepositoryPicker.
function WorkspaceChanger() {
  const workspaceInfo = useStore((s) => s.workspaceInfo);
  const error = useStore((s) => s.error);
  // Default outside the selector — a `?? []` inside returns a fresh array per
  // render and loops useSyncExternalStore (config starts null).
  const recents = useStore((s) => s.config?.recentWorkspaces) ?? [];
  const running = useStore((s) => s.status?.state === "running");
  const pickWorkspaceDir = useStore((s) => s.pickWorkspaceDir);
  const selectWorkspaceDir = useStore((s) => s.selectWorkspaceDir);
  const recreateRuntime = useStore((s) => s.recreateRuntime);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState("");

  const effective = workspaceInfo?.effective ?? null;
  const needsRecreate = workspaceInfo?.needsRecreate ?? false;
  const otherRecents = recents.filter((p) => p !== effective);

  useEffect(() => {
    if (effective && !manualPath) setManualPath(effective);
  }, [effective, manualPath]);

  const chooseWithDialog = async () => {
    const picked = await pickWorkspaceDir();
    // The browser dev bridge cannot show a native folder picker. Match the spawn
    // and new-workspace repository picker by falling back to a typed path.
    if (!picked) setManualOpen(true);
  };

  const submitManualPath = () => {
    const path = manualPath.trim();
    if (path) void selectWorkspaceDir(path);
  };

  const restart = () => {
    if (
      window.confirm(
        "Restart the runtime to mount the new workspace? This ends every running session (tmux scrollback is kept).",
      )
    ) {
      void recreateRuntime();
    }
  };

  return (
    <div className="ch-card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          className="mono"
          style={{
            fontSize: 12.5,
            color: "var(--fg-1)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={effective ?? undefined}
        >
          {effective ?? "—"}
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="outline" size="sm" onClick={() => void chooseWithDialog()}>
          {Ico.files}Choose folder…
        </Button>
      </div>

      {(manualOpen || !effective) && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
          <input
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitManualPath();
            }}
            placeholder="/absolute/path/to/repo"
            spellCheck={false}
            className="mono"
            style={{
              flex: 1,
              minWidth: 0,
              padding: "7px 10px",
              borderRadius: 6,
              border: "1px solid var(--bd-soft)",
              background: "var(--bg-0)",
              color: "var(--fg-1)",
              fontSize: 11.5,
              outline: "none",
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!manualPath.trim()}
            onClick={submitManualPath}
          >
            Use path
          </Button>
        </div>
      )}

      {error?.startsWith("set workspace dir failed") && (
        <div className="mono" style={{ marginTop: 8, fontSize: 10.5, color: "var(--err)" }}>
          {error}
        </div>
      )}

      {otherRecents.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="lbl" style={{ marginBottom: 6 }}>
            Recent
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {otherRecents.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => void selectWorkspaceDir(p)}
                className="mono"
                style={{
                  textAlign: "left",
                  background: "var(--bg-1)",
                  border: "1px solid var(--bd-soft)",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 11.5,
                  color: "var(--fg-2)",
                  cursor: "pointer",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={p}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      {needsRecreate && (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 12px",
            background: "color-mix(in oklab, var(--wait) 10%, var(--bg-1))",
            border: "1px solid color-mix(in oklab, var(--wait) 40%, var(--bd))",
            borderRadius: 8,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--fg-1)", flex: 1 }}>
            Workspace changed — restart the runtime to mount it. Ends every running session.
          </span>
          <Button variant="outline" size="sm" disabled={!running} onClick={restart}>
            Restart runtime
          </Button>
        </div>
      )}
    </div>
  );
}

// Keyboard shortcuts — REAL. Mirrors the working bindings from the ⌘/ cheat
// sheet (single source: SHORTCUT_GROUPS in components/hub/Shortcuts.tsx).
function ShortcutsPane() {
  return (
    <div style={{ maxWidth: 720, paddingTop: 4 }}>
      <PaneHead title="Keyboard shortcuts">
        Every binding that works today. Inside a terminal pane, all other keys pass straight through
        to the agent / tmux. The same list opens anywhere with <span className="kbd">⌘</span>{" "}
        <span className="kbd">/</span>.
      </PaneHead>

      {SHORTCUT_GROUPS.map((g) => (
        <div key={g.title}>
          <SectionHead label={g.title} />
          {g.items.map((sc, i) => (
            <div
              key={sc.desc}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "10px 0",
                borderBottom: i === g.items.length - 1 ? "none" : "1px solid var(--bd-soft)",
              }}
            >
              <span style={{ fontSize: 13, color: "var(--fg-0)", flex: 1 }}>{sc.desc}</span>
              <span style={{ display: "inline-flex", gap: 3 }}>
                {sc.keys.map((k) => (
                  <span key={k} className="kbd">
                    {k}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// Notifications — desktop notification PREFERENCES. The three flags persist for
// real (config::Settings → settings.json) AND drive real OS delivery: the event
// tailer reads the ConfigStore at event time and fires a tauri-plugin-notification
// toast on a permission prompt (await-input) or turn end (turn-finish), with an
// optional sound. Delivery is live in the packaged desktop app; the browser dev
// bridge (`make dev-web`) has no Tauri window so it persists the choice but emits
// no toast — that's the one place a saved toggle won't fire.
function NotificationsPane() {
  return (
    <div style={{ maxWidth: 720 }}>
      <PaneHead title="Notifications">
        How CodeHub should alert you when an agent needs attention while its window isn't focused.
      </PaneHead>

      <SectionHead label="Desktop notifications" />
      <p style={{ margin: "0 0 8px", fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.5 }}>
        These fire a real OS notification (macOS / Windows / GNOME) when the desktop app is running.
        In the browser dev preview there's no system window, so the choice is saved but no toast
        appears.
      </p>
      <SettingRow
        label="Notify when an agent awaits input"
        desc="OS notification when a backgrounded session hits a permission prompt."
        control={<LiveToggle field="notifyAwaitInput" />}
        live
      />
      <SettingRow
        label="Notify when a turn finishes"
        desc="Ping when an agent completes work in an unfocused session."
        control={<LiveToggle field="notifyTurnFinish" />}
        live
      />
      <SettingRow
        label="Play a sound"
        desc="Audible cue alongside the notification."
        control={<LiveToggle field="playSound" />}
        live
        last
      />

      <SectionHead label="Live activity preview" />
      <LiveActivityPreview />
      <LiveActivityStateGrid />

      <SectionHead label="Cross-platform toasts" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <NotificationPreview os="macOS">
          <MacNotificationPreview />
        </NotificationPreview>
        <NotificationPreview os="Windows 11">
          <WindowsNotificationPreview />
        </NotificationPreview>
        <NotificationPreview os="Linux · GNOME">
          <LinuxNotificationPreview />
        </NotificationPreview>
      </div>
    </div>
  );
}

export function LiveActivityPreview({ variant = "panel" }: { variant?: "panel" | "screen" }) {
  const screen = variant === "screen";
  return (
    <div
      style={{
        position: "relative",
        height: screen ? 420 : 336,
        overflow: "hidden",
        border: screen ? "none" : "1px solid var(--bd)",
        borderRadius: screen ? 0 : 10,
        background:
          "radial-gradient(ellipse at 26% 16%, oklch(0.35 0.06 30), oklch(0.18 0.04 230) 58%, oklch(0.12 0.03 250))",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)",
          backgroundSize: "3px 3px",
          mixBlendMode: "overlay",
          opacity: 0.55,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 28,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          fontSize: 12,
          color: "rgba(255,255,255,0.85)",
        }}
      >
        <span style={{ fontWeight: 600, marginRight: 18 }}>CodeHub</span>
        <span style={{ marginRight: 14 }}>Session</span>
        <span style={{ marginRight: 14 }}>Agent</span>
        <span style={{ marginRight: 14 }}>View</span>
        {screen && <span style={{ marginRight: 14 }}>Help</span>}
        <span style={{ flex: 1 }} />
        <MenuBarActivity />
        <span className="mono" style={{ fontSize: 11 }}>
          21:36
        </span>
      </div>

      <div
        style={{
          position: "absolute",
          top: screen ? 0 : 40,
          left: screen ? "50%" : "39%",
          transform: screen ? "translateX(-50%)" : "translateX(-50%) scale(0.9)",
          transformOrigin: "top center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          zIndex: 2,
        }}
      >
        <LiveIsland state="wait" />
        <div style={{ transform: "scale(0.94)", transformOrigin: "top center" }}>
          <LiveIsland state="live" />
        </div>
        <div style={{ transform: "scale(0.88)", transformOrigin: "top center", opacity: 0.85 }}>
          <LiveIsland state="done" />
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          top: screen ? 36 : 42,
          right: 16,
          bottom: screen ? 60 : 18,
          width: screen ? 304 : 268,
          padding: 8,
          display: "flex",
          flexDirection: "column",
          background: "rgba(28,28,32,0.58)",
          backdropFilter: "blur(40px) saturate(140%)",
          WebkitBackdropFilter: "blur(40px) saturate(140%)",
          border: "0.5px solid rgba(255,255,255,0.08)",
          borderRadius: 14,
          boxShadow: "0 24px 80px rgba(0,0,0,0.48)",
        }}
      >
        <div
          style={{
            padding: "4px 8px 8px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "rgba(255,255,255,0.62)",
          }}
        >
          <span className="mono" style={{ fontSize: 10.5, letterSpacing: "0.08em" }}>
            LIVE ACTIVITIES
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11 }}>3 active</span>
        </div>
        <NotificationCenterCard
          agent="claude"
          title="Refactor auth middleware"
          meta="turn 04:12 · 184k ctx"
          live
        />
        <NotificationCenterCard
          agent="codex"
          title="Needs permission · migrate:up"
          meta="awaiting · 14s blocked"
          tone="wait"
        />
        <NotificationCenterCard
          agent="antigravity"
          title="Profiling complete · 3 hotspots"
          meta="2m ago · done"
          tone="done"
        />
        {screen && (
          <>
            <div
              className="mono"
              style={{
                padding: "6px 8px 5px",
                fontSize: 10.5,
                letterSpacing: "0.08em",
                color: "rgba(255,255,255,0.48)",
              }}
            >
              EARLIER TODAY
            </div>
            <NotificationCenterCard
              agent="claude"
              title="Failed: ENOENT /tmp/snap-3"
              meta="34m ago"
              tone="err"
            />
            <NotificationCenterCard
              agent="claude"
              title="Ran pnpm test · 218 pass"
              meta="14m ago"
              tone="done"
            />
          </>
        )}
      </div>
      {screen && (
        <div
          style={{
            position: "absolute",
            bottom: 18,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 10px",
            borderRadius: 999,
            background: "rgba(0,0,0,0.45)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            color: "rgba(255,255,255,0.85)",
            fontSize: 12,
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#fff" }} />
          <span>
            macOS notch · menu bar widget · Notification Center ·{" "}
            <span
              className="mono"
              style={{
                background: "rgba(255,255,255,0.12)",
                padding: "1px 5px",
                borderRadius: 3,
              }}
            >
              ⌘⇧J
            </span>{" "}
            cycles focus
          </span>
        </div>
      )}
    </div>
  );
}

function MenuBarActivity() {
  const r = 5.5;
  return (
    <span
      title="Claude · turn 04:12"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        height: 22,
        padding: "2px 10px",
        marginRight: 14,
        borderRadius: 999,
        background: "rgba(255,255,255,0.10)",
        border: "0.5px solid rgba(255,255,255,0.08)",
      }}
    >
      <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r={r} stroke="rgba(255,255,255,0.18)" strokeWidth="1.4" fill="none" />
        <circle
          cx="7"
          cy="7"
          r={r}
          stroke="oklch(0.80 0.17 145)"
          strokeWidth="1.4"
          fill="none"
          strokeDasharray={`${0.62 * 2 * Math.PI * r} ${2 * Math.PI * r}`}
          transform="rotate(-90 7 7)"
          strokeLinecap="round"
        />
      </svg>
      <span style={{ fontSize: 11, color: "#fff" }}>Refactor auth</span>
      <span className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.65)" }}>
        04:12
      </span>
    </span>
  );
}

export function LiveActivityStateGrid() {
  return (
    <div style={{ marginTop: 10, marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>States</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
          island, stack, and expanded variants
        </span>
        <span style={{ flex: 1, height: 1, background: "var(--bd-soft)" }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
        <IslandStateCard title="Idle" detail="compact summary">
          <LiveIsland state="idle" />
        </IslandStateCard>
        <IslandStateCard title="Live" detail="turn in progress">
          <LiveIsland state="live" />
        </IslandStateCard>
        <IslandStateCard title="Awaiting input" detail="approve or deny inline" tone="wait">
          <LiveIsland state="wait" />
        </IslandStateCard>
        <IslandStateCard title="Turn finished" detail="review before it fades" tone="done">
          <LiveIsland state="done" />
        </IslandStateCard>
        <IslandStateCard title="Failed" detail="sticks until acknowledged" tone="err">
          <LiveIsland state="err" />
        </IslandStateCard>
        <IslandStateCard title="Split" detail="two simultaneous events">
          <LiveIsland state="split" />
        </IslandStateCard>
        <IslandStateCard title="Multi" detail="condensed event stack">
          <LiveIsland state="multi" />
        </IslandStateCard>
        <IslandStateCard title="Stack" detail="priority ordered queue" tone="wait">
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <LiveIsland state="wait" />
            <div style={{ transform: "scale(0.92)", transformOrigin: "top center" }}>
              <LiveIsland state="live" />
            </div>
            <div style={{ transform: "scale(0.84)", transformOrigin: "top center", opacity: 0.78 }}>
              <LiveIsland state="done" />
            </div>
          </div>
        </IslandStateCard>
        <div style={{ gridColumn: "1 / -1" }}>
          <IslandStateCard title="Expanded" detail="rich card with terminal peek">
            <ExpandedIslandPreview />
          </IslandStateCard>
        </div>
      </div>
    </div>
  );
}

function IslandStateCard({
  title,
  detail,
  tone,
  children,
}: {
  title: string;
  detail: string;
  tone?: "wait" | "done" | "err";
  children: ReactNode;
}) {
  const color =
    tone === "wait"
      ? "var(--wait)"
      : tone === "done"
        ? "var(--idle)"
        : tone === "err"
          ? "var(--err)"
          : "var(--fg-2)";
  return (
    <div className="ch-card" style={{ padding: 0, overflow: "hidden", background: "var(--bg-2)" }}>
      <div
        style={{
          minHeight: 92,
          padding: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "radial-gradient(ellipse at 50% 10%, oklch(0.24 0.04 250), oklch(0.13 0.03 250))",
          borderBottom: "1px solid var(--bd-soft)",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
      <div style={{ padding: "10px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
          <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-0)" }}>{title}</span>
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
          {detail}
        </div>
      </div>
    </div>
  );
}

function LiveIsland({
  state,
}: { state: "idle" | "live" | "wait" | "done" | "err" | "split" | "multi" }) {
  const base: CSSProperties = {
    background: "#000",
    color: "rgba(255,255,255,0.95)",
    fontFamily: "var(--mono)",
    display: "flex",
    alignItems: "center",
    boxShadow: "0 6px 22px rgba(0,0,0,0.55)",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.04)",
  };
  if (state === "idle") {
    return (
      <div
        style={{
          ...base,
          height: 28,
          padding: "0 14px",
          borderRadius: 999,
          gap: 9,
          fontSize: 12,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "oklch(0.80 0.17 145)",
            boxShadow: "0 0 8px oklch(0.80 0.17 145)",
          }}
        />
        <span>2 agents</span>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>·</span>
        <span className="tnum">04:12</span>
      </div>
    );
  }
  if (state === "wait") {
    return (
      <div
        style={{
          ...base,
          width: 326,
          height: 52,
          padding: "0 6px 0 14px",
          borderRadius: 26,
          gap: 10,
          boxSizing: "border-box",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "oklch(0.83 0.14 80)",
            boxShadow: "0 0 10px oklch(0.83 0.14 80)",
          }}
        />
        <AgentGlyph agent="codex" size={13} color="oklch(0.78 0.10 265)" />
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            lineHeight: 1.2,
            flex: 1,
            minWidth: 0,
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap" }}>
            Codex needs permission
          </span>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.58)" }}>
            aurora-api · pnpm migrate:up
          </span>
        </span>
        <IslandButton>Deny</IslandButton>
        <IslandButton tone="ok">Approve</IslandButton>
      </div>
    );
  }
  if (state === "err") {
    return (
      <div
        style={{
          ...base,
          width: 290,
          height: 46,
          padding: "0 7px 0 14px",
          borderRadius: 23,
          gap: 10,
          boxSizing: "border-box",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "oklch(0.68 0.18 25)",
            boxShadow: "0 0 10px oklch(0.68 0.18 25)",
          }}
        />
        <AgentGlyph agent="claude" size={13} color="oklch(0.78 0.13 35)" />
        <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.2, flex: 1 }}>
          <span style={{ fontSize: 12.5, fontWeight: 500 }}>Claude failed</span>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.58)" }}>ENOENT /tmp/snap-3</span>
        </span>
        <IslandButton tone="white">Open</IslandButton>
      </div>
    );
  }
  if (state === "split") {
    return (
      <div
        style={{
          ...base,
          height: 38,
          padding: 0,
          borderRadius: 19,
          fontSize: 12,
          alignItems: "stretch",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 14px" }}>
          <AgentGlyph agent="claude" size={13} color="oklch(0.78 0.13 35)" />
          <span>refactor auth</span>
          <span className="tnum" style={{ color: "rgba(255,255,255,0.55)", fontSize: 11 }}>
            04:12
          </span>
        </div>
        <span style={{ width: 1, background: "rgba(255,255,255,0.10)" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 14px" }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "oklch(0.83 0.14 80)",
              boxShadow: "0 0 8px oklch(0.83 0.14 80)",
            }}
          />
          <AgentGlyph agent="codex" size={13} color="oklch(0.78 0.10 265)" />
          <span>needs input</span>
        </div>
      </div>
    );
  }
  if (state === "multi") {
    return (
      <div
        style={{
          ...base,
          height: 34,
          padding: "0 14px",
          borderRadius: 17,
          gap: 9,
          fontSize: 12,
        }}
      >
        <span style={{ display: "inline-flex", marginRight: -4 }}>
          <AgentGlyph agent="claude" size={13} color="oklch(0.78 0.13 35)" />
        </span>
        <span style={{ display: "inline-flex", marginLeft: -3 }}>
          <AgentGlyph agent="codex" size={13} color="oklch(0.78 0.10 265)" />
        </span>
        <span>5 updates</span>
        <span
          className="tnum"
          style={{
            padding: "1px 7px",
            borderRadius: 999,
            background: "rgba(255,255,255,0.12)",
            color: "#fff",
            fontSize: 11,
          }}
        >
          +3
        </span>
      </div>
    );
  }
  if (state === "done") {
    return (
      <div
        style={{
          ...base,
          width: 288,
          height: 48,
          padding: "0 6px 0 14px",
          borderRadius: 24,
          gap: 10,
          boxSizing: "border-box",
        }}
      >
        <span
          style={{ width: 7, height: 7, borderRadius: "50%", background: "oklch(0.78 0.08 200)" }}
        />
        <AgentGlyph agent="claude" size={13} color="oklch(0.78 0.13 35)" />
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            lineHeight: 1.2,
            flex: 1,
            minWidth: 0,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 500 }}>Claude finished refactor</span>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.58)" }}>
            14 edits · 4:21 elapsed
          </span>
        </span>
        <IslandButton tone="white">Review</IslandButton>
      </div>
    );
  }
  return (
    <div
      style={{
        ...base,
        height: 38,
        padding: "0 14px",
        borderRadius: 19,
        gap: 10,
        position: "relative",
      }}
    >
      <AgentGlyph agent="claude" size={13} color="oklch(0.78 0.13 35)" />
      <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.1, gap: 2 }}>
        <span style={{ fontSize: 12 }}>Claude · refactor auth</span>
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.55)" }}>
          turn 04:12 · tests passing
        </span>
      </span>
      <span
        style={{
          position: "absolute",
          left: 14,
          right: 14,
          bottom: 4,
          height: 2,
          background: "rgba(255,255,255,0.1)",
          borderRadius: 999,
        }}
      >
        <span
          style={{
            display: "block",
            width: "62%",
            height: "100%",
            background: "oklch(0.80 0.17 145)",
            borderRadius: 999,
          }}
        />
      </span>
    </div>
  );
}

function ExpandedIslandPreview() {
  return (
    <div
      style={{
        width: "min(100%, 460px)",
        background: "#000",
        color: "#fff",
        borderRadius: 22,
        boxShadow: "0 18px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.06)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "12px 14px 8px", display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "oklch(0.80 0.17 145)",
            boxShadow: "0 0 10px oklch(0.80 0.17 145)",
          }}
        />
        <AgentGlyph agent="claude" size={13} color="oklch(0.78 0.13 35)" />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Claude · aurora-api</span>
        <span className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.55)" }}>
          opus · feat/auth
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.65)" }}>
          04:12
        </span>
      </div>
      <div
        className="mono"
        style={{
          margin: "0 12px",
          padding: "10px 12px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 8,
          fontSize: 11.5,
          lineHeight: 1.55,
          color: "rgba(255,255,255,0.84)",
        }}
      >
        <div style={{ color: "oklch(0.80 0.17 145)" }}>
          Bash <span style={{ color: "rgba(255,255,255,0.55)" }}>pnpm test src/auth</span>
        </div>
        <div>
          <span style={{ color: "oklch(0.80 0.17 145)" }}>✓</span> verifier.spec.ts{" "}
          <span style={{ color: "rgba(255,255,255,0.45)" }}>(4 tests)</span>
        </div>
        <div style={{ color: "rgba(255,255,255,0.56)" }}>Running final typecheck…</div>
      </div>
      <div style={{ padding: "12px 14px 14px", display: "flex", alignItems: "center", gap: 8 }}>
        <IslandButton tone="white">Jump to terminal</IslandButton>
        <IslandButton>View diff</IslandButton>
        <IslandButton>Dismiss</IslandButton>
      </div>
    </div>
  );
}

function IslandButton({ children, tone }: { children: ReactNode; tone?: "ok" | "white" }) {
  return (
    <button
      type="button"
      style={{
        border: "none",
        cursor: "default",
        fontSize: 11.5,
        fontWeight: 600,
        padding: "7px 10px",
        borderRadius: 999,
        background:
          tone === "ok"
            ? "oklch(0.80 0.17 145)"
            : tone === "white"
              ? "#fff"
              : "rgba(255,255,255,0.10)",
        color: tone === "ok" || tone === "white" ? "#000" : "rgba(255,255,255,0.85)",
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

function NotificationCenterCard({
  agent,
  title,
  meta,
  tone,
  live,
}: {
  agent: AgentCli;
  title: string;
  meta: string;
  tone?: "wait" | "done" | "err";
  live?: boolean;
}) {
  const color =
    tone === "wait"
      ? "oklch(0.83 0.14 80)"
      : tone === "err"
        ? "oklch(0.68 0.18 25)"
        : tone === "done"
          ? "rgba(255,255,255,0.45)"
          : "oklch(0.80 0.17 145)";
  return (
    <div
      style={{
        marginBottom: 6,
        padding: "10px 12px",
        borderRadius: 10,
        background: "rgba(50,50,55,0.62)",
        border: "0.5px solid rgba(255,255,255,0.06)",
        color: "#fff",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
            boxShadow: live ? `0 0 8px ${color}` : "none",
          }}
        />
        <AgentGlyph agent={agent} size={11} color={color} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>CodeHub</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
          {meta.split(" · ").at(-1)}
        </span>
      </div>
      <div style={{ fontSize: 12, marginBottom: 2 }}>{title}</div>
      <div className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.56)" }}>
        {meta}
      </div>
    </div>
  );
}

export function NotificationPreview({ os, children }: { os: string; children: ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--bd)",
        borderRadius: 10,
        padding: 12,
        background: "var(--bg-2)",
      }}
    >
      <div
        style={{
          minHeight: 124,
          borderRadius: 7,
          padding: "18px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, oklch(0.30 0.05 230), oklch(0.18 0.04 250))",
          border: "1px solid var(--bd-soft)",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <span className="lbl" style={{ fontSize: 11 }}>
          {os}
        </span>
        <span style={{ flex: 1, height: 1, background: "var(--bd-soft)" }} />
        <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
          native APIs
        </span>
      </div>
    </div>
  );
}

export function MacNotificationPreview() {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 280,
        padding: "11px 12px",
        borderRadius: 14,
        background: "rgba(28,28,32,0.92)",
        border: "0.5px solid rgba(255,255,255,0.06)",
        color: "#fff",
        display: "flex",
        gap: 10,
        boxShadow: "0 10px 40px rgba(0,0,0,0.45)",
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 7,
          background: "var(--bg-0)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Logo size={18} withText={false} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>CodeHub</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>now</span>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 1 }}>Codex needs permission</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.72)" }}>
          aurora-api · run pnpm migrate:up?
        </div>
      </div>
    </div>
  );
}

export function WindowsNotificationPreview() {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 280,
        padding: 12,
        borderRadius: 8,
        background: "rgba(28,28,30,0.94)",
        color: "#fff",
        boxShadow: "0 12px 32px rgba(0,0,0,0.50)",
        border: "1px solid rgba(255,255,255,0.05)",
        position: "relative",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 3,
          bottom: 0,
          background: "oklch(0.78 0.10 265)",
          borderRadius: "8px 0 0 8px",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Logo size={13} withText={false} />
        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.70)" }}>CodeHub</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>1m ago</span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Claude finished refactor</div>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.75)" }}>
        14 edits, 218 tests pass · 4:21 elapsed
      </div>
    </div>
  );
}

export function LinuxNotificationPreview() {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 296,
        padding: "10px 12px",
        borderRadius: 10,
        background: "rgba(20,22,26,0.96)",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        gap: 12,
        boxShadow: "0 10px 36px rgba(0,0,0,0.50), 0 0 0 1px rgba(255,255,255,0.06)",
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          background: "oklch(0.72 0.18 25)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        !
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 1 }}>
          Claude failed · dash-web
        </div>
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: "rgba(255,255,255,0.70)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          ENOENT: no such file '/tmp/snap-3'
        </div>
      </div>
    </div>
  );
}

// Appearance — Theme + terminal font size are live (theme via useTheme, font
// via the config store → every open xterm pane). Density is a disabled stub
// until the compact layout pass.
function AppearancePane() {
  const { theme, setTheme } = useTheme();
  return (
    <div style={{ maxWidth: 720 }}>
      <PaneHead title="Appearance">
        Theme and terminal font size apply instantly and are remembered on this machine.
      </PaneHead>

      <SectionHead label="Theme" />
      <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "14px 0" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: "var(--fg-0)", marginBottom: 2 }}>Color theme</div>
          <div style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
            Switches the whole interface between dark, gray, and light.
          </div>
        </div>
        <ThemeChoice theme={theme} onChange={setTheme} />
      </div>

      <SectionHead label="Terminal" />
      <SettingRow
        label="Terminal font size"
        desc="Applies live to every xterm pane."
        control={<FontSizeInput />}
        live
        last
      />

      <SectionHead label="Display" />
      <SettingRow
        label="Density"
        desc="Compact tightens the terminal chrome — tab bar, pane headers, split dividers, and the launcher."
        control={<DensityChoice />}
        live
        last
      />
    </div>
  );
}

// Segmented comfortable/compact selector, bound to the density setting. Writes
// through the config store, which reflects it onto the document root
// (data-density) so the chrome tightens immediately.
function DensityChoice() {
  const value = useStore((s) => s.config?.density ?? "comfortable");
  const updateConfig = useStore((s) => s.updateConfig);
  return (
    <Segmented
      value={value}
      onChange={(density) => void updateConfig({ density })}
      options={[
        { key: "comfortable", label: "Comfortable" },
        { key: "compact", label: "Compact" },
      ]}
    />
  );
}

// Segmented dark/light selector — the one genuinely live control in Settings.
function ThemeChoice({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  return (
    <Segmented<Theme>
      value={theme}
      onChange={onChange}
      options={[
        { key: "dark", label: "Dark" },
        { key: "gray", label: "Gray" },
        { key: "light", label: "Light" },
      ]}
    />
  );
}

// — Live controls, backed by the config store —

// Boolean keys of AppSettings, so LiveToggle can only target a real toggle.
type BoolSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never;
}[keyof AppSettings];

// A working toggle bound to one boolean setting; writes through updateConfig.
function LiveToggle({ field, disabled }: { field: BoolSettingKey; disabled?: boolean }) {
  const on = useStore((s) => Boolean(s.config?.[field]));
  const updateConfig = useStore((s) => s.updateConfig);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => void updateConfig({ [field]: !on } as Partial<AppSettings>)}
      style={{
        width: 32,
        height: 18,
        borderRadius: 999,
        background: on ? "var(--fg-0)" : "var(--bg-3)",
        border: `1px solid ${on ? "var(--fg-0)" : "var(--bd-strong)"}`,
        padding: 0,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        position: "relative",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 1,
          left: on ? 16 : 1,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: on ? "var(--bg-0)" : "var(--fg-1)",
          transition: "left .15s",
        }}
      />
    </button>
  );
}

// Stepper for the terminal font size (10–20 px). Each change writes through the
// config store, which pushes the new size onto every open pane (panes.setFontSize).
function FontSizeInput() {
  const size = useStore((s) => s.config?.terminalFontSize ?? 13);
  const updateConfig = useStore((s) => s.updateConfig);
  const set = (n: number) => void updateConfig({ terminalFontSize: Math.max(10, Math.min(20, n)) });
  const StepBtn = ({ d, label }: { d: number; label: string }) => (
    <button
      type="button"
      aria-label={label}
      onClick={() => set(size + d)}
      disabled={d < 0 ? size <= 10 : size >= 20}
      style={{
        width: 24,
        height: 28,
        border: "none",
        background: "transparent",
        color: "var(--fg-1)",
        fontSize: 15,
        cursor: "pointer",
      }}
    >
      {d < 0 ? "−" : "+"}
    </button>
  );
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: "1px solid var(--bd)",
        borderRadius: 6,
        background: "var(--bg-1)",
        overflow: "hidden",
      }}
    >
      <StepBtn d={-1} label="Decrease font size" />
      <span
        className="mono tnum"
        style={{
          minWidth: 40,
          textAlign: "center",
          fontSize: 12,
          color: "var(--fg-0)",
        }}
      >
        {size} px
      </span>
      <StepBtn d={1} label="Increase font size" />
    </div>
  );
}

// Re-probe each agent binary's reported version (`agent_versions`) on demand and
// push the fresh map back into the store, so the agent cards + About pane reflect
// it immediately. The bootstrap fetches this once at launch; this re-runs the
// same real read (e.g. after upgrading a CLI inside the container) — no fabrication.
function RefreshVersionsButton() {
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      const agentVersions = await ipc.agentVersions();
      useStore.setState({ agentVersions });
    } catch (e) {
      console.warn("agent_versions refresh failed", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>
      {busy ? "Refreshing…" : "Refresh versions"}
    </Button>
  );
}

// Agent dropdown bound to the default-agent setting (pre-selects the launcher).
function DefaultAgentSelect() {
  const value = useStore((s) => s.config?.defaultAgent ?? "claude");
  const updateConfig = useStore((s) => s.updateConfig);
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "0 8px",
        border: "1px solid var(--bd)",
        borderRadius: 6,
        background: "var(--bg-1)",
      }}
    >
      <AgentGlyph agent={value} size={11} color={`var(--a-${value})`} />
      <select
        value={value}
        onChange={(e) => void updateConfig({ defaultAgent: e.target.value as Cli })}
        style={{
          appearance: "none",
          border: "none",
          background: "transparent",
          color: "var(--fg-0)",
          fontFamily: "var(--sans)",
          fontSize: 12,
          padding: "6px 2px",
          cursor: "pointer",
          minWidth: 110,
        }}
      >
        {CLIS.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <span style={{ color: "var(--fg-2)" }}>{Ico.chevD}</span>
    </div>
  );
}

// Human-readable bytes (binary units), matching the Containers view formatter.
function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// Compact uptime from an RFC 3339 start time: "<1m", "12m", "3h", "2d".
function fmtUptime(rfc3339: string): string | null {
  const start = Date.parse(rfc3339);
  if (Number.isNaN(start)) return null;
  const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (s < 60) return "<1m";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Strip `sha256:` and shorten to 12 hex chars (how `docker images` shows it).
function shortHash(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.replace(/^sha256:/, "").slice(0, 12);
}

// One mono key/value row for the About pane. Value is right-aligned and
// ellipsized so a long Docker/socket string can't widen its grid track.
function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: "var(--fg-2)", flexShrink: 0 }}>{k}</span>
      <span style={{ flex: 1, borderBottom: "1px dotted var(--bd-soft)", minWidth: 8 }} />
      <span
        className="mono tnum"
        style={{
          fontSize: 11.5,
          color: "var(--fg-1)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
        title={v}
      >
        {v}
      </span>
    </div>
  );
}

function SectionHead({ label, tone }: { label: string; tone?: "err" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "24px 0 12px" }}>
      <span
        className="lbl"
        style={{ color: tone === "err" ? "var(--err)" : "var(--fg-1)", fontSize: 11 }}
      >
        {label}
      </span>
      <span style={{ flex: 1, height: 1, background: "var(--bd-soft)" }} />
    </div>
  );
}

// One agent card, all real data. `present` is host-env key presence (never the
// value); `varName`/`source` name where it came from; `version` is the binary's
// reported version (em-dash when the binary or feed is absent).
function AgentRow({
  agent,
  name,
  version,
  present,
  varName,
  source,
  onConfigure,
}: {
  agent: AgentId;
  name: string;
  version: string | null;
  present: boolean;
  varName: string | null;
  source: string | null;
  onConfigure?: () => void;
}) {
  const meta = AGENT_META[agent];
  // Honest auth subline: the env var that's set, else what's missing.
  const authLine = present
    ? `${varName ?? "host env"}${source && source !== "env" ? ` · ${source}` : ""}`
    : "no host key set";
  return (
    <button
      type="button"
      onClick={onConfigure}
      className="ch-card agent-row"
      style={{
        padding: 14,
        display: "flex",
        alignItems: "center",
        gap: 14,
        marginBottom: 8,
        width: "100%",
        textAlign: "left",
        background: "var(--bg-2)",
        cursor: onConfigure ? "pointer" : "default",
      }}
    >
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: 8,
          background: `color-mix(in oklab, ${meta.accent} 14%, var(--bg-1))`,
          border: `1px solid color-mix(in oklab, ${meta.accent} 30%, var(--bd))`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ transform: "scale(1.4)" }}>
          <AgentGlyph agent={agent} size={14} color={meta.accent} />
        </span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--fg-0)" }}>{name}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
            {version ?? "—"}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--fg-2)", fontFamily: "var(--mono)" }}>
          {authLine}
        </div>
      </div>
      {present ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            color: "var(--live)",
            whiteSpace: "nowrap",
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
            whiteSpace: "nowrap",
          }}
        >
          <StatusDot status="wait" /> Key needed
        </span>
      )}
      {onConfigure && (
        <span style={{ color: "var(--fg-3)", display: "inline-flex", flexShrink: 0 }}>
          {Ico.arrowR}
        </span>
      )}
    </button>
  );
}

function SettingRow({
  label,
  desc,
  control,
  last,
  live,
}: {
  label: string;
  desc: string;
  control: ReactNode;
  last?: boolean;
  // When set, the control is interactive (backed by the config store). Default
  // rows are dimmed + inert because their feature isn't wired yet.
  live?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 20,
        padding: "14px 0",
        borderBottom: last ? "none" : "1px solid var(--bd-soft)",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: "var(--fg-0)", marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{desc}</div>
      </div>
      {live ? (
        control
      ) : (
        // Dimmed + inert: this control's feature isn't wired yet, so it must not
        // look clickable.
        <div aria-disabled style={{ opacity: 0.45, pointerEvents: "none" }}>
          {control}
        </div>
      )}
    </div>
  );
}

// Minimal presentational controls matching the design's monochrome style.
// Real wiring (to the Tier-2 config store) lands when these panes go live.
function Toggle({ on }: { on?: boolean }) {
  return (
    <span
      style={{
        width: 32,
        height: 18,
        borderRadius: 999,
        background: on ? "var(--fg-0)" : "var(--bg-3)",
        border: `1px solid ${on ? "var(--fg-0)" : "var(--bd-strong)"}`,
        display: "inline-flex",
        alignItems: "center",
        padding: "0 2px",
        cursor: "pointer",
        position: "relative",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 1,
          left: on ? 16 : 1,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: on ? "var(--bg-0)" : "var(--fg-1)",
          transition: "left .15s",
        }}
      />
    </span>
  );
}

function InputStub({ value, suffix }: { value: string; suffix: string }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        border: "1px solid var(--bd)",
        borderRadius: 6,
        background: "var(--bg-1)",
        fontFamily: "var(--mono)",
        fontSize: 12,
        minWidth: 140,
      }}
    >
      <span style={{ color: "var(--fg-0)" }}>{value}</span>
      <span style={{ flex: 1 }} />
      <span style={{ color: "var(--fg-3)", fontSize: 11 }}>{suffix}</span>
    </div>
  );
}
