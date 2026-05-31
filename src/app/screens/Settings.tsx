/**
 * Settings — sectioned left-nav + right pane. Ported from design/screens/settings.jsx.
 *
 * Every pane is now ported and reads real data:
 *  - Coding Agents: versions from `agent_versions`, connection state from
 *    `agent_key_status` (presence-only, never the value).
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
 * Credentials are stored in the OS keychain (API keys + OAuth tokens).
 */
import { AGENT_META, AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { IconBtn } from "@/app/components/primitives/IconBtn";
import { Logo } from "@/app/components/primitives/Logo";
import { Segmented } from "@/app/components/primitives/Segmented";
import { StatusDot } from "@/app/components/primitives/StatusDot";
import { Tab, TabBar } from "@/app/components/primitives/TabBar";
import { Tag } from "@/app/components/primitives/Tag";
import { Tip } from "@/app/components/primitives/Tip";
import { Ico } from "@/app/components/primitives/icons";
import { CLIS } from "@/app/lib/catalog";
import {
  type AgentCli,
  type AppInfo,
  type AppSettings,
  type AuthProgress,
  type ModelProvider,
  ipc,
  onAuthProgress,
} from "@/app/lib/ipc";
import { useStore } from "@/app/lib/store";
import { type Theme, useTheme } from "@/app/lib/theme";
import { Button } from "@/app/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/ui/dialog";
import { Input } from "@/app/ui/input";
import { Label } from "@/app/ui/label";
import { Switch } from "@/app/ui/switch";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { ApiKeyDialog } from "../components/ApiKeyDialog";
import { LoginTerminalDialog } from "../components/LoginTerminalDialog";
import { AgentDetail } from "./AgentDetail";
import { IntegrationsPane } from "./Integrations";

export interface SettingsProps {
  /** Dev preview hook: open Agents directly on one agent's factual detail view. */
  initialAgentDetail?: AgentCli;
}

const NAV_GROUPS: { label: string; items: { key: string; label: string; soon?: boolean }[] }[] = [
  {
    label: "Workspace",
    items: [
      { key: "general", label: "General" },
      { key: "agents", label: "Coding Agents" },
      { key: "integrations", label: "Source control" },
      { key: "platform", label: "Platform" },
    ],
  },
  {
    label: "Experience",
    items: [
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
];

export function Settings({ initialAgentDetail }: SettingsProps) {
  // Every pane is now ported. Panes with a real backend (Agents, Container
  // runtime, Repositories, Keyboard shortcuts, Appearance, About) show live
  // data; the rest (General, Notifications) render honest disabled controls
  // until the Tier-2 config store lands.
  // Active sub-pane is lifted to the store so other surfaces can deep-link into a
  // pane (the sidebar's "Integrations" entry, Welcome's "From GitHub" card, the
  // palette's GitHub repo rows) by setting it before navigating to Settings.
  const active = useStore((s) => s.settingsSection);
  const setActive = useStore((s) => s.setSettingsSection);

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
        className="scroll"
      >
        <h2
          style={{
            margin: "0 6px 14px",
            fontSize: "var(--fs-16)",
            fontWeight: 600,
            color: "var(--fg-0)",
          }}
        >
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
                disabled={item.soon}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  textAlign: "left",
                  padding: "7px 10px",
                  borderRadius: 6,
                  border: "none",
                  fontSize: "var(--fs-13)",
                  fontFamily: "var(--sans)",
                  color: item.soon
                    ? "var(--fg-3)"
                    : active === item.key
                      ? "var(--fg-0)"
                      : "var(--fg-1)",
                  background: active === item.key ? "var(--bg-3)" : "transparent",
                  cursor: item.soon ? "default" : "pointer",
                  opacity: item.soon ? 0.5 : 1,
                  marginBottom: 1,
                  transition: "background 0.12s ease, color 0.12s ease",
                }}
              >
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.soon && (
                  <span className="mono" style={{ fontSize: "var(--fs-10)", color: "var(--fg-3)" }}>
                    soon
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* pane */}
      <div
        className={active === "agents" ? undefined : "scroll"}
        style={{
          flex: 1,
          overflow: active === "agents" ? "hidden" : "auto",
          padding: active === "agents" ? "24px 32px 0" : "24px 32px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {active === "agents" ? (
          <AgentsPane initialDetail={initialAgentDetail} />
        ) : active === "integrations" ? (
          <IntegrationsPane />
        ) : active === "platform" ? (
          <PlatformPane appInfo={appInfo} />
        ) : active === "notifications" ? (
          <NotificationsPane />
        ) : active === "appearance" ? (
          <AppearancePane />
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
          fontSize: "var(--fs-20)",
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "var(--fg-0)",
        }}
      >
        {title}
      </h1>
      <p style={{ margin: "0 0 28px", color: "var(--fg-2)", fontSize: "var(--fs-13)" }}>
        {children}
      </p>
    </>
  );
}

const AGENT_DESCRIPTIONS: Record<AgentCli, string> = {
  claude:
    "Anthropic's coding agent. Supports Anthropic-compatible providers (MiniMax, GLM, Qwen, custom endpoints).",
  codex:
    "OpenAI's coding agent. Uses GPT/o-series models. Supports standard, auto, and full-auto permission modes.",
  antigravity:
    "Google's coding agent. Uses Gemini models. Standard mode only — launch flags are unverified.",
};

const COMPATIBLE_PROVIDERS: Record<AgentCli, string[]> = {
  claude: ["Anthropic-compatible", "AWS Bedrock", "Vertex AI"],
  codex: ["OpenAI-compatible", "Azure OpenAI"],
  antigravity: [],
};

// Which agent a provider kind routes to (mirrors accounts.ts providerTargetAgent
// + the backend's provider_session_env). Used to show a provider under the right
// agent tab and to filter the spawn-dialog picker.
const PROVIDER_TARGET_AGENT: Record<string, AgentCli> = {
  anthropic: "claude",
  "anthropic-compatible": "claude",
  openai: "codex",
  "openai-compatible": "codex",
  // OpenRouter is shown under Claude but is NOT launch-wired (see accounts.ts
  // providerTargetAgent, which returns null for it). It needs a router proxy.
  openrouter: "claude",
};

// Kinds that can actually be wired into the harness from a stored token — used to
// gate the "connected"/launchable affordances (openrouter/bedrock/vertex can't).
const LAUNCHABLE_KINDS = new Set([
  "anthropic",
  "anthropic-compatible",
  "openai",
  "openai-compatible",
]);

// A catalog entry that seeds a new provider's config form. The curated ones
// (MiniMax, z.ai) prefill the exact Anthropic-compatible base URL + model ids so
// connecting a token plan is one paste. OpenRouter is shown but `gated` — it has
// no native Anthropic endpoint, so it can't be launch-wired from a bare token.
interface ProviderPreset {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  models: string[];
  model?: string;
  smallFastModel?: string;
  /** One-liner shown on the catalog card. */
  blurb: string;
  /** Longer explanation shown in the config sub-view. */
  note?: string;
  /** What the token field is labelled (e.g. "MiniMax API key"). */
  tokenLabel?: string;
  docsUrl?: string;
  /** Not launch-wired (needs a router proxy / cloud creds). */
  gated?: boolean;
  gatedReason?: string;
  /** Blank custom endpoint — the user fills everything in. */
  custom?: boolean;
}

const CLAUDE_CATALOG: ProviderPreset[] = [
  {
    id: "minimax",
    name: "MiniMax",
    kind: "anthropic-compatible",
    baseUrl: "https://api.minimax.io/anthropic",
    models: ["MiniMax-M2"],
    model: "MiniMax-M2",
    blurb: "M2 · token plan",
    tokenLabel: "MiniMax API key",
    note: "MiniMax exposes an Anthropic-compatible endpoint, so Claude Code talks to it directly. Your key is stored in the OS keychain and injected as ANTHROPIC_AUTH_TOKEN at launch.",
    docsUrl: "https://www.minimax.io",
  },
  {
    id: "zai",
    name: "z.ai · GLM",
    kind: "anthropic-compatible",
    baseUrl: "https://api.z.ai/api/anthropic",
    models: ["glm-4.6", "glm-4.5-air"],
    model: "glm-4.6",
    smallFastModel: "glm-4.5-air",
    blurb: "GLM · coding plan",
    tokenLabel: "z.ai API key",
    note: "z.ai's GLM Coding Plan speaks the Anthropic protocol. glm-4.6 drives the main model; glm-4.5-air is the fast/background model (ANTHROPIC_SMALL_FAST_MODEL).",
    docsUrl: "https://z.ai",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    blurb: "router · needs proxy",
    gated: true,
    gatedReason:
      "OpenRouter is OpenAI-compatible and has no native Anthropic endpoint, so Claude Code can't point straight at it. It needs an Anthropic-compatible router proxy (e.g. claude-code-router) in front — so it isn't one-click launch-wired here yet.",
    docsUrl: "https://openrouter.ai",
  },
  {
    id: "custom-anthropic",
    name: "Custom endpoint",
    kind: "anthropic-compatible",
    baseUrl: "",
    models: [],
    blurb: "any Anthropic API",
    custom: true,
    tokenLabel: "API token",
    note: "Any endpoint that speaks the Anthropic protocol. Set the base URL, token, and model id.",
  },
];

const CODEX_CATALOG: ProviderPreset[] = [
  {
    id: "custom-openai",
    name: "Custom endpoint",
    kind: "openai-compatible",
    baseUrl: "",
    models: [],
    blurb: "any OpenAI API",
    custom: true,
    tokenLabel: "API key",
    note: "Any OpenAI-compatible endpoint. Injected as OPENAI_BASE_URL / OPENAI_API_KEY.",
  },
];

function catalogFor(agent: AgentCli): ProviderPreset[] {
  if (agent === "claude") return CLAUDE_CATALOG;
  if (agent === "codex") return CODEX_CATALOG;
  return [];
}

// Frontend mirror of the backend `provider_session_env`: the exact harness env
// vars a launch injects. The token is always masked — the real value never
// leaves the keychain. Returned as [key, value, isSecret] tuples.
function harnessEnvPreview(
  kind: string,
  endpoint: string,
  model: string,
  smallFastModel: string,
  hasToken: boolean,
): [string, string, boolean][] {
  const tok = hasToken ? "••••••••••••••••" : "‹your token›";
  const out: [string, string, boolean][] = [];
  if (kind === "anthropic" || kind === "anthropic-compatible") {
    if (endpoint.trim()) out.push(["ANTHROPIC_BASE_URL", endpoint.trim(), false]);
    out.push(["ANTHROPIC_AUTH_TOKEN", tok, true]);
    if (model.trim()) out.push(["ANTHROPIC_MODEL", model.trim(), false]);
    if (smallFastModel.trim())
      out.push(["ANTHROPIC_SMALL_FAST_MODEL", smallFastModel.trim(), false]);
  } else if (kind === "openai" || kind === "openai-compatible") {
    if (endpoint.trim()) out.push(["OPENAI_BASE_URL", endpoint.trim(), false]);
    out.push(["OPENAI_API_KEY", tok, true]);
  }
  return out;
}

function avatarHue(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function avatarInitials(label: string): string {
  const parts = label.split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

// Coding Agents — tabbed per-agent view with hero, API keys, OAuth accounts,
// and model providers as separate sections.
function AgentsPane({
  initialDetail,
}: {
  initialDetail?: AgentCli;
}) {
  const keyStatus = useStore((s) => s.keyStatus);
  const agentVersions = useStore((s) => s.agentVersions);
  const profiles = useStore((s) => s.accountProfiles);
  const providers = useStore((s) => s.providers);
  const loadProviders = useStore((s) => s.loadProviders);
  const setProviders = useStore((s) => s.setProviders);
  const loadAccountProfiles = useStore((s) => s.loadAccountProfiles);
  const removeAccountProfile = useStore((s) => s.removeAccountProfile);
  const renameAccountProfile = useStore((s) => s.renameAccountProfile);
  const setAccountProfileEnabled = useStore((s) => s.setAccountProfileEnabled);
  const [detail, setDetail] = useState<AgentCli | null>(initialDetail ?? null);
  const [selectedAgent, setSelectedAgent] = useState<AgentCli>("claude");
  const [keyDialog, setKeyDialog] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginProgress, setLoginProgress] = useState<AuthProgress | null>(null);
  const [terminalDialog, setTerminalDialog] = useState<{
    provider: string;
    profileId: string;
    sessionName: string;
    workspace: string;
  } | null>(null);
  const pendingProfileId = useRef<string | null>(null);
  const [managingId, setManagingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // The provider configuration modal. `editing` opens an existing provider; a bare
  // `{}` opens the add flow (the dialog seeds itself from the agent's catalog).
  const [providerDialog, setProviderDialog] = useState<{ editing?: ModelProvider } | null>(null);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    onAuthProgress((p) => {
      setLoginProgress(p);
      if (p.stage === "success") {
        setLoginBusy(null);
        setLoginError(null);
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

  useEffect(() => {
    void loadAccountProfiles();
    void loadProviders();
    // Backfill emails for subscriptions signed in before email capture, then
    // refresh so they show. Best-effort: failures (e.g. browser mode, no vault)
    // are silent and just leave the generic "Signed in with …" subtitle.
    void ipc
      .backfillAccountEmails()
      .then((n) => {
        if (n > 0) void loadAccountProfiles();
      })
      .catch(() => {});
  }, [loadAccountProfiles, loadProviders]);

  const defaultLoginLabel = (provider: string) =>
    provider === "github"
      ? "GitHub"
      : provider === "codex"
        ? "Codex"
        : provider === "antigravity"
          ? "Antigravity"
          : "Claude";

  const startLogin = async (provider: string, agent: string) => {
    setLoginBusy(provider);
    setLoginError(null);
    setLoginProgress(null);
    let createdId: string | null = null;
    try {
      const label = defaultLoginLabel(provider);
      const existingIds = new Set(profiles.map((p) => p.id));
      const list = await ipc.addAccountProfile(agent, label, undefined, "vault");
      useStore.setState({ accountProfiles: list });
      const created = list.find((p) => !existingIds.has(p.id));
      if (!created) throw new Error("profile creation failed");
      createdId = created.id;
      const result = await ipc.vaultInitiateOauth(provider, created.id);
      if (result?.sessionName && result?.workspace) {
        pendingProfileId.current = created.id;
        setTerminalDialog({
          provider,
          profileId: created.id,
          sessionName: result.sessionName,
          workspace: result.workspace,
        });
        setLoginBusy(null);
      }
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

  const startManage = (id: string, label: string) => {
    setManagingId(id);
    setRenameValue(label);
  };

  const saveRename = async (id: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    await renameAccountProfile(id, trimmed);
    setManagingId(null);
  };

  const confirmRemove = async (id: string, label: string) => {
    if (!window.confirm(`Remove account "${label}"? This cannot be undone.`)) return;
    await removeAccountProfile(id);
    setManagingId(null);
  };

  if (detail)
    return <AgentDetail agent={detail} onBack={() => setDetail(null)} onSwitch={setDetail} />;

  const key = keyStatus?.[selectedAgent];
  const ver = agentVersions?.[selectedAgent];
  const meta = AGENT_META[selectedAgent];
  const cliSpec = CLIS.find((c) => c.id === selectedAgent)!;
  const agentProfiles = profiles.filter((p) => p.agent === selectedAgent);
  const apiKeyProfiles = agentProfiles.filter((p) => p.source === "env");
  const oauthProfiles = agentProfiles.filter((p) => p.source === "vault");
  // Providers shown under this agent's tab: the ones whose harness env targets it.
  const agentProviders = providers.filter((p) => PROVIDER_TARGET_AGENT[p.kind] === selectedAgent);

  // Connection is satisfied by ANY credential, not just an API key — an OAuth
  // sign-in or an enabled custom provider counts too. The old badge keyed only
  // off the host env-var key, so it nagged "Key needed" even with OAuth active.
  const hasKey = Boolean(key?.present);
  const hasOauth = oauthProfiles.some((p) => p.present);
  // A provider only counts as a live connection once it's enabled, has a token,
  // and is a launch-wired kind (a gated OpenRouter row never counts).
  const hasEnabledProvider = agentProviders.some(
    (p) => p.enabled && p.hasToken && LAUNCHABLE_KINDS.has(p.kind),
  );
  // The native provider (Anthropic/OpenAI/Google) is reachable via either a host
  // API key or an OAuth sign-in — both are "native" credentials.
  const nativeConnected = hasKey || hasOauth;
  const connected = nativeConnected || hasEnabledProvider;
  const connectionVia = hasOauth
    ? "OAuth"
    : hasKey
      ? "API key"
      : hasEnabledProvider
        ? "custom provider"
        : null;

  const renderProfileRow = (p: (typeof profiles)[number], i: number, list: typeof profiles) => {
    const hue = avatarHue(p.id);
    const color = `oklch(0.55 0.12 ${hue})`;
    const isManaging = managingId === p.id;
    const off = !p.enabled;
    const restBg =
      i % 2 === 1 ? "color-mix(in oklab, var(--bg-1) 40%, var(--bg-2))" : "transparent";
    // Status: a disabled profile reads "Disabled" regardless of presence; an
    // enabled one shows whether its credential is actually available.
    const st = off
      ? { c: "var(--idle)", t: "Disabled", dot: "idle" as const }
      : p.present
        ? { c: "var(--live)", t: "Active", dot: "live" as const }
        : { c: "var(--err)", t: "Missing", dot: "err" as const };
    return (
      <div key={p.id}>
        <div
          className="hov-row"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "11px 14px 11px 16px",
            borderBottom:
              i === list.length - 1 && !isManaging ? "none" : "1px solid var(--bd-soft)",
            borderLeft: `3px solid color-mix(in oklab, ${color} ${off ? 22 : 50}%, var(--bd))`,
            background: restBg,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: `color-mix(in oklab, ${color} 25%, var(--bg-3))`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "var(--fs-12)",
              fontWeight: 600,
              color,
              flexShrink: 0,
              opacity: off ? 0.5 : 1,
            }}
          >
            {avatarInitials(p.label)}
          </div>
          <div style={{ flex: 1, minWidth: 0, opacity: off ? 0.6 : 1 }}>
            <div
              style={{
                fontSize: "var(--fs-13)",
                fontWeight: 500,
                color: "var(--fg-0)",
                marginBottom: 2,
              }}
            >
              {p.label}
            </div>
            <div
              className="mono"
              style={{
                fontSize: "var(--fs-11)",
                color: "var(--fg-2)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {p.source === "vault"
                ? p.present
                  ? // Show the account email when we captured it at sign-in, so
                    // multiple subscriptions on one agent are distinguishable;
                    // fall back to a generic line for older sign-ins.
                    (p.email ?? `Signed in with ${cliSpec.alias}`)
                  : "Sign-in expired — reconnect"
                : (p.varName ?? "API key")}
            </div>
          </div>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: "var(--fs-12)",
              color: st.c,
              whiteSpace: "nowrap",
            }}
          >
            <StatusDot status={st.dot} />
            {st.t}
          </span>
          <RowActions
            enabled={p.enabled}
            onToggle={(v) => void setAccountProfileEnabled(p.id, v)}
            toggleTitle={p.enabled ? "Disable — hide from spawn picker" : "Enable"}
            onEdit={() => (isManaging ? setManagingId(null) : startManage(p.id, p.label))}
            editActive={isManaging}
            onDelete={() => void confirmRemove(p.id, p.label)}
          />
        </div>
        {isManaging && (
          <div
            style={{
              padding: "10px 16px 12px",
              background: "var(--bg-1)",
              borderBottom: i === list.length - 1 ? "none" : "1px solid var(--bd-soft)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <label
              htmlFor={`rename-${p.id}`}
              className="lbl"
              style={{ flexShrink: 0, fontSize: "var(--fs-11)" }}
            >
              Name
            </label>
            <Input
              id={`rename-${p.id}`}
              type="text"
              className="h-auto"
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveRename(p.id);
                if (e.key === "Escape") setManagingId(null);
              }}
              style={{
                flex: 1,
                padding: "5px 10px",
                border: "1px solid var(--bd)",
                borderRadius: 6,
                background: "var(--bg-0)",
                color: "var(--fg-0)",
                fontSize: "var(--fs-13)",
                fontFamily: "var(--sans)",
                outline: "none",
              }}
            />
            <Button variant="ghost" size="xs" onClick={() => setManagingId(null)}>
              Cancel
            </Button>
            <Button
              size="xs"
              onClick={() => void saveRename(p.id)}
              disabled={!renameValue.trim() || renameValue.trim() === p.label}
            >
              Save
            </Button>
          </div>
        )}
      </div>
    );
  };

  const compatiblePresets = COMPATIBLE_PROVIDERS[selectedAgent];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {/* ── Agent tab bar ────────────────────────────────────────────── */}
      <TabBar style={{ marginBottom: 24 }}>
        {CLIS.map((c) => {
          const sel = selectedAgent === c.id;
          return (
            <Tab key={c.id} active={sel} onClick={() => setSelectedAgent(c.id)}>
              <AgentGlyph
                agent={c.id}
                size={14}
                color={sel ? AGENT_META[c.id].accent : "var(--fg-3)"}
              />
              {c.label}
            </Tab>
          );
        })}
      </TabBar>

      {/* ── Agent hero (compact) ─────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginBottom: 24,
          flexShrink: 0,
        }}
      >
        <Tip text="View agent details">
          <button
            type="button"
            onClick={() => setDetail(selectedAgent)}
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: `color-mix(in oklab, ${meta.accent} 14%, var(--bg-1))`,
              border: `1px solid color-mix(in oklab, ${meta.accent} 30%, var(--bd))`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <span style={{ transform: "scale(1.8)" }}>
              <AgentGlyph agent={selectedAgent} size={14} color={meta.accent} />
            </span>
          </button>
        </Tip>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: "var(--fs-16)", fontWeight: 600, color: "var(--fg-0)" }}>
              {cliSpec.label}
            </span>
            {ver?.version && <Tag>v{ver.version}</Tag>}
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
                background: connected
                  ? "color-mix(in oklab, var(--live) 12%, transparent)"
                  : "var(--bg-2)",
                color: connected ? "var(--live)" : "var(--fg-3)",
                border: connected ? "1px solid transparent" : "1px solid var(--bd-soft)",
              }}
            >
              <StatusDot status={connected ? "live" : "idle"} />
              {connected ? "Connected" : "Not connected"}
            </span>
            {connected && connectionVia && (
              <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                via {connectionVia}
              </span>
            )}
          </div>
          <p
            style={{
              margin: "3px 0 0",
              fontSize: "var(--fs-12)",
              color: "var(--fg-2)",
              lineHeight: 1.45,
            }}
          >
            {AGENT_DESCRIPTIONS[selectedAgent]}
          </p>
        </div>
      </div>

      {/* ── Three sections ───────────────────────────────────────────
          One card per credential method — Subscription Sign In, API Keys,
          Custom Model Providers — equally sized (flex 1 1 0), each with its own
          scrollable body. Empty sections render a centered empty state with a
          CTA; populated ones list rows + an "add another" row. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          paddingBottom: 24,
        }}
      >
        {/* 1 · Subscription Sign In (OAuth) */}
        <SectionCard
          title="Subscription Sign In"
          hint={`Use your ${cliSpec.alias} plan — no API key`}
          count={oauthProfiles.length}
          connected={hasOauth}
        >
          {oauthProfiles.length === 0 && !loginProgress && !loginError ? (
            <EmptyState
              accent={meta.accent}
              icon={<AgentGlyph agent={selectedAgent} size={18} color={meta.accent} />}
              title={`Use your ${cliSpec.alias} subscription`}
              hint={`Run on your existing ${cliSpec.alias} plan — no API key needed.`}
              cta={`Sign in with ${cliSpec.alias}`}
              onCta={() => startLogin(selectedAgent, selectedAgent)}
              busy={loginBusy === selectedAgent}
            />
          ) : (
            <>
              {oauthProfiles.map((p, i) => renderProfileRow(p, i, oauthProfiles))}
              <AddRow
                accent={meta.accent}
                label={
                  oauthProfiles.length
                    ? `Sign in with another ${cliSpec.alias} account`
                    : `Sign in with ${cliSpec.alias} — use your subscription`
                }
                onClick={() => startLogin(selectedAgent, selectedAgent)}
                disabled={loginBusy != null}
                busy={loginBusy === selectedAgent}
              />
            </>
          )}

          {loginProgress && loginProgress.stage !== "success" && (
            <div
              className="mono"
              style={{
                padding: "10px 14px",
                margin: "0 14px 10px",
                fontSize: "var(--fs-12)",
                color: loginProgress.stage === "error" ? "var(--err)" : "var(--fg-1)",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                background: "var(--bg-2)",
                border: "1px solid var(--bd-soft)",
                borderRadius: 8,
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
                    fontSize: "var(--fs-20)",
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
                <div style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                  {loginProgress.url}
                </div>
              )}
              {loginProgress.message && loginProgress.stage !== "error" && (
                <div style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
                  {loginProgress.message}
                </div>
              )}
            </div>
          )}

          {loginProgress?.stage === "success" && (
            <div
              className="mono"
              style={{
                margin: "0 14px 10px",
                padding: "8px 12px",
                borderRadius: 6,
                background: "color-mix(in oklab, var(--live) 8%, var(--bg-2))",
                border: "1px solid color-mix(in oklab, var(--live) 30%, var(--bd))",
                fontSize: "var(--fs-12)",
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
                margin: "0 14px 10px",
                padding: "8px 12px",
                borderRadius: 6,
                background: "color-mix(in oklab, var(--err) 8%, var(--bg-2))",
                border: "1px solid color-mix(in oklab, var(--err) 30%, var(--bd))",
                fontSize: "var(--fs-12)",
                color: "var(--err)",
              }}
            >
              {loginError}
            </div>
          )}
        </SectionCard>

        {/* 2 · API Keys */}
        <SectionCard
          title="API Keys"
          hint="Connect with a provider API key — no sign-in"
          count={apiKeyProfiles.length}
          connected={hasKey}
        >
          {apiKeyProfiles.length === 0 ? (
            <EmptyState
              icon={Ico.link}
              title="No API keys yet"
              hint="Paste a provider key to connect without signing in — stored in your OS keychain."
              cta="Add API key"
              ctaIcon={Ico.plus}
              onCta={() => setKeyDialog(selectedAgent)}
            />
          ) : (
            <>
              {apiKeyProfiles.map((p, i) => renderProfileRow(p, i, apiKeyProfiles))}
              <AddRow
                accent={meta.accent}
                label="Add another API key"
                onClick={() => setKeyDialog(selectedAgent)}
              />
            </>
          )}
        </SectionCard>

        {/* 3 · Custom Model Providers — configured rows + add-row open the config
            dialog; enabled + tokened providers become spawn-dialog credentials. */}
        <SectionCard
          title="Custom Model Providers"
          hint={`Route ${cliSpec.label} to a token-plan endpoint`}
          count={agentProviders.length}
          connected={hasEnabledProvider}
        >
          {compatiblePresets.length === 0 ? (
            <EmptyState
              icon={Ico.hub}
              title="Not available here"
              hint={`${cliSpec.label} doesn't support custom model endpoints — only its native provider.`}
            />
          ) : agentProviders.length === 0 ? (
            <EmptyState
              icon={Ico.hub}
              title="No custom providers"
              hint={`Route ${cliSpec.label} to a token-plan endpoint — MiniMax, z.ai, or a custom API.`}
              cta="Add provider"
              ctaIcon={Ico.plus}
              onCta={() => setProviderDialog({})}
            />
          ) : (
            <>
              {agentProviders.map((p, i) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  zebra={i % 2 === 1}
                  last={false}
                  onOpen={() => setProviderDialog({ editing: p })}
                  onToggle={async (enabled) => {
                    const list = await ipc.updateProvider(p.id, undefined, undefined, enabled);
                    setProviders(list);
                  }}
                  onDelete={async () => {
                    if (!window.confirm(`Remove provider "${p.name}"? This cannot be undone.`))
                      return;
                    setProviders(await ipc.removeProvider(p.id));
                  }}
                />
              ))}
              <AddRow
                accent={meta.accent}
                label="Add another model provider"
                onClick={() => setProviderDialog({})}
              />
            </>
          )}
        </SectionCard>
      </div>

      {providerDialog && (
        <ProviderConfigDialog
          agent={selectedAgent}
          editing={providerDialog.editing}
          onClose={() => setProviderDialog(null)}
        />
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
    </div>
  );
}

// Shared full-width "add" row — the single add affordance used by every
// Coding-Agents section (API Keys, OAuth, Model Providers) so they read alike:
// a dashed plus-tile + a descriptive label. On hover the row highlights and the
// tile takes the agent accent (border + tint + glyph) so the affordance lights up.
function AddRow({
  label,
  onClick,
  disabled,
  busy,
  accent = "var(--pri)",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  accent?: string;
}) {
  const [hov, setHov] = useState(false);
  const live = !disabled && !busy;
  const lit = hov && live;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: "100%",
        padding: "12px 14px",
        display: "flex",
        alignItems: "center",
        gap: 11,
        border: "none",
        background: lit ? "var(--bg-hover)" : "transparent",
        cursor: live ? "pointer" : "default",
        fontFamily: "var(--sans)",
        transition: "background 0.12s ease",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          border: `1px dashed ${lit ? accent : "var(--bd)"}`,
          background: lit ? `color-mix(in oklab, ${accent} 12%, transparent)` : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "var(--fs-14)",
          color: lit ? accent : "var(--fg-3)",
          flexShrink: 0,
          transition: "color 0.14s ease, border-color 0.14s ease, background 0.14s ease",
        }}
      >
        {Ico.plus}
      </span>
      <span
        style={{
          fontSize: "var(--fs-13)",
          color: lit ? "var(--fg-0)" : "var(--fg-1)",
          textAlign: "left",
          transition: "color 0.12s ease",
        }}
      >
        {busy ? "Working…" : label}
      </span>
    </button>
  );
}

// Trailing action cluster shared by every credential row (accounts + providers):
// an optional enable/disable Switch, an edit (rename/configure) button, and a
// delete button. All three stop propagation so they don't trigger a clickable
// parent row, and the delete tints red on hover.
function RowActions({
  enabled,
  showToggle = true,
  toggleDisabled,
  toggleTitle,
  onToggle,
  onEdit,
  editActive,
  editTitle = "Edit",
  onDelete,
  deleteTitle = "Delete",
}: {
  enabled: boolean;
  showToggle?: boolean;
  toggleDisabled?: boolean;
  toggleTitle?: string;
  onToggle: (v: boolean) => void;
  onEdit: () => void;
  editActive?: boolean;
  editTitle?: string;
  onDelete: () => void;
  deleteTitle?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
      {showToggle && (
        <Tip text={toggleTitle ?? ""}>
          <span
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
            style={{ display: "inline-flex", marginRight: 5 }}
          >
            <Switch checked={enabled} disabled={toggleDisabled} onCheckedChange={onToggle} />
          </span>
        </Tip>
      )}
      <IconBtn
        title={editTitle}
        active={editActive}
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
      >
        {Ico.edit}
      </IconBtn>
      <IconBtn
        title={deleteTitle}
        danger
        hoverColor="var(--err)"
        hoverBg="color-mix(in oklab, var(--err) 14%, transparent)"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        {Ico.trash}
      </IconBtn>
    </div>
  );
}

// One Coding-Agents credential section: a self-contained card with a sticky
// header (status dot + title + count chip + hint) and an independently
// scrollable body. All three sections are equally sized (flex 1 1 0) so the
// pane reads as a clean, even three-up stack.
function SectionCard({
  title,
  hint,
  count,
  connected,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  connected: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className="ch-card"
      style={{
        flex: "1 1 0",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        padding: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "11px 16px",
          borderBottom: "1px solid var(--bd-soft)",
          flexShrink: 0,
        }}
      >
        <StatusDot status={connected ? "live" : "idle"} />
        <span style={{ fontSize: "var(--fs-13)", fontWeight: 600, color: "var(--fg-0)" }}>
          {title}
        </span>
        <span
          className="mono tnum"
          style={{
            fontSize: "var(--fs-10)",
            color: count ? "var(--fg-1)" : "var(--fg-3)",
            background: "var(--bg-3)",
            border: "1px solid var(--bd-soft)",
            borderRadius: 999,
            padding: "1px 7px",
            minWidth: 20,
            textAlign: "center",
          }}
        >
          {count}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
          {hint}
        </span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {children}
      </div>
    </section>
  );
}

// Centered empty state for a section with no items — an accent-tinted icon tile,
// a short headline, a one-line hint, and (optionally) a primary CTA. Fills the
// card body via minHeight:100% so the equal-sized cards never look hollow.
function EmptyState({
  icon,
  accent = "var(--fg-2)",
  title,
  hint,
  cta,
  ctaIcon,
  onCta,
  busy,
}: {
  icon: ReactNode;
  accent?: string;
  title: string;
  hint: string;
  cta?: string;
  ctaIcon?: ReactNode;
  onCta?: () => void;
  busy?: boolean;
}) {
  return (
    <div
      style={{
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        padding: "14px 20px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 11,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: `color-mix(in oklab, ${accent} 13%, var(--bg-1))`,
          border: `1px solid color-mix(in oklab, ${accent} 26%, var(--bd))`,
          color: accent,
        }}
      >
        <span style={{ display: "inline-flex", transform: "scale(1.1)" }}>{icon}</span>
      </div>
      <div style={{ fontSize: "var(--fs-13)", fontWeight: 600, color: "var(--fg-0)" }}>{title}</div>
      <div
        style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)", maxWidth: 280, lineHeight: 1.45 }}
      >
        {hint}
      </div>
      {cta && onCta && (
        // Filled (primary) so the section's main action reads as clearly
        // actionable — an outline button on this dark surface looked disabled.
        <Button size="sm" onClick={onCta} disabled={busy} style={{ marginTop: 3 }}>
          {ctaIcon}
          {busy ? "Working…" : cta}
        </Button>
      )}
    </div>
  );
}

// One configured-provider row. Clicking the row (or its edit button) opens the
// config dialog; the trailing cluster has a quick enable/disable toggle (only
// when launch-wired + tokened), plus explicit edit + delete buttons.
function ProviderRow({
  provider,
  zebra,
  last,
  onOpen,
  onToggle,
  onDelete,
}: {
  provider: ModelProvider;
  zebra: boolean;
  last: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const p = provider;
  const hue = avatarHue(p.name);
  const color = `oklch(0.55 0.12 ${hue})`;
  const launchable = LAUNCHABLE_KINDS.has(p.kind);
  const status = !launchable
    ? { c: "var(--wait)", t: "Needs proxy" }
    : !p.hasToken
      ? { c: "var(--wait)", t: "Token needed" }
      : !p.enabled
        ? { c: "var(--idle)", t: "Disabled" }
        : { c: "var(--live)", t: "Active" };
  const rest = zebra ? "color-mix(in oklab, var(--bg-1) 40%, var(--bg-2))" : "transparent";
  const [hov, setHov] = useState(false);
  return (
    // A div, not a button: the row holds a nested Switch (itself a button), so a
    // <button> wrapper would be invalid DOM. role/tabIndex keep it keyboard-open.
    // biome-ignore lint/a11y/useSemanticElements: a <button> can't wrap the nested Switch button
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: "100%",
        textAlign: "left",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "11px 14px",
        borderBottom: last ? "none" : "1px solid var(--bd-soft)",
        borderLeft: `3px solid color-mix(in oklab, ${color} ${hov ? 90 : 50}%, var(--bd))`,
        background: hov ? "var(--bg-hover)" : rest,
        cursor: "pointer",
        transition: "background 0.12s ease, border-color 0.14s ease",
        fontFamily: "var(--sans)",
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: `color-mix(in oklab, ${color} 25%, var(--bg-3))`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "var(--fs-12)",
          fontWeight: 600,
          color,
          flexShrink: 0,
        }}
      >
        {p.name[0]}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--fs-13)", fontWeight: 500, color: "var(--fg-0)" }}>
          {p.name}
        </div>
        <div
          className="mono"
          style={{
            fontSize: "var(--fs-11)",
            color: "var(--fg-2)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {p.model ?? p.models[0] ?? p.kind}
          {p.endpoint ? ` · ${p.endpoint.replace(/^https?:\/\//, "")}` : ""}
        </div>
      </div>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: "var(--fs-11)",
          color: status.c,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: status.c }} />
        {status.t}
      </span>
      {/* Toggle only when the provider can actually launch (a disabled switch
          reads as broken); edit + delete are always available. */}
      <RowActions
        enabled={p.enabled}
        showToggle={launchable && p.hasToken}
        toggleTitle={p.enabled ? "Disable — hide from spawn picker" : "Enable"}
        onToggle={onToggle}
        onEdit={onOpen}
        editTitle="Configure"
        onDelete={onDelete}
      />
    </div>
  );
}

// A catalog card in the "connect a provider" gallery. Clicking opens the config
// sub-view seeded from this preset.
function ProviderCatalogCard({
  preset,
  onClick,
  selected,
}: {
  preset: ProviderPreset;
  onClick: () => void;
  selected?: boolean;
}) {
  const hue = avatarHue(preset.name);
  const color = `oklch(0.55 0.12 ${hue})`;
  return (
    <button
      type="button"
      onClick={onClick}
      className="ch-card-interactive"
      style={{
        textAlign: "left",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 7,
        cursor: "pointer",
        boxShadow: selected ? "inset 0 0 0 1.5px var(--pri)" : undefined,
        background: selected ? "var(--pri-dim)" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: preset.custom
              ? "transparent"
              : `color-mix(in oklab, ${color} 25%, var(--bg-3))`,
            border: preset.custom ? "1px dashed var(--bd)" : "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "var(--fs-11)",
            fontWeight: 600,
            color: preset.custom ? "var(--fg-3)" : color,
            flexShrink: 0,
          }}
        >
          {preset.custom ? Ico.plus : preset.name[0]}
        </div>
        <span
          style={{
            fontSize: "var(--fs-13)",
            fontWeight: 500,
            color: "var(--fg-0)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {preset.name}
        </span>
        <span style={{ flex: 1 }} />
        {preset.gated ? (
          <span
            className="mono"
            style={{
              fontSize: "var(--fs-9)",
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--wait)",
              background: "color-mix(in oklab, var(--wait) 14%, transparent)",
              padding: "1px 6px",
              borderRadius: 4,
              flexShrink: 0,
            }}
          >
            gated
          </span>
        ) : selected ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "var(--pri)",
              color: "var(--bg-0)",
              flexShrink: 0,
            }}
          >
            {Ico.check}
          </span>
        ) : null}
      </div>
      <span
        className="mono"
        style={{
          fontSize: "var(--fs-10)",
          color: "var(--fg-2)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {preset.blurb}
      </span>
    </button>
  );
}

// Modal provider configuration: pick a preset (MiniMax, z.ai, or a custom
// endpoint), set the base URL + keychain token + models, and preview the exact
// harness env vars a launch injects. Edits an existing provider, or adds a new
// one seeded from the chosen catalog preset.
function ProviderConfigDialog({
  agent,
  editing,
  onClose,
}: {
  agent: AgentCli;
  editing?: ModelProvider;
  onClose: () => void;
}) {
  const setProviders = useStore((s) => s.setProviders);
  const catalog = catalogFor(agent);
  // Preset selection drives the add flow; editing skips it (the kind is fixed).
  const [presetId, setPresetId] = useState<string | null>(
    editing ? null : (catalog[0]?.id ?? null),
  );
  const preset = editing ? undefined : catalog.find((p) => p.id === presetId);
  const kind = editing?.kind ?? preset?.kind ?? "anthropic-compatible";

  const [name, setName] = useState(editing?.name ?? "");
  const [endpoint, setEndpoint] = useState(editing?.endpoint ?? "");
  const [model, setModel] = useState(editing?.model ?? "");
  const [smallFast, setSmallFast] = useState(editing?.smallFastModel ?? "");
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(editing?.hasToken ?? false);
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  // Seed the form from the chosen preset (add flow only). Re-runs when the user
  // switches preset — a new template, so name/endpoint/models reset. The typed
  // token is independent of the template, so it's left alone.
  useEffect(() => {
    if (editing) return;
    const p = catalog.find((x) => x.id === presetId);
    setName(p?.custom ? "" : (p?.name ?? ""));
    setEndpoint(p?.baseUrl ?? "");
    setModel(p?.model ?? "");
    setSmallFast(p?.smallFastModel ?? "");
  }, [presetId, editing, catalog]);

  const presetModels = preset?.models.length ? preset.models : (editing?.models ?? []);
  const isAnthropic = kind === "anthropic" || kind === "anthropic-compatible";
  const gated = (preset?.gated ?? false) || !LAUNCHABLE_KINDS.has(kind);
  const note = preset?.note;
  const gatedReason = preset?.gatedReason;
  const docsUrl = preset?.docsUrl;
  const tokenLabel = preset?.tokenLabel ?? "API token";

  const endpointMissing = !endpoint.trim();
  const canSave = Boolean(name.trim()) && !endpointMissing && !saving && !gated;
  const tokenReady = hasToken || token.trim().length > 0;
  const env = harnessEnvPreview(kind, endpoint, model, smallFast, tokenReady);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const models = presetModels.length ? presetModels : model.trim() ? [model.trim()] : [];
      let list: ModelProvider[];
      let id = editing?.id;
      if (editing) {
        list = await ipc.updateProvider(
          editing.id,
          name.trim(),
          endpoint.trim() || undefined,
          enabled,
          models,
          model.trim() || undefined,
          smallFast.trim() || undefined,
        );
      } else {
        const before = new Set(useStore.getState().providers.map((p) => p.id));
        list = await ipc.addProvider(
          name.trim(),
          kind,
          endpoint.trim() || undefined,
          undefined,
          models,
          model.trim() || undefined,
          smallFast.trim() || undefined,
        );
        id = list.find((p) => !before.has(p.id))?.id ?? id;
      }
      if (id && token.trim()) {
        list = await ipc.setProviderToken(id, token.trim());
      }
      setProviders(list);
      onClose();
    } catch (e) {
      console.error("provider save failed", e);
    } finally {
      setSaving(false);
    }
  };

  const removeIt = async () => {
    if (!editing) return;
    if (!window.confirm(`Remove provider "${editing.name}"? This cannot be undone.`)) return;
    const list = await ipc.removeProvider(editing.id);
    setProviders(list);
    onClose();
  };

  const clearToken = async () => {
    if (!editing) return;
    const list = await ipc.setProviderToken(editing.id, "");
    setProviders(list);
    setHasToken(false);
  };

  const FieldLabel = ({ children }: { children: ReactNode }) => (
    <Label className="lbl" style={{ marginBottom: 6, display: "block" }}>
      {children}
    </Label>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: `color-mix(in oklab, ${AGENT_META[agent].accent} 14%, var(--bg-1))`,
                border: `1px solid color-mix(in oklab, ${AGENT_META[agent].accent} 28%, var(--bd))`,
                color: AGENT_META[agent].accent,
              }}
            >
              <span style={{ display: "inline-flex", transform: "scale(1.1)" }}>
                <AgentGlyph agent={agent} size={16} color={AGENT_META[agent].accent} />
              </span>
            </div>
            <div style={{ minWidth: 0 }}>
              <DialogTitle>
                {editing ? `Configure ${editing.name}` : "Add model provider"}
              </DialogTitle>
              <DialogDescription style={{ marginTop: 2 }}>
                Route {AGENT_META[agent].name} to a token-plan endpoint — the token stays in your OS
                keychain.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Outer = scroller (block); inner flex column sizes to content so the
            fields + harness card keep their natural height instead of shrinking. */}
        <div
          className="scroll"
          style={{
            maxHeight: "min(58vh, 540px)",
            overflowY: "auto",
            margin: "0 -2px",
            padding: "2px 2px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* preset picker — add flow only (editing has a fixed kind) */}
            {!editing && catalog.length > 0 && (
              <div>
                <FieldLabel>Provider</FieldLabel>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: 8,
                  }}
                >
                  {catalog.map((p) => (
                    <ProviderCatalogCard
                      key={p.id}
                      preset={p}
                      selected={presetId === p.id}
                      onClick={() => setPresetId(p.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {gated && gatedReason && (
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "12px 14px",
                  borderRadius: 8,
                  background: "color-mix(in oklab, var(--wait) 9%, var(--bg-1))",
                  border: "1px solid color-mix(in oklab, var(--wait) 35%, var(--bd))",
                }}
              >
                <span style={{ color: "var(--wait)", flexShrink: 0, marginTop: 1 }}>
                  {Ico.bell}
                </span>
                <div>
                  <div
                    style={{
                      fontSize: "var(--fs-13)",
                      fontWeight: 600,
                      color: "var(--fg-0)",
                      marginBottom: 3,
                    }}
                  >
                    Not one-click yet
                  </div>
                  <div style={{ fontSize: "var(--fs-12)", color: "var(--fg-1)", lineHeight: 1.5 }}>
                    {gatedReason}
                  </div>
                  {docsUrl && (
                    <div
                      className="mono"
                      style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)", marginTop: 6 }}
                    >
                      {docsUrl}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* form — dimmed + inert when the selected kind can't be launch-wired */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 16,
                opacity: gated ? 0.55 : 1,
                pointerEvents: gated ? "none" : "auto",
              }}
            >
              {note && (
                <p
                  style={{
                    margin: 0,
                    fontSize: "var(--fs-12)",
                    color: "var(--fg-2)",
                    lineHeight: 1.5,
                  }}
                >
                  {note}
                </p>
              )}

              <div>
                <FieldLabel>Display name</FieldLabel>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. z.ai Coding Plan"
                  spellCheck={false}
                />
              </div>

              <div>
                <FieldLabel>Base URL</FieldLabel>
                <Input
                  className="font-mono"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://api.example.com/anthropic"
                  spellCheck={false}
                  aria-invalid={endpointMissing}
                />
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--fs-11)",
                    color: endpointMissing ? "var(--err)" : "var(--fg-3)",
                  }}
                >
                  {endpointMissing
                    ? "Base URL is required."
                    : isAnthropic
                      ? "Injected as ANTHROPIC_BASE_URL."
                      : "Injected as OPENAI_BASE_URL."}
                </span>
              </div>

              <div>
                <FieldLabel>{tokenLabel}</FieldLabel>
                <Input
                  type="password"
                  className="font-mono"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={hasToken ? "•••••••••••• (stored)" : `Paste your ${tokenLabel}`}
                  spellCheck={false}
                  autoComplete="off"
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: "var(--fs-11)",
                      color: hasToken ? "var(--live)" : "var(--fg-3)",
                    }}
                  >
                    {hasToken
                      ? "Stored in the OS keychain — type to replace."
                      : "Stored in the OS keychain, never written to disk."}
                  </span>
                  {hasToken && editing && (
                    <Button
                      variant="link"
                      onClick={() => void clearToken()}
                      className="h-auto p-0 text-[11px] text-[var(--err)]"
                    >
                      Remove token
                    </Button>
                  )}
                </div>
              </div>

              <div>
                <FieldLabel>{isAnthropic ? "Primary model" : "Model"}</FieldLabel>
                <Input
                  className="font-mono"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="model-id"
                  spellCheck={false}
                />
                {presetModels.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
                    {presetModels.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setModel(m)}
                        style={{
                          padding: "2px 8px",
                          borderRadius: 4,
                          border: model === m ? "1px solid var(--pri)" : "1px solid var(--bd)",
                          background: model === m ? "var(--pri-dim)" : "var(--bg-1)",
                          color: "var(--fg-1)",
                          fontFamily: "var(--mono)",
                          fontSize: "var(--fs-11)",
                          cursor: "pointer",
                        }}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {isAnthropic && (
                <div>
                  <FieldLabel>Background model · optional</FieldLabel>
                  <Input
                    className="font-mono"
                    value={smallFast}
                    onChange={(e) => setSmallFast(e.target.value)}
                    placeholder="fast model id"
                    spellCheck={false}
                  />
                  <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                    ANTHROPIC_SMALL_FAST_MODEL — used for quick background tasks.
                  </span>
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  paddingTop: 14,
                  borderTop: "1px solid var(--bd-soft)",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "var(--fs-13)", color: "var(--fg-0)" }}>Enabled</div>
                  <div style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
                    Offer this provider as a credential in the spawn dialog.
                  </div>
                </div>
                <Switch checked={enabled} disabled={!tokenReady} onCheckedChange={setEnabled} />
              </div>
            </div>

            {/* harness env preview — the exact vars a launch injects */}
            <div className="ch-card" style={{ padding: 0, overflow: "hidden" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--bd-soft)",
                }}
              >
                <span style={{ fontSize: "var(--fs-12)", fontWeight: 600, color: "var(--fg-0)" }}>
                  Harness injection
                </span>
                <span style={{ flex: 1 }} />
                <StatusDot status={tokenReady && !gated ? "live" : "idle"} />
                <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                  {gated ? "not wired" : tokenReady ? "ready" : "needs token"}
                </span>
              </div>
              <div style={{ padding: "12px 14px" }}>
                {env.length === 0 ? (
                  <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                    Nothing — this kind isn't launch-wired.
                  </div>
                ) : (
                  <div
                    className="mono"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      fontSize: "var(--fs-11)",
                      lineHeight: 1.5,
                      background: "var(--bg-0)",
                      border: "1px solid var(--bd-soft)",
                      borderRadius: 6,
                      padding: "10px 12px",
                      overflowX: "auto",
                    }}
                  >
                    {env.map(([k, v, secret]) => (
                      <div key={k} style={{ whiteSpace: "nowrap" }}>
                        <span style={{ color: "var(--pri)" }}>{k}</span>
                        <span style={{ color: "var(--fg-3)" }}>=</span>
                        <span style={{ color: secret ? "var(--wait)" : "var(--fg-1)" }}>{v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          {editing && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void removeIt()}
              style={{ marginRight: "auto", color: "var(--err)" }}
            >
              Remove provider
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            {saving ? "Saving…" : editing ? "Save" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// General — workspace-level defaults, all live (config store). "Confirm before
// closing" gates the ⌘W / close-button kill; the Startup toggles gate the boot
// lifecycle's tmux-session adoption + last-tab restore (store bootstrap).
function GeneralPane() {
  const restore = useStore((s) => s.config?.restoreSessionsOnLaunch ?? true);
  return (
    <div>
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
  { name: "Dashboard · Settings", d: "full", w: "full" },

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
    name: "Credentials via keychain (API key + OAuth)",
    d: "full",
    w: "server",
    note: "Desktop stores in OS keychain · web stores secrets server-side",
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
    <div>
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
              fontSize: "var(--fs-20)",
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
              fontSize: "var(--fs-13)",
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
        <span className="lbl" style={{ fontSize: "var(--fs-11)" }}>
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
            fontSize: "var(--fs-11)",
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
                fontSize: "var(--fs-11)",
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
                fontSize: "var(--fs-12)",
              }}
            >
              <span style={{ color: "var(--fg-0)" }}>{r.name}</span>
              <span style={{ textAlign: "center" }}>
                <SupportChip tone={r.d} />
              </span>
              <span style={{ textAlign: "center" }}>
                <SupportChip tone={r.w} />
              </span>
              <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
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
            fontSize: "var(--fs-12)",
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
        fontSize: "var(--fs-12)",
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
        fontSize: "var(--fs-11)",
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

// Notifications — desktop notification PREFERENCES. The three flags persist for
// real (config::Settings → settings.json) AND drive real OS delivery: the event
// tailer reads the ConfigStore at event time and fires a tauri-plugin-notification
// toast on a permission prompt (await-input) or turn end (turn-finish), with an
// optional sound. Delivery is live in the packaged desktop app; the browser dev
// bridge (`make dev-web`) has no Tauri window so it persists the choice but emits
// no toast — that's the one place a saved toggle won't fire.
function NotificationsPane() {
  return (
    <div>
      <PaneHead title="Notifications">
        How CodeHub should alert you when an agent needs attention while its window isn't focused.
      </PaneHead>

      <SectionHead label="Ambient surface" />
      <SettingRow
        label="Dynamic Island · live activity"
        desc="macOS: a notch widget that auto-pops when an agent awaits input, finishes, or fails. Other platforms: a floating companion window. On by default; ⌘⇧J toggles it anytime."
        control={<CompanionToggle />}
        live
        last
      />

      <SectionHead label="Desktop notifications" />
      <p
        style={{
          margin: "0 0 8px",
          fontSize: "var(--fs-12)",
          color: "var(--fg-2)",
          lineHeight: 1.5,
        }}
      >
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
          fontSize: "var(--fs-12)",
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
        <span className="mono" style={{ fontSize: "var(--fs-11)" }}>
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
          <span className="mono" style={{ fontSize: "var(--fs-11)", letterSpacing: "0.08em" }}>
            LIVE ACTIVITIES
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: "var(--fs-11)" }}>3 active</span>
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
                fontSize: "var(--fs-11)",
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
            fontSize: "var(--fs-12)",
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
    <Tip text="Claude · turn 04:12">
      <span
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
          <circle
            cx="7"
            cy="7"
            r={r}
            stroke="rgba(255,255,255,0.18)"
            strokeWidth="1.4"
            fill="none"
          />
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
        <span style={{ fontSize: "var(--fs-11)", color: "#fff" }}>Refactor auth</span>
        <span
          className="mono"
          style={{ fontSize: "var(--fs-11)", color: "rgba(255,255,255,0.65)" }}
        >
          04:12
        </span>
      </span>
    </Tip>
  );
}

export function LiveActivityStateGrid() {
  return (
    <div style={{ marginTop: 10, marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: "var(--fs-13)", fontWeight: 600, color: "var(--fg-0)" }}>
          States
        </span>
        <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
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
          <span style={{ fontSize: "var(--fs-13)", fontWeight: 500, color: "var(--fg-0)" }}>
            {title}
          </span>
        </div>
        <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
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
          fontSize: "var(--fs-12)",
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
          <span style={{ fontSize: "var(--fs-13)", fontWeight: 500, whiteSpace: "nowrap" }}>
            Codex needs permission
          </span>
          <span style={{ fontSize: "var(--fs-11)", color: "rgba(255,255,255,0.58)" }}>
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
          <span style={{ fontSize: "var(--fs-13)", fontWeight: 500 }}>Claude failed</span>
          <span style={{ fontSize: "var(--fs-11)", color: "rgba(255,255,255,0.58)" }}>
            ENOENT /tmp/snap-3
          </span>
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
          fontSize: "var(--fs-12)",
          alignItems: "stretch",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 14px" }}>
          <AgentGlyph agent="claude" size={13} color="oklch(0.78 0.13 35)" />
          <span>refactor auth</span>
          <span
            className="tnum"
            style={{ color: "rgba(255,255,255,0.55)", fontSize: "var(--fs-11)" }}
          >
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
          fontSize: "var(--fs-12)",
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
            fontSize: "var(--fs-11)",
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
          <span style={{ fontSize: "var(--fs-12)", fontWeight: 500 }}>
            Claude finished refactor
          </span>
          <span style={{ fontSize: "var(--fs-11)", color: "rgba(255,255,255,0.58)" }}>
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
        <span style={{ fontSize: "var(--fs-12)" }}>Claude · refactor auth</span>
        <span style={{ fontSize: "var(--fs-10)", color: "rgba(255,255,255,0.55)" }}>
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
        <span style={{ fontSize: "var(--fs-13)", fontWeight: 600 }}>Claude · aurora-api</span>
        <span
          className="mono"
          style={{ fontSize: "var(--fs-11)", color: "rgba(255,255,255,0.55)" }}
        >
          opus · feat/auth
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="mono"
          style={{ fontSize: "var(--fs-11)", color: "rgba(255,255,255,0.65)" }}
        >
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
          fontSize: "var(--fs-12)",
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
        fontSize: "var(--fs-12)",
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
        <span style={{ fontSize: "var(--fs-12)", fontWeight: 600 }}>CodeHub</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: "var(--fs-11)", color: "rgba(255,255,255,0.45)" }}>
          {meta.split(" · ").at(-1)}
        </span>
      </div>
      <div style={{ fontSize: "var(--fs-12)", marginBottom: 2 }}>{title}</div>
      <div className="mono" style={{ fontSize: "var(--fs-11)", color: "rgba(255,255,255,0.56)" }}>
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
        <span className="lbl" style={{ fontSize: "var(--fs-11)" }}>
          {os}
        </span>
        <span style={{ flex: 1, height: 1, background: "var(--bd-soft)" }} />
        <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
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
          <span style={{ fontSize: "var(--fs-13)", fontWeight: 600 }}>CodeHub</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: "var(--fs-11)", color: "rgba(255,255,255,0.5)" }}>now</span>
        </div>
        <div style={{ fontSize: "var(--fs-12)", fontWeight: 600, marginBottom: 1 }}>
          Codex needs permission
        </div>
        <div style={{ fontSize: "var(--fs-12)", color: "rgba(255,255,255,0.72)" }}>
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
        <span style={{ fontSize: "var(--fs-12)", color: "rgba(255,255,255,0.70)" }}>CodeHub</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: "var(--fs-11)", color: "rgba(255,255,255,0.5)" }}>1m ago</span>
      </div>
      <div style={{ fontSize: "var(--fs-13)", fontWeight: 600, marginBottom: 2 }}>
        Claude finished refactor
      </div>
      <div style={{ fontSize: "var(--fs-12)", color: "rgba(255,255,255,0.75)" }}>
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
        <div style={{ fontSize: "var(--fs-13)", fontWeight: 600, marginBottom: 1 }}>
          Claude failed · dash-web
        </div>
        <div
          className="mono"
          style={{
            fontSize: "var(--fs-11)",
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
    <div>
      <PaneHead title="Appearance">
        Theme and terminal font size apply instantly and are remembered on this machine.
      </PaneHead>

      <SectionHead label="Theme" />
      <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "14px 0" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "var(--fs-13)", color: "var(--fg-0)", marginBottom: 2 }}>
            Color theme
          </div>
          <div style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>
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
    <Switch
      checked={on}
      onCheckedChange={(checked) => void updateConfig({ [field]: checked } as Partial<AppSettings>)}
      disabled={disabled}
    />
  );
}

// Master enable for the ambient surface (macOS Dynamic Island / companion
// window). Persists `showCompanion` AND shows/hides immediately — the macOS
// island feed also reacts to the setting within ~1s, but the explicit open/close
// makes the toggle feel instant on every platform.
function CompanionToggle() {
  const on = useStore((s) => Boolean(s.config?.showCompanion));
  const updateConfig = useStore((s) => s.updateConfig);
  return (
    <Switch
      checked={on}
      onCheckedChange={(checked) => {
        void updateConfig({ showCompanion: checked } as Partial<AppSettings>);
        void (checked ? ipc.openCompanion() : ipc.closeCompanion()).catch(() => {});
      }}
    />
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
        fontSize: "var(--fs-14)",
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
          fontSize: "var(--fs-12)",
          color: "var(--fg-0)",
        }}
      >
        {size} px
      </span>
      <StepBtn d={1} label="Increase font size" />
    </div>
  );
}

function SectionHead({ label, tone }: { label: string; tone?: "err" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "24px 0 12px" }}>
      <span
        className="lbl"
        style={{ color: tone === "err" ? "var(--err)" : "var(--fg-1)", fontSize: "var(--fs-11)" }}
      >
        {label}
      </span>
      <span style={{ flex: 1, height: 1, background: "var(--bd-soft)" }} />
    </div>
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
        <div style={{ fontSize: "var(--fs-13)", color: "var(--fg-0)", marginBottom: 2 }}>
          {label}
        </div>
        <div style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>{desc}</div>
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
