import { Ico } from "../primitives/icons";

// Honest placeholder for a designed screen whose REAL data needs backend
// CodeHub does not capture yet. Unlike a vague "coming soon", this names what
// the screen will show and exactly what's missing — so the nav item is
// reachable and truthful rather than faking numbers. See BACKEND_PLAN.md.
export function PlannedScreen({
  title,
  blurb,
  needs,
}: {
  title: string;
  blurb: string;
  needs: string;
}) {
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
            {title}
          </h1>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
            planned
          </span>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 40,
          textAlign: "center",
        }}
      >
        <span style={{ color: "var(--fg-3)", transform: "scale(1.8)" }}>{Ico.grid}</span>
        <p
          style={{
            margin: 0,
            maxWidth: 420,
            fontSize: 13.5,
            lineHeight: 1.6,
            color: "var(--fg-1)",
          }}
        >
          {blurb}
        </p>
        <div
          className="ch-card"
          style={{
            maxWidth: 460,
            padding: "12px 16px",
            textAlign: "left",
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: "var(--fg-0)",
              marginBottom: 4,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ color: "var(--wait)" }}>{Ico.bell}</span>
            Not built yet — no fabricated data
          </div>
          <div className="mono" style={{ fontSize: 11, lineHeight: 1.55, color: "var(--fg-2)" }}>
            {needs}
          </div>
        </div>
      </div>
    </main>
  );
}
