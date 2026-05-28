import { AppShell } from "@/app/components/chrome/AppShell";
import { Sidebar } from "@/app/components/chrome/Sidebar";
import { SidebarRail } from "@/app/components/chrome/SidebarRail";
import { WorkspaceTab } from "@/app/components/chrome/WorkspaceTab";
import { AccountAvatar } from "@/app/components/primitives/AccountAvatar";
import { AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import type { AgentId } from "@/app/components/primitives/AgentGlyph";
import { ContextGauge } from "@/app/components/primitives/ContextGauge";
import { IconBtn } from "@/app/components/primitives/IconBtn";
import { Logo } from "@/app/components/primitives/Logo";
import { MetricStat } from "@/app/components/primitives/MetricStat";
import { Spark } from "@/app/components/primitives/Spark";
import { StatusBadge } from "@/app/components/primitives/StatusBadge";
import { STATUS, StatusDot } from "@/app/components/primitives/StatusDot";
import type { StatusKey } from "@/app/components/primitives/StatusDot";
import { Tag } from "@/app/components/primitives/Tag";
import { SNIPPETS, TermBlock } from "@/app/components/primitives/TermBlock";
import { Ico } from "@/app/components/primitives/icons";
import { Badge } from "@/app/ui/badge";
import { Button } from "@/app/ui/button";
import { Separator } from "@/app/ui/separator";
/**
 * PrimitivesGallery — dev-only smoke screen rendering every domain primitive
 * in every state. Gated behind import.meta.env.DEV + #/__primitives hash in main.tsx.
 * NOT included in production builds (lazy import + hash gate).
 */
import { useState } from "react";

const AGENTS: AgentId[] = ["claude", "codex", "antigravity", "cursor"];
const STATUS_KEYS = Object.keys(STATUS) as StatusKey[];
const SPARK_DATA = [4, 8, 6, 12, 9, 14, 11, 16, 10, 18, 13, 17];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 40 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          paddingBottom: 8,
          borderBottom: "1px solid var(--bd-soft)",
        }}
      >
        <span className="lbl">{title}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        {children}
      </div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      {children}
    </div>
  );
}

function Cell({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {label && <span className="lbl-soft">{label}</span>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {children}
      </div>
    </div>
  );
}

export default function PrimitivesGallery() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(next);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg-1)",
        color: "var(--fg-0)",
        fontFamily: "var(--mono)",
        padding: "32px 40px",
        fontSize: 13,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 40,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, fontFamily: "var(--sans)" }}>
            Primitives Gallery
          </h1>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 12,
              color: "var(--fg-2)",
              fontFamily: "var(--sans)",
            }}
          >
            CodeHub Phase 1 — all domain primitives in all states
          </p>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          style={{
            padding: "6px 14px",
            borderRadius: "var(--r-2)",
            border: "1px solid var(--bd)",
            background: "var(--bg-3)",
            color: "var(--fg-0)",
            fontFamily: "var(--mono)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Theme: {theme}
        </button>
      </div>

      {/* ── AgentGlyph ── */}
      <Section title="AgentGlyph">
        <Cell label="all agents @ 14px">
          {AGENTS.map((a) => (
            <AgentGlyph key={a} agent={a} size={14} />
          ))}
        </Cell>
        <Cell label="@ 20px with accent color">
          <AgentGlyph agent="claude" size={20} color="var(--a-claude)" />
          <AgentGlyph agent="codex" size={20} color="var(--a-codex)" />
          <AgentGlyph agent="antigravity" size={20} color="var(--a-antigravity)" />
        </Cell>
        <Cell label="@ 32px">
          {AGENTS.map((a) => (
            <AgentGlyph key={a} agent={a} size={32} />
          ))}
        </Cell>
      </Section>

      {/* ── StatusDot ── */}
      <Section title="StatusDot">
        <Cell label="all statuses">
          <Row>
            {STATUS_KEYS.map((s) => (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <StatusDot status={s} />
                <span className="lbl-soft">{s}</span>
              </div>
            ))}
          </Row>
        </Cell>
        <Cell label="live with pulse">
          <StatusDot status="live" pulse />
          <span className="lbl-soft">pulse on</span>
        </Cell>
      </Section>

      {/* ── StatusBadge ── */}
      <Section title="StatusBadge">
        {STATUS_KEYS.map((s) => (
          <StatusBadge key={s} status={s} />
        ))}
      </Section>

      {/* ── ContextGauge ── */}
      <Section title="ContextGauge">
        <Cell label="low (12%)">
          <ContextGauge used={12000} max={100000} />
        </Cell>
        <Cell label="warn (75%)">
          <ContextGauge used={75000} max={100000} label="ctx" />
        </Cell>
        <Cell label="over (92%)">
          <ContextGauge used={92000} max={100000} label="ctx" />
        </Cell>
        <Cell label="narrow width">
          <ContextGauge used={50000} max={200000} width={60} />
        </Cell>
      </Section>

      {/* ── MetricStat ── */}
      <Section title="MetricStat">
        <Cell label="plain">
          <MetricStat label="tokens" value="14.2k" />
        </Cell>
        <Cell label="delta up">
          <MetricStat label="turns" value="42" delta="+3" deltaTone="up" />
        </Cell>
        <Cell label="delta down">
          <MetricStat label="errors" value="2" delta="-1" deltaTone="down" />
        </Cell>
        <Cell label="spend warn">
          <MetricStat label="cost" value="$3.84" spend="warn" />
        </Cell>
        <Cell label="spend over">
          <MetricStat label="cost" value="$12.40" spend="over" />
        </Cell>
        <Cell label="metric row">
          <Row>
            <MetricStat label="tokens" value="14.2k" />
            <MetricStat label="turns" value="42" delta="+3" deltaTone="up" />
            <MetricStat label="cost" value="$3.84" spend="warn" />
            <MetricStat label="files" value="18" />
          </Row>
        </Cell>
      </Section>

      {/* ── Spark ── */}
      <Section title="Spark">
        <Cell label="default">
          <Spark data={SPARK_DATA} />
        </Cell>
        <Cell label="filled">
          <Spark data={SPARK_DATA} fill color="var(--live)" />
        </Cell>
        <Cell label="wait color">
          <Spark data={SPARK_DATA} color="var(--wait)" w={80} h={20} />
        </Cell>
        <Cell label="wide">
          <Spark data={SPARK_DATA} w={120} h={24} color="var(--idle)" fill />
        </Cell>
      </Section>

      {/* ── Tag ── */}
      <Section title="Tag">
        <Cell label="neutral">
          <Tag>typescript</Tag>
        </Cell>
        <Cell label="live accent">
          <Tag color="var(--live)">running</Tag>
        </Cell>
        <Cell label="wait accent">
          <Tag color="var(--wait)">pending</Tag>
        </Cell>
        <Cell label="err accent">
          <Tag color="var(--err)">failed</Tag>
        </Cell>
        <Cell label="agent accents">
          <Tag color="var(--a-claude)">claude</Tag>
          <Tag color="var(--a-codex)">codex</Tag>
          <Tag color="var(--a-antigravity)">antigravity</Tag>
        </Cell>
      </Section>

      {/* ── AccountAvatar ── */}
      <Section title="AccountAvatar">
        <Cell label="size 18 (default)">
          {["cm", "cw", "ca", "cx", "cxa", "ag"].map((id) => (
            <AccountAvatar key={id} id={id} size={18} />
          ))}
        </Cell>
        <Cell label="size 24 with ring">
          {["cm", "cx", "ag"].map((id) => (
            <AccountAvatar key={id} id={id} size={24} ring />
          ))}
        </Cell>
        <Cell label="size 32">
          <AccountAvatar id="cm" size={32} />
          <AccountAvatar id="ag" size={32} ring />
        </Cell>
      </Section>

      {/* ── Logo ── */}
      <Section title="Logo">
        <Cell label="default">
          <Logo />
        </Cell>
        <Cell label="icon only">
          <Logo withText={false} />
        </Cell>
        <Cell label="size 24">
          <Logo size={24} />
        </Cell>
      </Section>

      {/* ── IconBtn + Ico ── */}
      <Section title="IconBtn + Ico">
        <Cell label="default">
          {Object.keys(Ico)
            .slice(0, 6)
            .map((k) => (
              <IconBtn key={k} title={k}>
                {Ico[k as keyof typeof Ico]}
              </IconBtn>
            ))}
        </Cell>
        <Cell label="active">
          <IconBtn active title="active">
            {Ico.hub}
          </IconBtn>
        </Cell>
        <Cell label="danger">
          <IconBtn danger title="danger">
            {Ico.close}
          </IconBtn>
        </Cell>
        <Cell label="all icons">
          {Object.entries(Ico).map(([k, icon]) => (
            <IconBtn key={k} title={k}>
              {icon}
            </IconBtn>
          ))}
        </Cell>
      </Section>

      {/* ── TermBlock ── */}
      <Section title="TermBlock">
        <Cell label="cc brief">
          <div
            style={{
              width: 460,
              border: "1px solid var(--bd)",
              borderRadius: "var(--r-3)",
              overflow: "hidden",
            }}
          >
            <TermBlock lines={SNIPPETS.ccBrief} />
          </div>
        </Cell>
        <Cell label="codex brief">
          <div
            style={{
              width: 460,
              border: "1px solid var(--bd)",
              borderRadius: "var(--r-3)",
              overflow: "hidden",
            }}
          >
            <TermBlock lines={SNIPPETS.codexBrief} />
          </div>
        </Cell>
        <Cell label="cc idle">
          <div
            style={{
              width: 460,
              border: "1px solid var(--bd)",
              borderRadius: "var(--r-3)",
              overflow: "hidden",
            }}
          >
            <TermBlock lines={SNIPPETS.ccIdle} />
          </div>
        </Cell>
      </Section>

      {/* ── shadcn Button ── */}
      <Section title="shadcn Button (all variants + sizes incl. success + xs)">
        <Cell label="variants">
          <Button variant="default">Default</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="success">Success</Button>
        </Cell>
        <Cell label="sizes">
          <Button size="lg">Large</Button>
          <Button size="default">Default</Button>
          <Button size="sm">Small</Button>
          <Button size="xs">Extra Small</Button>
        </Cell>
        <Cell label="success + xs">
          <Button variant="success" size="xs">
            Approve
          </Button>
          <Button variant="destructive" size="xs">
            Deny
          </Button>
        </Cell>
        <Cell label="icon sizes">
          <Button size="icon">{Ico.plus}</Button>
          <Button size="icon-sm">{Ico.settings}</Button>
          <Button size="icon-xs">{Ico.close}</Button>
        </Cell>
      </Section>

      {/* ── shadcn Badge ── */}
      <Section title="shadcn Badge">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="destructive">Destructive</Badge>
      </Section>

      {/* ── Separator ── */}
      <Section title="Separator">
        <Cell label="horizontal">
          <div style={{ width: 200 }}>
            <Separator />
          </div>
        </Cell>
      </Section>

      {/* ── Chrome: AppShell ── */}
      <Section title="Chrome: AppShell">
        <div
          style={{
            width: 700,
            height: 300,
            border: "1px solid var(--bd)",
            borderRadius: "var(--r-4)",
            overflow: "hidden",
          }}
        >
          <AppShell title="CodeHub — demo" rail={<SidebarRail />}>
            <div style={{ padding: 24, color: "var(--fg-1)", fontSize: 12 }}>Main content area</div>
          </AppShell>
        </div>
      </Section>

      {/* ── Chrome: Sidebar ── */}
      <Section title="Chrome: Sidebar">
        <div
          style={{
            height: 400,
            border: "1px solid var(--bd)",
            borderRadius: "var(--r-4)",
            overflow: "hidden",
          }}
        >
          <Sidebar
            groups={[
              {
                label: "Workspaces",
                items: [
                  { key: "hub", label: "Hub", active: true },
                  { key: "containers", label: "Containers" },
                ],
              },
              {
                label: "Library",
                items: [
                  { key: "resume", label: "Resume" },
                ],
              },
            ]}
          />
        </div>
      </Section>

      {/* ── Chrome: WorkspaceTab ── */}
      <Section title="Chrome: WorkspaceTab">
        <Cell label="active">
          <WorkspaceTab
            repo="aurora-api"
            branch="feat/rate-limit"
            active
            agents={[
              { id: "s1", agent: "claude", status: "live" },
              { id: "s2", agent: "codex", status: "wait" },
            ]}
          />
        </Cell>
        <Cell label="inactive">
          <WorkspaceTab
            repo="frontend"
            branch="main"
            agents={[{ id: "s3", agent: "antigravity", status: "idle" }]}
          />
        </Cell>
        <Cell label="no agents">
          <WorkspaceTab repo="sandbox" branch="dev" />
        </Cell>
        <Cell label="tab row">
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid var(--bd-soft)",
              background: "var(--bg-0)",
            }}
          >
            <WorkspaceTab
              repo="aurora-api"
              branch="feat/rate-limit"
              active
              agents={[{ id: "s1", agent: "claude", status: "live" }]}
            />
            <WorkspaceTab
              repo="frontend"
              branch="main"
              agents={[{ id: "s2", agent: "codex", status: "idle" }]}
            />
            <WorkspaceTab repo="sandbox" />
          </div>
        </Cell>
      </Section>

      {/* ── Helper classes ── */}
      <Section title="Helper classes (.mono .tnum .lbl .lbl-soft .lbl-mono .kbd)">
        <Cell>
          <span className="lbl">Section label</span>
          <span className="lbl-mono">lbl-mono</span>
          <span className="lbl-soft">lbl-soft label</span>
          <span className="mono">mono text</span>
          <span className="tnum mono">12,345.67</span>
          <span className="kbd">⌘K</span>
          <span className="kbd">⌥⇧P</span>
        </Cell>
      </Section>

      {/* ── Theme swatch ── */}
      <Section title="Surface + border tokens">
        <Cell>
          {(["--bg-0", "--bg-1", "--bg-2", "--bg-3", "--bg-hover", "--bg-active"] as const).map(
            (t) => (
              <div
                key={t}
                style={{
                  width: 60,
                  height: 40,
                  borderRadius: "var(--r-2)",
                  background: `var(${t})`,
                  border: "1px solid var(--bd)",
                  display: "flex",
                  alignItems: "flex-end",
                  padding: "2px 4px",
                }}
              >
                <span style={{ fontSize: 9, color: "var(--fg-2)", fontFamily: "var(--mono)" }}>
                  {t.replace("--", "")}
                </span>
              </div>
            ),
          )}
        </Cell>
        <Cell label="accents">
          {(["--live", "--wait", "--idle", "--err", "--done"] as const).map((t) => (
            <div
              key={t}
              style={{
                width: 40,
                height: 40,
                borderRadius: "var(--r-2)",
                background: `var(${t})`,
              }}
              title={t}
            />
          ))}
        </Cell>
      </Section>
    </div>
  );
}
