import { useState } from "react";
import { ipc } from "../lib/ipc";
import { useStore } from "../lib/store";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[420px]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Add {agentLabel}</DialogTitle>
          <DialogDescription>
            Stored in your OS keychain. CodeHub never writes it to disk or sends it over IPC after
            this save.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="lbl">Label</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={agent === "github" ? "Personal" : "Work"}
              spellCheck={false}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="lbl">{agentLabel}</Label>
            <Input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={agent === "github" ? "ghp_..." : "sk-..."}
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSave) void save();
              }}
            />
          </div>

          {error && (
            <div className="text-[12px]" style={{ color: "var(--err)" }}>
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            {busy ? "Saving..." : "Save to keychain"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
