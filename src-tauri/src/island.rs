//! Native macOS "Dynamic Island" companion — a borderless `NSPanel` anchored
//! under the notch, floating above the menu bar, that mirrors live agent
//! activity. Replaces the webview companion on macOS (other platforms keep the
//! `WebviewWindow` companion in `lib.rs`).
//!
//! Behaviour:
//! - **Collapsed:** a notch-width pill showing a colored dot + running-agent
//!   count.
//! - **Expanded (on hover):** the panel drops down into a list of every running
//!   session — colored working/idle dot + name. Clicking a row focuses that
//!   session in the main window. The mouse leaving collapses it again.
//!
//! Everything shown is the honest `session_activity` signal — no fabricated
//! turn/token/approval state.
//!
//! Threading: AppKit objects are neither `Send` nor `Sync` and must only be
//! touched on the main thread, so the whole island lives in a main-thread
//! `thread_local!` and is only accessed inside `run_on_main_thread`. AppKit
//! event callbacks already run on the main thread, so they reach into the
//! `thread_local!` directly. A separate `AtomicBool` mirrors visibility so the
//! cross-thread `companion_open` command can answer without touching the panel.
#![cfg(target_os = "macos")]

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, AnyThread, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSColor, NSEvent, NSFont, NSPanel, NSScreen, NSStatusWindowLevel,
    NSTextAlignment, NSTextField, NSTrackingArea, NSTrackingAreaOptions, NSView,
    NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView,
    NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use tauri::{AppHandle, Emitter, Manager};

/// One row in the island: a display label and whether the agent is producing.
#[derive(Clone)]
pub struct IslandItem {
    pub label: String,
    pub working: bool,
}

thread_local! {
    /// The live island, created lazily on first `show`. Main-thread only.
    static ISLAND: RefCell<Option<Island>> = const { RefCell::new(None) };
}

/// Cross-thread mirror of whether the island is currently on screen.
static VISIBLE: AtomicBool = AtomicBool::new(false);

/// Pill size when the display has no notch (older / external monitors).
const FALLBACK_W: f64 = 168.0;
/// Minimum collapsed pill height (also the header band when expanded).
const COLLAPSE_H: f64 = 26.0;
/// Smallest plausible notch width, guards a degenerate measurement.
const MIN_NOTCH_W: f64 = 80.0;
/// Expanded panel width / per-row height / vertical padding.
const EXPANDED_W: f64 = 248.0;
const ROW_H: f64 = 24.0;
const PAD: f64 = 8.0;

/// Live AppKit handles + layout state. All `Retained` fields are main-thread.
struct Island {
    app: AppHandle,
    panel: Retained<NSPanel>,
    view: Retained<IslandView>,
    header: Retained<NSTextField>,
    /// (dot, name) field pair per current row.
    rows: Vec<(Retained<NSTextField>, Retained<NSTextField>)>,
    /// Session names in row order, for click → focus.
    names: Vec<String>,
    expanded: bool,
    /// Collapsed-pill geometry for the current display (origin + size).
    pill: NSRect,
}

// ── Custom flipped NSView: owns hover tracking + click hit-testing ───────────

/// Empty ivars — all state lives in the `thread_local!` island.
struct IslandIvars;

define_class!(
    // Flipped so subview layout uses a top-left origin.
    #[unsafe(super(NSView))]
    #[name = "CodeHubIslandView"]
    #[ivars = IslandIvars]
    struct IslandView;

    impl IslandView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        // Let a click land without first activating the app.
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, _event: &NSEvent) {
            set_expanded(true);
        }

        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, _event: &NSEvent) {
            set_expanded(false);
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            // Window coords → this view's flipped local coords.
            let win_pt = event.locationInWindow();
            let local = self.convertPoint_fromView(win_pt, None);
            handle_click(local.y);
        }
    }
);

impl IslandView {
    fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(IslandIvars);
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

// ── Public entry points (callable from any thread) ───────────────────────────

/// Whether the island is on screen. Safe to call from any thread.
pub fn is_visible() -> bool {
    VISIBLE.load(Ordering::Relaxed)
}

/// Show the island (creating it on first call), re-positioned under the notch so
/// it follows display changes. Idempotent.
pub fn show(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let mtm = MainThreadMarker::new().expect("run_on_main_thread is on the main thread");
        // Phase 1 (under borrow): create if needed, recompute notch geometry, and
        // capture the frame plan. Phase 2 applies it with the borrow released.
        let plan = ISLAND.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                *slot = Some(build(app, mtm));
            }
            let island = slot.as_mut().expect("island built above");
            update_pill(island, mtm);
            plan_frame(island)
        });
        apply_frame(&plan, false); // no animation on first/visibility show
        relayout();
        ISLAND.with(|cell| {
            if let Some(island) = cell.borrow().as_ref() {
                island.panel.orderFrontRegardless();
            }
        });
        VISIBLE.store(true, Ordering::Relaxed);
    });
}

/// Hide the island without destroying it (cheap to re-show). Idempotent.
pub fn hide(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        ISLAND.with(|cell| {
            if let Some(island) = cell.borrow().as_ref() {
                island.panel.orderOut(None);
            }
        });
        VISIBLE.store(false, Ordering::Relaxed);
    });
}

/// Push the latest activity snapshot. Rebuilds the rows and refreshes the
/// collapsed count; re-lays-out live if currently expanded. Cheap no-op when the
/// island has never been shown.
pub fn update(app: &AppHandle, items: Vec<IslandItem>) {
    let _ = app.run_on_main_thread(move || {
        let mtm = MainThreadMarker::new().expect("run_on_main_thread is on the main thread");
        // Phase 1 (under borrow): swap in the new rows. If expanded, capture a
        // fresh frame plan so the panel height tracks the row count.
        let plan = ISLAND.with(|cell| {
            let mut slot = cell.borrow_mut();
            let island = slot.as_mut()?;
            rebuild_rows(island, &items, mtm);
            island.expanded.then(|| plan_frame(island))
        });
        // Phase 2 (borrow released): reframe if expanded, then relayout.
        if let Some(plan) = plan {
            apply_frame(&plan, true);
        }
        relayout();
    });
}

// ── Construction ─────────────────────────────────────────────────────────────

fn build(app: AppHandle, mtm: MainThreadMarker) -> Island {
    let pill = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(FALLBACK_W, COLLAPSE_H));
    let style = NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel;

    let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
        NSPanel::alloc(mtm),
        pill,
        style,
        NSBackingStoreType::Buffered,
        false,
    );
    panel.setLevel(NSStatusWindowLevel); // float above the menu bar (level 24)
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
    panel.setOpaque(false);
    let clear = NSColor::clearColor();
    panel.setBackgroundColor(Some(&clear));
    panel.setHasShadow(true);
    panel.setMovable(false);

    // Flipped content view that receives hover + click.
    let view = IslandView::new(mtm, pill);
    view.setWantsLayer(true);

    // Native dark blur sits *behind* the view, rounded into the pill.
    let blur = NSVisualEffectView::initWithFrame(NSVisualEffectView::alloc(mtm), pill);
    blur.setMaterial(NSVisualEffectMaterial::HUDWindow);
    blur.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    blur.setState(NSVisualEffectState::Active);
    blur.setWantsLayer(true);
    if let Some(layer) = blur.layer() {
        layer.setCornerRadius(COLLAPSE_H / 2.0);
        layer.setMasksToBounds(true);
    }
    let blur_view: &NSView = &blur;
    view.addSubview(blur_view);

    // Hover tracking that always matches the (resizing) visible rect.
    let opts = NSTrackingAreaOptions::MouseEnteredAndExited
        | NSTrackingAreaOptions::ActiveAlways
        | NSTrackingAreaOptions::InVisibleRect;
    let owner: &AnyObject = &view;
    // SAFETY: fresh allocation; `owner` (the view) outlives the area, which lives
    // as long as the view; no userInfo.
    let area = unsafe {
        NSTrackingArea::initWithRect_options_owner_userInfo(
            NSTrackingArea::alloc(),
            pill,
            opts,
            Some(owner),
            None,
        )
    };
    view.addTrackingArea(&area);

    // Collapsed header: dot + count.
    let header = label(mtm, "●", COLLAPSE_H - 12.0);
    header.setAlignment(NSTextAlignment::Center);
    header.setTextColor(Some(&dot_color(false, mtm)));
    let header_view: &NSView = &header;
    view.addSubview(header_view);

    let content: &NSView = &view;
    panel.setContentView(Some(content));

    let island = Island {
        app,
        panel,
        view,
        header,
        rows: Vec::new(),
        names: Vec::new(),
        expanded: false,
        pill,
    };
    layout(&island);
    island
}

// ── State transitions ─────────────────────────────────────────────────────────

/// Rebuild the row views from a fresh snapshot and refresh the collapsed count.
/// Pure state mutation — no panel frame change, so it is safe to run while the
/// `ISLAND` borrow is held. Layout/reframe happen afterwards, borrow-free.
fn rebuild_rows(island: &mut Island, items: &[IslandItem], mtm: MainThreadMarker) {
    // Tear down old row views.
    for (dot, name) in island.rows.drain(..) {
        dot.removeFromSuperview();
        name.removeFromSuperview();
    }
    island.names.clear();

    for item in items {
        let dot = label(mtm, "●", 11.0);
        dot.setTextColor(Some(&dot_color(item.working, mtm)));
        let name = label(mtm, &item.label, 12.0);
        name.setTextColor(Some(&NSColor::whiteColor()));
        name.setHidden(!island.expanded);
        dot.setHidden(!island.expanded);
        let dv: &NSView = &dot;
        let nv: &NSView = &name;
        island.view.addSubview(dv);
        island.view.addSubview(nv);
        island.rows.push((dot, name));
        island.names.push(item.label.clone());
    }

    // Collapsed pill shows the running-agent count, tinted if any are working.
    let working = items.iter().filter(|i| i.working).count();
    island
        .header
        .setStringValue(&NSString::from_str(&format!("● {}", items.len())));
    island
        .header
        .setTextColor(Some(&dot_color(working > 0, mtm)));
}

/// Expand or collapse. The visibility flips happen under the borrow; the
/// animated panel resize is applied AFTER the borrow is dropped, because
/// `setFrame…animate:true` can pump a nested run loop that synchronously
/// re-enters the hover callbacks — re-borrowing `ISLAND` then would panic.
fn set_expanded(expanded: bool) {
    let plan = ISLAND.with(|cell| {
        let mut slot = cell.borrow_mut();
        let island = slot.as_mut()?;
        if island.expanded == expanded {
            return None;
        }
        island.expanded = expanded;
        for (dot, name) in &island.rows {
            dot.setHidden(!expanded);
            name.setHidden(!expanded);
        }
        // The collapsed count is hidden once the rows take over.
        island.header.setHidden(expanded);
        Some(plan_frame(island))
    });
    if let Some(plan) = plan {
        apply_frame(&plan, true);
        relayout();
    }
}

/// A click at flipped local-y; focus the row it lands on (expanded only).
fn handle_click(local_y: f64) {
    let target = ISLAND.with(|cell| {
        let borrow = cell.borrow();
        let island = borrow.as_ref()?;
        if !island.expanded || local_y < COLLAPSE_H {
            return None;
        }
        let idx = ((local_y - COLLAPSE_H) / ROW_H) as usize;
        island
            .names
            .get(idx)
            .cloned()
            .map(|name| (island.app.clone(), name))
    });
    if let Some((app, name)) = target {
        focus_session(&app, &name);
    }
}

// ── Layout / geometry ─────────────────────────────────────────────────────────

/// Cloned handles + the target panel frame for the current state. Computed under
/// the `ISLAND` borrow, then applied to AppKit with the borrow released.
struct FramePlan {
    panel: Retained<NSPanel>,
    view: Retained<IslandView>,
    frame: NSRect,
    radius: f64,
}

/// Compute the target panel frame for the current expanded/collapsed state,
/// top-anchored at the notch.
fn plan_frame(island: &Island) -> FramePlan {
    let p = island.pill;
    let (frame, radius) = if island.expanded {
        let w = EXPANDED_W.max(p.size.width);
        let h = COLLAPSE_H + island.rows.len() as f64 * ROW_H + PAD;
        // Keep the top edge pinned; grow downward and center horizontally.
        let top = p.origin.y + p.size.height;
        let x = p.origin.x + (p.size.width - w) / 2.0;
        (
            NSRect::new(NSPoint::new(x, top - h), NSSize::new(w, h)),
            14.0,
        )
    } else {
        (p, p.size.height / 2.0)
    };
    FramePlan {
        panel: island.panel.clone(),
        view: island.view.clone(),
        frame,
        radius,
    }
}

/// Apply a [`FramePlan`] to AppKit. MUST be called with the `ISLAND` borrow
/// released — `animate:true` may pump a nested run loop that re-enters hover
/// callbacks.
fn apply_frame(plan: &FramePlan, animate: bool) {
    plan.panel
        .setFrame_display_animate(plan.frame, true, animate);
    if let Some(layer) = plan.view.layer() {
        layer.setCornerRadius(plan.radius);
    }
}

/// Re-run the internal subview layout under a short read borrow. Safe because
/// `layout` only sets subview frames (no window animate / nested run loop).
fn relayout() {
    ISLAND.with(|cell| {
        if let Some(island) = cell.borrow().as_ref() {
            layout(island);
        }
    });
}

/// Recompute the collapsed pill rect for the current display (notch geometry, or
/// top-center fallback) and store it on the island. Pure state — no AppKit frame
/// change.
fn update_pill(island: &mut Island, mtm: MainThreadMarker) {
    let Some(screen) = NSScreen::mainScreen(mtm) else {
        return;
    };
    let f = screen.frame();
    let notch_h = screen.safeAreaInsets().top;
    let (w, h) = if notch_h > 0.0 {
        let left = screen.auxiliaryTopLeftArea();
        let right = screen.auxiliaryTopRightArea();
        let notch_w = (f.size.width - left.size.width - right.size.width).max(MIN_NOTCH_W);
        (notch_w, notch_h)
    } else {
        (FALLBACK_W, COLLAPSE_H)
    };
    let x = f.origin.x + (f.size.width - w) / 2.0;
    // AppKit screen coords are bottom-left origin: top edge = origin.y + height.
    let y = f.origin.y + f.size.height - h;
    island.pill = NSRect::new(NSPoint::new(x, y), NSSize::new(w, h));
}

/// Position the blur, header and rows inside the current content bounds (flipped,
/// top-left origin).
fn layout(island: &Island) {
    let bounds = island.view.bounds();
    let w = bounds.size.width;
    let h = bounds.size.height;

    // Blur fills the whole content; round it to the view shape.
    if let Some((blur, _)) = first_subview(island) {
        blur.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(w, h)));
        if let Some(layer) = blur.layer() {
            layer.setCornerRadius(if island.expanded { 14.0 } else { h / 2.0 });
        }
    }

    // Header centered in the top band.
    island.header.setFrame(NSRect::new(
        NSPoint::new(0.0, 4.0),
        NSSize::new(w, COLLAPSE_H - 8.0),
    ));

    // Rows stacked under the header.
    for (i, (dot, name)) in island.rows.iter().enumerate() {
        let y = COLLAPSE_H + i as f64 * ROW_H;
        dot.setFrame(NSRect::new(
            NSPoint::new(12.0, y + 4.0),
            NSSize::new(14.0, ROW_H - 8.0),
        ));
        name.setFrame(NSRect::new(
            NSPoint::new(30.0, y + 3.0),
            NSSize::new(w - 40.0, ROW_H - 6.0),
        ));
    }
}

/// The blur view is the island's first subview (added before header/rows).
fn first_subview(island: &Island) -> Option<(Retained<NSView>, ())> {
    island.view.subviews().firstObject().map(|v| (v, ()))
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/// A non-editable, transparent label with the given system font size.
fn label(mtm: MainThreadMarker, text: &str, size: f64) -> Retained<NSTextField> {
    let field = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    let font = NSFont::systemFontOfSize(size);
    field.setFont(Some(&font));
    field
}

/// Working = CodeHub ochre accent (#e8a33d); idle = muted grey.
fn dot_color(working: bool, _mtm: MainThreadMarker) -> Retained<NSColor> {
    if working {
        NSColor::colorWithSRGBRed_green_blue_alpha(0.91, 0.64, 0.24, 1.0)
    } else {
        NSColor::colorWithSRGBRed_green_blue_alpha(0.50, 0.52, 0.55, 1.0)
    }
}

/// Raise + focus the main window and ask the app to focus the named session.
/// Mirrors the `focus_session_from_companion` command used by the webview build.
fn focus_session(app: &AppHandle, name: &str) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    let _ = app.emit("codehub://focus-session", name);
}
