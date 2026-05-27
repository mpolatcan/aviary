import { type CSSProperties, useState } from "react";
import { ipc } from "../lib/ipc";
import { useStore } from "../lib/store";
import { Button } from "../ui/button";

interface ApiKeyDialogProps {
  agent: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function ApiKeyDialog({ agent, onClose, onSaved }: ApiKeyDialogProps) {
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSave = label.trim() !== "" && secret.trim() !== "" && !busy;

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const existingIds = new Set(useStore.getState().accountProfiles.map((p) => p.id));
      const list = await ipc.addAccountProfile(agent, label.trim(), undefined, "vault");
      useStore.setState({ accountProfiles: list });
      const created = list.find((p) => !existingIds.has(p.id));
      if (created) {
        await ipc.vaultStoreKey(created.id, secret.trim());
      }
      setSecret("");
      setLabel("");
      onSaved?.();
      onClose();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const agentLabel =
    agent === "github" ? "GitHub PAT" : agent === "codex" ? "OpenAI API key" : "API key";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(4px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="ch-card"
        style={{ width: 420, padding: 24, background: "var(--bg-2)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 600, color: "var(--fg-0)" }}>
          Add {agentLabel}
        </h3>
        <p style={{ margin: "0 0 18px", fontSize: 12, color: "var(--fg-2)" }}>
          Stored in your OS keychain. CodeHub never writes it to disk or sends it over IPC after
          this save.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Label">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={agent === "github" ? "Personal" : "Work"}
              spellCheck={false}
              style={inputStyle}
            />
          </Field>

          <Field label={agentLabel}>
            <input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={agent === "github" ? "ghp_..." : "sk-..."}
              spellCheck={false}
              style={inputStyle}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSave) void save();
              }}
            />
          </Field>

          {error && <div style={{ fontSize: 11.5, color: "var(--err)" }}>{error}</div>}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={!canSave} onClick={() => void save()}>
              {busy ? "Saving..." : "Save to keychain"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
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
  padding: "8px 10px",
  fontSize: 12.5,
  color: "var(--fg-1)",
  outline: "none",
  fontFamily: "var(--sans)",
  width: "100%",
};
