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

## Known limitations (don't test against)

- Antigravity CLI install URL not yet confirmed — currently commented out in `runtime/Dockerfile`. Selecting Antigravity in the modal will create a tmux session that exits immediately because the `antigravity` binary is missing.
- Cross-architecture image (only built for host arch right now). Use `docker buildx build --platform linux/amd64,linux/arm64` before publishing.
- No icon. Cage-grid-with-bird icon set still TODO.

## Regression checklist before release

- [ ] L1, L3, L5, L6
- [ ] S3 (the bug user reported), S4, S5, S7, S8, S9
- [ ] K2 (⌘W must kill tmux — same invariant as S3)
- [ ] P1, P5, P7
- [ ] V1, V2
- [ ] U3, U4, U7
