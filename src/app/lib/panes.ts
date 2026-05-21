import {
  type Pane,
  createPane,
  destroyPane as destroyTerminal,
  fitPane,
  focusPane,
} from "../../terminal";

// Pane registry — xterm surfaces live here, OUTSIDE React. React renders empty
// slots; <PaneMount> moves a pane's DOM node into the active slot and parks it
// back in the stash on unmount. The Terminal is never disposed during
// reparenting, so buffers survive splits and tab switches (proven in Phase 0).

const stash = document.createElement("div");
stash.className = "pane-stash";
stash.style.cssText =
  "position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
document.body.appendChild(stash);

const panes = new Map<string, Pane>();

// Create + attach a pane's terminal to the backend. Awaited by store actions
// before the layout references the session, so PaneMount always finds it.
export async function spawnPane(name: string): Promise<void> {
  if (panes.has(name)) return;
  const pane = await createPane(stash, name);
  panes.set(name, pane);
}

export function getPane(name: string): Pane | undefined {
  return panes.get(name);
}

export function mountPane(name: string, slot: HTMLElement): void {
  const pane = panes.get(name);
  if (pane) slot.appendChild(pane.el);
}

export function parkPane(name: string): void {
  const pane = panes.get(name);
  if (pane) stash.appendChild(pane.el);
}

// Tear a pane down. Callers MUST kill the tmux session FIRST (see store
// closeSession / CLAUDE.md), then call this — destroyPane runs detach_session.
export async function destroyPane(name: string): Promise<void> {
  const pane = panes.get(name);
  if (!pane) return;
  panes.delete(name);
  await destroyTerminal(pane);
}

export function fit(name: string): void {
  const pane = panes.get(name);
  if (pane) fitPane(pane);
}

export function focus(name: string): void {
  const pane = panes.get(name);
  if (pane) focusPane(pane);
}
