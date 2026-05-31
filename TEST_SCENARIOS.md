# CodeHub — Manual Test Scenarios

Until automated IPC tests exist, exercise these by hand before each cut.
Run `npm run tauri dev`, then check each row.

Verify inside the container with:

```bash
docker exec -it codehub-runtime tmux -S /tmp/codehub/default ls
docker exec -it codehub-runtime ps -ef | grep -E "tmux|claude|codex"
```

## Lifecycle

| # | Scenario | Expected |
|---|---|---|
| L1 | First launch, image absent | App pulls image, status: missing → starting → running |
| L2 | First launch, image present, container absent | Container created + started; volumes appear under app-data dir |
| L3 | Launch, container exists & running | Status flips to running immediately, no re-pull |
| L4 | Launch, container exists but stopped | CodeHub starts it; status: stopped → running |
| L5 | Docker daemon down | Status: unreachable; clear error in status bar |
| L6 | `docker stop codehub-runtime` while app running | Status drops to stopped within next probe; further `+` clicks blocked |

## Session lifecycle (CORE — was previously broken)

| # | Scenario | Expected | Verify command |
|---|---|---|---|
| S1 | Open new-tab popover, pick Claude, Open | Popover closes, new tab appears, terminal shows Claude prompt | `tmux ls` shows `claude-xxxxx` |
| S2 | Type into active session | Keystrokes echo, Claude responds | — |
| S3 | Click `×` on tab | Tab disappears, **tmux session also gone** | `tmux ls` must NOT list it |
| S4 | Close last tab | Empty state ("No sessions yet") visible | `tmux ls` empty or "no server" |
| S5 | Open 3 sessions, close middle one | Middle gone, others untouched, focus moves to first remaining | `tmux ls` shows 2 |
| S6 | Open Claude + Codex + Antigravity tabs | 3 different bird silhouettes, 3 different Latin binomials in tabs | — |
| S7 | Close active tab | Focus auto-moves to next pane | UI: another tab gets `.active` border-top |
| S8 | Rapid close (4 tabs in <1s) | All sessions gone, no zombie tmux sessions | `tmux ls` empty |
| S9 | App force-quit while tabs open | After restart, `list_sessions` shows them, tabs auto-restored | `tmux ls` before+after |
| S10 | Container restart while tabs open | tmux server died with container; old panes get exit event, UI shows `· specimen has departed ·` |
| S11 | Open same session name twice (timing race) | Second open activates existing tab, doesn't crash backend | — |

## PTY plumbing

| # | Scenario | Expected |
|---|---|---|
| P1 | Resize window | Terminal reflows, prompt does not corrupt |
| P2 | Switch tab away & back | Cursor blink resumes, scrollback intact |
| P3 | Paste multi-line text | All lines arrive in order |
| P4 | Send Ctrl+C during long output | Output stops, prompt returns |
| P5 | Send Ctrl+D | CLI quits gracefully; session exit event fires; tab auto-removes? (current behaviour: tab stays, terminal shows departure line — confirm desired) |
| P6 | Run `ls /workspace` inside session | Sees host workspace dir mount |
| P7 | Inside Claude, `/login` once | Auth state persists across container restart (volume mount under /config) |

## Volumes & persistence

| # | Scenario | Expected |
|---|---|---|
| V1 | Write file in session: `touch /workspace/probe.txt` | File visible on host under `~/Library/Application Support/com.mutlupolatcan.codehub/workspace/` |
| V2 | Restart container, re-open Claude | No re-login needed; `~/.../config/claude` carried |
| V3 | Restart app, restart container | Same — auth + workspace intact |

## UI polish

| # | Scenario | Expected |
|---|---|---|
| U1 | Hover tab | Bird silhouette colour shifts to ochre, subtle background |
| U2 | Click new-tab `+` | Popover opens anchored to the button, agent × mode chooser |
| U3 | Open launcher (split / ⌘T), press Esc | Dialog closes, no session created |
| U4 | Click overlay (outside dialog) | Dialog closes |
| U5 | Click "Cancel" in launcher | Dialog closes, no session created |
| U6 | Launcher entrance | Overlay fades, dialog lifts in |
| U7 | Container state: running → stopped (manual `docker stop`) | Status bar text colour: moss → ochre |
| U8 | Container state: unreachable | Status bar colour: oxidized red |
| U9 | Tab through chrome with keyboard | `:focus-visible` accent ring on tabs/controls; OS reduced-motion disables pane/dialog animation |

## Keyboard & launch modes

| # | Scenario | Expected |
|---|---|---|
| K1 | ⌘T (Ctrl+T) | New-tab launcher opens; pick agent × mode → tab created |
| K2 | ⌘W on focused pane | Session closes, tmux killed (S3 invariant); skipped while renaming |
| K3 | ⌘\ on focused pane | Split launcher opens; new pane splits along the longer axis |
| K4 | ⌘1–⌘9 | Switches to tab N (no-op past the last tab) |
| K5 | Pick YOLO mode | Warn banner shows, Start button turns red; pane gets a `YOLO` badge |
| K6 | Pick Auto mode | Pane gets an `AUTO` badge; `create_session` sends `mode: "auto"` |
| K7 | Select Antigravity | Only Standard selectable (Auto/YOLO disabled) |

## Shell pane (PR #51)

| # | Scenario | Expected |
|---|---|---|
| SH1 | Launcher → "Pane type" → Shell → Open | Tab labelled "Shell N · Shell", terminal shows `root@<id>:/workspace#` bash prompt; `tmux ls` shows `shell-xxxxx` |
| SH2 | Selecting Shell in the launcher | Mode segment (Standard/Auto/YOLO) is replaced by a plain-bash note; no permission mode sent |
| SH3 | Shell pane header metrics | ctx/turn/tokens/cost/edits all em-dash (no agent telemetry); no version shown |
| SH4 | Close a Shell tab | tmux session gone (S3 invariant holds for shell too) |
| SH5 | Run a command in the shell (`ls /workspace`) | Real output; cwd is `/workspace` |

## Hub layout toggle (PR #51)

| # | Scenario | Expected |
|---|---|---|
| HL1 | Tab bar → "Compare grid layout" with ≥2 sessions | Every live session tiles side by side; each keeps its own live terminal + header |
| HL2 | Toggle back to "Tabs layout" | Returns to per-workspace split grid; **scrollback preserved** in every pane (panes reparented, not disposed) |
| HL3 | Grid toggle with 0 sessions | Grid button disabled |
| HL4 | Reload app after choosing Grid | Layout persists (config `hubLayout`) |

## Settings — live preferences (PR #51)

| # | Scenario | Expected |
|---|---|---|
| ST1 | Appearance → Density → Compact | Tab bar shrinks (40→32px), pane headers/dividers/launcher tighten immediately; `data-density="compact"` on `<html>` |
| ST2 | Density → Comfortable | Reverts; attribute cleared. Survives reload (config) |
| ST3 | General → Restore sessions on launch = off, quit + relaunch | Hub starts clean; sessions still alive in container (`tmux ls` non-empty) but not adopted |
| ST4 | Restore on, Reopen last workspace on; focus a tab, quit, relaunch | That session's tab is re-selected (focus restored from localStorage) |
| ST5 | Restore = off | "Reopen last workspace" toggle is disabled |
| ST6 | Agents pane → click an agent row → Configure | Opens Agent detail; back button returns to the list |
| ST7 | Agent detail for Claude (runtime running) | Real account, model, permission mode, MCP/sub-agents/skills/plugins with honest "none configured" empties |
| ST8 | Agent detail for Codex / Antigravity | Version + key presence + an honest "no per-agent config tree read" note (no fabricated sections) |

## Subscription accounts — email + multi-account conflict

| # | Scenario | Expected |
|---|---|---|
| AC1 | Settings → Coding Agents → Claude → Subscription Sign In → sign in with your Claude plan | Row shows the account **email** as the subtitle (captured at login, persisted on the profile); status "Active" |
| AC2 | Reload app after AC1 | Email still shown (persisted in settings.json, not just read from the running container) |
| AC3 | Codex tab → Subscription Sign In → sign in with a ChatGPT plan | Row shows the ChatGPT account email (decoded from the id_token JWT) |
| AC4 | Add a **second** Claude subscription ("Sign in with another Claude account") | Two rows, each with its own email — distinguishable |
| AC5 | Two Claude subs, launch a pane under each in the **same** workspace | **No conflict** — each restores into its own `/config/claude-profiles/<env>` dir + per-pane `CLAUDE_CONFIG_DIR`; both run as their own account |
| AC6 | Two **Codex** subs, launch a pane under each in the **same** workspace | **No conflict** (per-pane `CODEX_HOME` isolation) — each restores into its own `/config/codex-profiles/<env>` home (own `auth.json` + rollouts, `config.toml` seeded forward) and the pane exports `CODEX_HOME=<that dir>`. Verify: `ls /config/codex-profiles/` shows two dirs with different `auth.json` (distinct md5), per-pane `CODEX_HOME` env differs, usage/rollouts read per-profile (globs include `/config/codex-profiles/*/sessions`). Watch for a Codex first-run onboarding/trust prompt in the fresh home — report if it appears. |

## Known limitations (don't test against)

- Antigravity CLI install URL not yet confirmed — currently commented out in `runtime/Dockerfile`. Selecting Antigravity in the modal will create a tmux session that exits immediately because the `antigravity` binary is missing.
- Cross-architecture image (only built for host arch right now). Use `docker buildx build --platform linux/amd64,linux/arm64` before publishing.
- No icon. Cage-grid-with-bird icon set still TODO.

## Regression checklist before release

- [ ] L1, L3, L5, L6
- [ ] S3 (the bug user reported), S4, S5, S7, S8, S9
- [ ] K2 (⌘W must kill tmux — same invariant as S3)
- [ ] SH4 (shell close kills tmux — S3 invariant for the shell pane)
- [ ] HL2 (layout toggle preserves scrollback — panes reparented, not disposed)
- [ ] P1, P5, P7
- [ ] V1, V2
- [ ] U3, U4, U7
