use bollard::container::{
    ListContainersOptions, LogsOptions, MemoryStatsStats, StatsOptions, TopOptions,
};
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::Docker;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DockerError {
    #[error("bollard: {0}")]
    Bollard(#[from] bollard::errors::Error),
    #[error("container not running: {0}")]
    ContainerDown(String),
    #[error("unknown CLI: {0}")]
    UnknownCli(String),
    #[error("path outside /workspace: {0}")]
    InvalidPath(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionInfo {
    pub name: String,
    pub windows: u32,
    pub attached: bool,
    /// Unix epoch seconds when the tmux session was created (`session_created`).
    /// 0 when tmux didn't report it — the UI then omits the uptime rather than
    /// showing a bogus age.
    pub created: i64,
}

/// Installed version of a CLI inside the runtime container, as reported by
/// `<bin> --version`. `None` when the container is down or the probe fails.
#[derive(Debug, Serialize, Clone)]
pub struct AgentVersion {
    pub version: Option<String>,
}

/// One-shot resource snapshot for the runtime container, derived from bollard's
/// `docker.stats()` the same way the docker CLI computes them. Bytes are raw;
/// the UI formats them. Backs the Containers view gauge cards.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStats {
    /// Container CPU as a percentage of total host capacity (can exceed 100 on
    /// multi-core), matching `docker stats`.
    pub cpu_pct: f64,
    pub mem_used: u64,
    pub mem_limit: u64,
    pub net_rx: u64,
    pub net_tx: u64,
    /// Total block-IO bytes (read + write) since container start.
    pub disk: u64,
}

/// Identity of the image the runtime container runs, from `docker inspect` +
/// `docker image inspect`. Backs the Containers view "Image" card. Every field
/// is `Option` so a missing value renders as an em-dash rather than a fake.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    /// Image ID (`sha256:…`), as the container resolves it.
    pub id: Option<String>,
    /// First repo tag, e.g. `ghcr.io/.../codehub-runtime:0.1.2`.
    pub tag: Option<String>,
    /// First repo digest's `sha256:…` (registry content digest), if pulled.
    pub digest: Option<String>,
    /// Image build time, RFC 3339 as Docker reports it.
    pub created: Option<String>,
    /// On-disk image size in bytes.
    pub size: Option<i64>,
    pub arch: Option<String>,
    pub os: Option<String>,
}

/// Liveness facts about the runtime container, read from `docker inspect`'s
/// `State` block. Backs the Containers view hero (uptime + restart count).
/// Every field is `Option` so a missing value renders as an em-dash rather than
/// a fabricated zero.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    /// `State.StartedAt`, RFC 3339, for the current run — the UI derives uptime
    /// from it. `None` when the container has never started (Docker reports a
    /// zero timestamp, which we drop rather than show as a bogus age).
    pub started_at: Option<String>,
    /// `RestartCount` — times Docker has auto-restarted the container.
    pub restart_count: Option<i64>,
    /// `State.Status` token: "running", "exited", "created", …
    pub status: Option<String>,
    /// `State.OOMKilled` — whether the last stop was an out-of-memory kill.
    pub oom_killed: Option<bool>,
}

/// One bind/volume mount of the runtime container, read from `docker inspect`.
/// `source` is the host-side path (or volume name); `destination` the in-container
/// path. Backs the Containers view "Mounts" card — the real host path behind
/// `/workspace` and `/config`, rather than a hardcoded guess.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MountInfo {
    pub source: String,
    pub destination: String,
    pub rw: bool,
    /// Mount kind as Docker reports it: "bind", "volume", "tmpfs", …
    pub kind: String,
}

/// One changed path in the `/workspace` working tree, from `git status
/// --porcelain`. `status` is the raw 2-char XY code (e.g. " M", "??", "A ").
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub status: String,
}

/// Working-tree state of the `/workspace` mount. `is_repo: false` covers both
/// "not a git repo" and "git unavailable" — the UI shows an honest note either
/// way rather than a fake clean tree. `files` is capped (see `git_status`).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
    /// Total changed paths, even when `files` is truncated for display.
    pub total: u32,
}

/// One process running inside the runtime container, from `docker top` (host
/// `ps` against the container's PID namespace — no in-container `ps` needed).
/// Backs the Containers view "Processes" card. Fields are whatever the platform
/// `ps` reports; missing columns come back empty / `None` rather than fabricated.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: String,
    pub user: String,
    pub time: Option<String>,
    pub command: String,
}

/// One commit from `git log` on `/workspace`. `hash` is the full SHA (the UI
/// shortens it); `relative` is git's human age ("2 hours ago"). Backs the
/// Dashboard "Recent commits" card.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub author: String,
    pub relative: String,
    pub subject: String,
}

/// One entry in a `/workspace` directory listing (Files browser). `kind` is
/// "dir" | "file" | "link" | "other"; `size` is bytes (0 for directories). The
/// listing is non-recursive — the UI navigates one level at a time.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: String,
    pub size: i64,
}

/// Cumulative token counts. Every field is a real sum from the `usage` block of
/// `assistant` lines in Claude Code's session transcripts — never estimated.
#[derive(Debug, Serialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

/// Per-model usage rollup. `turns` counts model responses (assistant lines) seen
/// for this model. `priced` is false when no rate table entry matched the model,
/// in which case `est_cost_usd` is 0 and the tokens are reported as unpriced.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub totals: TokenTotals,
    pub turns: u32,
    pub est_cost_usd: f64,
    pub priced: bool,
}

/// Per-day usage rollup (UTC date `YYYY-MM-DD` from each line's `timestamp`).
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub date: String,
    pub totals: TokenTotals,
    pub est_cost_usd: f64,
}

/// One model family's per-million-token rates, surfaced to the UI so the cost
/// estimate is transparent about the prices it used (and that they are an
/// estimate, not a billed figure).
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRate {
    pub family: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_write_per_mtok: f64,
    pub cache_read_per_mtok: f64,
}

/// Aggregate token analytics read from Claude Code's on-disk session transcripts
/// (`$CLAUDE_CONFIG_DIR/projects/**/*.jsonl`). Token counts and turn/session
/// counts are FACTUAL (straight from the transcripts). `est_cost_usd` is an
/// ESTIMATE: tokens × the published `rates` (as of `rates_as_of`), not a billed
/// amount. `unpriced_tokens` is the input+output token volume from models with
/// no rate-table match, excluded from the cost estimate.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub sessions: u32,
    pub turns: u32,
    pub totals: TokenTotals,
    pub est_cost_usd: f64,
    pub by_model: Vec<ModelUsage>,
    pub by_day: Vec<DayUsage>,
    pub rates: Vec<ModelRate>,
    pub rates_as_of: String,
    pub unpriced_tokens: u64,
}

/// One past Claude Code conversation, reconstructed from its on-disk transcript
/// so it can be reopened with `claude --resume <id>`. Every field is FACTUAL:
/// `title` is the transcript's own `ai-title` (or, lacking one, its first user
/// prompt); `branch` is the recorded `gitBranch` (detached `HEAD` → `None`);
/// `turns` counts distinct user messages; timestamps are the transcript's. No
/// field is fabricated — a missing one is `None`/empty, never guessed.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    pub id: String,
    pub title: String,
    pub branch: Option<String>,
    pub started: String,
    pub last_active: String,
    pub turns: u32,
    pub model: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Cli {
    Claude,
    Codex,
    Antigravity,
}

impl Cli {
    pub fn binary(self) -> &'static str {
        match self {
            Cli::Claude => "claude",
            Cli::Codex => "codex",
            Cli::Antigravity => "antigravity",
        }
    }

    pub fn parse(s: &str) -> Result<Self, DockerError> {
        match s.to_ascii_lowercase().as_str() {
            "claude" | "claude-code" => Ok(Cli::Claude),
            "codex" | "openai" => Ok(Cli::Codex),
            "antigravity" | "google" => Ok(Cli::Antigravity),
            other => Err(DockerError::UnknownCli(other.into())),
        }
    }

    /// Argv to launch the CLI under the given permission mode. The first element
    /// is the binary; the rest are mode flags. Flags are verified against each
    /// CLI's docs — YOLO variants are safe here because the runtime container is
    /// the sandbox boundary. Antigravity is unverified, so it ignores `mode`.
    pub fn launch_argv(self, mode: LaunchMode) -> Vec<&'static str> {
        let bin = self.binary();
        match (self, mode) {
            // Claude Code: `auto` uses the classifier to auto-approve safe tool calls
            // (incl. shell) while still blocking dangerous ones — a better Auto tier
            // than `acceptEdits`, which frees only edits and prompts on shell. `skip`
            // bypasses every guard.
            (Cli::Claude, LaunchMode::Auto) => vec![bin, "--permission-mode", "auto"],
            (Cli::Claude, LaunchMode::Yolo) => vec![bin, "--dangerously-skip-permissions"],
            // Codex (0.132): --full-auto was removed; the sandbox+approval pair is the
            // equivalent (auto-run inside the workspace, escalate only on failure).
            // --yolo is a still-accepted alias for the no-sandbox/no-approval bypass.
            (Cli::Codex, LaunchMode::Auto) => {
                vec![
                    bin,
                    "--sandbox",
                    "workspace-write",
                    "--ask-for-approval",
                    "on-failure",
                ]
            },
            (Cli::Codex, LaunchMode::Yolo) => vec![bin, "--yolo"],
            // Standard, and any Antigravity mode, launch the bare binary.
            _ => vec![bin],
        }
    }
}

/// Permission posture a session is launched with. Maps to per-CLI flags in
/// [`Cli::launch_argv`].
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LaunchMode {
    /// Agent asks before edits / commands (each CLI's default).
    #[default]
    Standard,
    /// Auto-accept edits inside the workspace, still sandboxed.
    Auto,
    /// Skip all approvals and sandbox — relies on the container as the boundary.
    Yolo,
}

impl LaunchMode {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "auto" => LaunchMode::Auto,
            "yolo" => LaunchMode::Yolo,
            _ => LaunchMode::Standard,
        }
    }
}

/// Distinguishes a real `--version` line from a docker-exec failure that
/// `exec_capture` (which merges stdout+stderr) returns when a binary is absent,
/// e.g. `exec failed: ... executable file not found in $PATH`. A version string
/// always contains a digit and none of these error markers.
fn is_version_like(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    const MARKERS: [&str; 5] = [
        "exec failed",
        "not found",
        "no such file",
        "executable file",
        "permission denied",
    ];
    s.chars().any(|c| c.is_ascii_digit()) && !MARKERS.iter().any(|m| lower.contains(m))
}

#[derive(Clone)]
pub struct DockerClient {
    pub container: String,
    pub docker: Docker,
}

impl DockerClient {
    pub fn new(container: String) -> Result<Self, Box<dyn std::error::Error>> {
        let docker = Docker::connect_with_local_defaults()?;
        Ok(Self { container, docker })
    }

    pub fn from_docker(docker: Docker, container: String) -> Self {
        Self { container, docker }
    }

    pub async fn is_running(&self) -> Result<bool, DockerError> {
        let mut filters = HashMap::new();
        filters.insert("name".to_string(), vec![self.container.clone()]);
        filters.insert("status".to_string(), vec!["running".to_string()]);

        let containers = self
            .docker
            .list_containers(Some(ListContainersOptions::<String> {
                all: false,
                filters,
                ..Default::default()
            }))
            .await?;
        Ok(!containers.is_empty())
    }

    async fn exec_capture(&self, cmd: Vec<&str>) -> Result<String, DockerError> {
        let exec = self
            .docker
            .create_exec::<String>(
                &self.container,
                CreateExecOptions {
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    cmd: Some(cmd.into_iter().map(String::from).collect()),
                    env: Some(vec!["TMUX_TMPDIR=/tmp/codehub".into()]),
                    ..Default::default()
                },
            )
            .await?;

        let started = self
            .docker
            .start_exec(
                &exec.id,
                Some(StartExecOptions {
                    detach: false,
                    ..Default::default()
                }),
            )
            .await?;

        if let StartExecResults::Attached { mut output, .. } = started {
            let mut buf = String::new();
            while let Some(chunk) = output.next().await {
                match chunk? {
                    bollard::container::LogOutput::StdOut { message }
                    | bollard::container::LogOutput::StdErr { message }
                    | bollard::container::LogOutput::Console { message } => {
                        buf.push_str(&String::from_utf8_lossy(&message));
                    },
                    _ => {},
                }
            }
            Ok(buf)
        } else {
            Ok(String::new())
        }
    }

    /// Probe each CLI's `--version` inside the container. Best-effort: a stopped
    /// container or a failing/absent binary yields `version: None` for that CLI
    /// rather than an error, so the caller always gets a full map.
    pub async fn agent_versions(&self) -> HashMap<String, AgentVersion> {
        let running = self.is_running().await.unwrap_or(false);
        let mut out = HashMap::new();
        for cli in [Cli::Claude, Cli::Codex, Cli::Antigravity] {
            let version = if running {
                self.exec_capture(vec![cli.binary(), "--version"])
                    .await
                    .ok()
                    .map(|s| s.lines().next().unwrap_or_default().trim().to_string())
                    .filter(|s| !s.is_empty())
                    .filter(|s| is_version_like(s))
            } else {
                None
            };
            out.insert(cli.binary().to_string(), AgentVersion { version });
        }
        out
    }

    pub async fn list_tmux_sessions(&self) -> Result<Vec<SessionInfo>, DockerError> {
        if !self.is_running().await? {
            return Err(DockerError::ContainerDown(self.container.clone()));
        }

        let out = self
            .exec_capture(vec![
                "tmux",
                "list-sessions",
                "-F",
                "#{session_name}|#{session_windows}|#{session_attached}|#{session_created}",
            ])
            .await
            .unwrap_or_default();

        let mut sessions = Vec::new();
        for line in out.lines() {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 3 {
                sessions.push(SessionInfo {
                    name: parts[0].to_string(),
                    windows: parts[1].parse().unwrap_or(0),
                    attached: parts[2] != "0",
                    // `session_created` is epoch seconds; absent on older tmux → 0.
                    created: parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0),
                });
            }
        }
        Ok(sessions)
    }

    pub async fn create_tmux_session(
        &self,
        name: &str,
        cli: Cli,
        mode: LaunchMode,
        alias: &str,
        resume: Option<&str>,
    ) -> Result<(), DockerError> {
        // `-e IS_SANDBOX=1` marks the pane env as a recognized sandbox so Claude's
        // YOLO mode (--dangerously-skip-permissions) runs as root inside the
        // container instead of refusing. Pane-scoped, so it does not depend on the
        // long-running tmux server's environment. tmux treats trailing argv as the
        // session command; mode flags ride along.
        //
        // `-n <alias>` names the window with CodeHub's display alias (e.g. "Claude 1")
        // so the themed in-pane status bar reads it instead of the opaque session
        // id. The runtime tmux.conf disables auto/allow-rename so the launched CLI
        // can't clobber it. Falls back to the session name if alias is empty.
        let window = if alias.is_empty() { name } else { alias };
        let mut cmd = vec![
            "tmux",
            "new-session",
            "-d",
            "-s",
            name,
            "-n",
            window,
            "-e",
            "IS_SANDBOX=1",
        ];
        cmd.extend(cli.launch_argv(mode));
        // Resume reopens a specific past conversation by its transcript id
        // (`claude --resume <id>`). Only Claude persists resumable transcripts and
        // the Resume screen only offers Claude sessions, so this rides on Claude's
        // argv; `--resume` after the mode flags resolves the recorded session. The
        // id comes from the transcript filename (a UUID), never user free-text.
        if let (Cli::Claude, Some(id)) = (cli, resume) {
            cmd.push("--resume");
            cmd.push(id);
        }
        self.exec_capture(cmd).await?;
        Ok(())
    }

    pub async fn kill_tmux_session(&self, name: &str) -> Result<(), DockerError> {
        self.exec_capture(vec!["tmux", "kill-session", "-t", name])
            .await?;
        Ok(())
    }

    /// Rename a session's window so the themed in-pane status bar (which renders
    /// the window name `#W`) reflects an alias the user edited in the UI. Each
    /// CodeHub session has exactly one window, so `-t <name>` resolves it.
    pub async fn rename_tmux_window(&self, name: &str, alias: &str) -> Result<(), DockerError> {
        self.exec_capture(vec!["tmux", "rename-window", "-t", name, alias])
            .await?;
        Ok(())
    }

    pub async fn attach_exec(
        &self,
        session: &str,
        cols: u16,
        rows: u16,
    ) -> Result<AttachHandles, DockerError> {
        let exec = self
            .docker
            .create_exec::<String>(
                &self.container,
                CreateExecOptions {
                    attach_stdin: Some(true),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    tty: Some(true),
                    cmd: Some(vec![
                        "tmux".into(),
                        "attach-session".into(),
                        "-t".into(),
                        session.into(),
                    ]),
                    env: Some(vec![
                        "TERM=xterm-256color".into(),
                        "TMUX_TMPDIR=/tmp/codehub".into(),
                    ]),
                    ..Default::default()
                },
            )
            .await?;

        let started = self
            .docker
            .start_exec(
                &exec.id,
                Some(StartExecOptions {
                    detach: false,
                    tty: true,
                    output_capacity: None,
                }),
            )
            .await?;

        match started {
            StartExecResults::Attached { output, input } => {
                self.docker
                    .resize_exec(
                        &exec.id,
                        ResizeExecOptions {
                            height: rows,
                            width: cols,
                        },
                    )
                    .await?;
                Ok(AttachHandles {
                    exec_id: exec.id,
                    output,
                    input,
                })
            },
            StartExecResults::Detached => Err(DockerError::ContainerDown(
                "exec detached unexpectedly".into(),
            )),
        }
    }

    pub async fn resize_exec(
        &self,
        exec_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), DockerError> {
        self.docker
            .resize_exec(
                exec_id,
                ResizeExecOptions {
                    height: rows,
                    width: cols,
                },
            )
            .await?;
        Ok(())
    }

    /// One-shot CPU / memory / net / disk snapshot. `stream: false` returns a
    /// single reading whose `precpu_stats` the daemon fills from its own prior
    /// sample, so the CPU delta is valid (a `one_shot` read zeroes precpu and
    /// can't). Errors when the container is down so the caller leaves the gauges
    /// blank rather than showing zeros.
    pub async fn stats(&self) -> Result<ContainerStats, DockerError> {
        if !self.is_running().await? {
            return Err(DockerError::ContainerDown(self.container.clone()));
        }
        let s = self
            .docker
            .stats(
                &self.container,
                Some(StatsOptions {
                    stream: false,
                    one_shot: false,
                }),
            )
            .next()
            .await
            .ok_or_else(|| DockerError::ContainerDown(self.container.clone()))??;

        // CPU% per the docker formula: container-usage delta over system delta,
        // scaled by the number of online cores.
        let cpu_delta =
            s.cpu_stats.cpu_usage.total_usage as f64 - s.precpu_stats.cpu_usage.total_usage as f64;
        let sys_delta = s.cpu_stats.system_cpu_usage.unwrap_or(0) as f64
            - s.precpu_stats.system_cpu_usage.unwrap_or(0) as f64;
        let online = s
            .cpu_stats
            .online_cpus
            .or_else(|| {
                s.cpu_stats
                    .cpu_usage
                    .percpu_usage
                    .as_ref()
                    .map(|v| v.len() as u64)
            })
            .unwrap_or(1) as f64;
        let cpu_pct = if sys_delta > 0.0 && cpu_delta > 0.0 {
            (cpu_delta / sys_delta) * online * 100.0
        } else {
            0.0
        };

        // Memory: usage minus inactive file-cache, matching `docker stats`.
        let usage = s.memory_stats.usage.unwrap_or(0);
        let inactive = match s.memory_stats.stats {
            Some(MemoryStatsStats::V1(v)) => v.total_inactive_file,
            Some(MemoryStatsStats::V2(v)) => v.inactive_file,
            None => 0,
        };
        let mem_used = usage.saturating_sub(inactive);
        let mem_limit = s.memory_stats.limit.unwrap_or(0);

        // Net + disk: sum across interfaces / block devices.
        let (mut net_rx, mut net_tx) = (0u64, 0u64);
        if let Some(nets) = &s.networks {
            for n in nets.values() {
                net_rx += n.rx_bytes;
                net_tx += n.tx_bytes;
            }
        }
        let mut disk = 0u64;
        if let Some(entries) = &s.blkio_stats.io_service_bytes_recursive {
            for e in entries {
                let op = e.op.to_ascii_lowercase();
                if op == "read" || op == "write" {
                    disk += e.value;
                }
            }
        }

        Ok(ContainerStats {
            cpu_pct,
            mem_used,
            mem_limit,
            net_rx,
            net_tx,
            disk,
        })
    }

    /// Last `tail` lines of the runtime container's stdout+stderr (the `docker
    /// logs` tail), newest last. One-shot, not a follow stream — the Containers
    /// view re-polls. Errors when the container is down so the panel stays on its
    /// honest placeholder rather than showing a stale tail.
    pub async fn logs(&self, tail: u32) -> Result<Vec<String>, DockerError> {
        if !self.is_running().await? {
            return Err(DockerError::ContainerDown(self.container.clone()));
        }
        let mut stream = self.docker.logs(
            &self.container,
            Some(LogsOptions::<String> {
                stdout: true,
                stderr: true,
                timestamps: false,
                tail: tail.to_string(),
                ..Default::default()
            }),
        );
        // Logs arrive as framed chunks that align to neither lines nor UTF-8
        // boundaries (a glyph can straddle two frames), so accumulate the raw
        // bytes and decode once at the end before splitting into lines.
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            buf.extend_from_slice(chunk?.into_bytes().as_ref());
        }
        Ok(String::from_utf8_lossy(&buf)
            .lines()
            .map(str::to_string)
            .collect())
    }

    /// The runtime container's bind/volume mounts, from `docker inspect`. Unlike
    /// the lifecycle config (which only knows what it *requested*), this reports
    /// what the container is actually running with. Errors when the container is
    /// missing; an empty list is valid (no mounts).
    pub async fn mounts(&self) -> Result<Vec<MountInfo>, DockerError> {
        let info = self.docker.inspect_container(&self.container, None).await?;
        Ok(info
            .mounts
            .unwrap_or_default()
            .into_iter()
            .filter_map(|m| {
                // A mount with no destination is meaningless to show; skip it.
                let destination = m.destination?;
                Some(MountInfo {
                    source: m.source.unwrap_or_default(),
                    destination,
                    rw: m.rw.unwrap_or(true),
                    // Display is the serde-rename-faithful token ("bind", "volume",
                    // …); fall back to "bind" only if the type is absent.
                    kind: m
                        .typ
                        .map(|t| t.to_string())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "bind".to_string()),
                })
            })
            .collect())
    }

    /// Identity of the image the runtime container runs (Containers view "Image"
    /// card): resolves the container's image ref via `inspect_container`, then
    /// `inspect_image` for tag/digest/created/size/arch/os. Like [`mounts`], this
    /// reads the actual container (no `is_running` gate) so it works for a stopped
    /// container too; errors only when the container/image can't be inspected, in
    /// which case the UI leaves the card em-dashed.
    pub async fn image_info(&self) -> Result<ImageInfo, DockerError> {
        let container = self.docker.inspect_container(&self.container, None).await?;
        // The container's resolved image (an id, `sha256:…`); fall back to the
        // configured image name if the id field is absent.
        let image_ref = container
            .image
            .or_else(|| container.config.and_then(|c| c.image))
            .ok_or_else(|| DockerError::ContainerDown(self.container.clone()))?;
        let img = self.docker.inspect_image(&image_ref).await?;
        // `repo_digests` entries look like `repo@sha256:…`; keep just the digest.
        let digest = img
            .repo_digests
            .and_then(|d| d.into_iter().next())
            .and_then(|rd| rd.rsplit_once('@').map(|(_, sha)| sha.to_string()));
        Ok(ImageInfo {
            id: img.id,
            tag: img.repo_tags.and_then(|t| t.into_iter().next()),
            digest,
            created: img.created,
            size: img.size,
            arch: img.architecture,
            os: img.os,
        })
    }

    /// Liveness of the runtime container (Containers view hero): started-at,
    /// restart count, status and OOM flag from `inspect_container`'s `State`.
    /// Like [`mounts`] and [`image_info`] this reads the real container with no
    /// `is_running` gate (a stopped container still has a `State`); it errors
    /// only when the container can't be inspected.
    pub async fn health(&self) -> Result<RuntimeHealth, DockerError> {
        let info = self.docker.inspect_container(&self.container, None).await?;
        let state = info.state;
        Ok(RuntimeHealth {
            // Docker reports the zero timestamp for a never-started container;
            // treat that (and an empty string) as "no uptime" rather than 1-AD.
            started_at: state
                .as_ref()
                .and_then(|s| s.started_at.clone())
                .filter(|s| !s.is_empty() && s != "0001-01-01T00:00:00Z"),
            restart_count: info.restart_count,
            status: state.as_ref().and_then(|s| s.status).map(|s| s.to_string()),
            oom_killed: state.as_ref().and_then(|s| s.oom_killed),
        })
    }

    /// Working-tree status of the `/workspace` mount via
    /// `git status --porcelain=v1 --branch`. Errors only when the container is
    /// down; "not a git repo" and "git not installed" both come back as
    /// `is_repo: false` so the UI shows an honest note rather than a fake-clean
    /// tree. `files` is capped at [`GIT_FILES_CAP`]; `total` is the full count.
    pub async fn git_status(&self) -> Result<GitStatus, DockerError> {
        if !self.is_running().await? {
            return Err(DockerError::ContainerDown(self.container.clone()));
        }
        let raw = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                // Don't octal-escape non-ASCII paths; we still unquote the
                // double-quoted form (spaces, control chars) in the parser.
                "-c",
                "core.quotePath=false",
                "status",
                "--porcelain=v1",
                "--branch",
            ])
            .await?;
        Ok(parse_git_status(&raw))
    }

    /// Unified diff for one `/workspace` path. Tries `diff HEAD -- <path>` first
    /// (captures staged + unstaged changes to a tracked file vs the last
    /// commit); if that yields nothing — a brand-new untracked file, or a repo
    /// with no commits yet — falls back to `diff --no-index /dev/null <path>` so
    /// the new file shows as all-added. `path` is passed after `--` so it can
    /// never be read as an option. Errors only when the container is down.
    pub async fn git_diff(&self, path: &str) -> Result<String, DockerError> {
        if !self.is_running().await? {
            return Err(DockerError::ContainerDown(self.container.clone()));
        }
        let tracked = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                "-c",
                "core.quotePath=false",
                "diff",
                "--no-color",
                "HEAD",
                "--",
                path,
            ])
            .await?;
        // A real tracked-file diff starts with "diff --git"; anything else
        // (empty, or a "fatal: bad revision HEAD" on a commit-less repo) means
        // fall through to the untracked/new-file path.
        if tracked.contains("diff --git") {
            return Ok(tracked);
        }
        let untracked = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                "-c",
                "core.quotePath=false",
                "diff",
                "--no-color",
                "--no-index",
                "--",
                "/dev/null",
                path,
            ])
            .await?;
        Ok(untracked)
    }

    /// Combined unified diff of every tracked change in `/workspace` vs the last
    /// commit (`diff HEAD`, no pathspec) — the "review everything this agent
    /// changed" view. Untracked files are not included (they're not in `HEAD`);
    /// the per-file `git_diff` handles those. Output without a `diff --git`
    /// marker (clean tree, or a `fatal: bad revision HEAD` on a commit-less repo)
    /// comes back as an empty string so the UI shows an honest empty state.
    /// Errors only when the container is down.
    pub async fn git_diff_all(&self) -> Result<String, DockerError> {
        if !self.is_running().await? {
            return Err(DockerError::ContainerDown(self.container.clone()));
        }
        let out = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                "-c",
                "core.quotePath=false",
                "diff",
                "--no-color",
                "HEAD",
            ])
            .await?;
        if out.contains("diff --git") {
            Ok(out)
        } else {
            Ok(String::new())
        }
    }

    /// Processes running inside the runtime container, via `docker top` (default
    /// `ps` args). Uses the host's `ps` against the container PID namespace, so
    /// it works even on a minimal image with no `ps` of its own. Column layout
    /// varies by platform, so `parse_top` maps by title rather than by position.
    /// Errors only when the container is down.
    pub async fn top(&self) -> Result<Vec<ProcessInfo>, DockerError> {
        if !self.is_running().await? {
            return Err(DockerError::ContainerDown(self.container.clone()));
        }
        let resp = self
            .docker
            .top_processes(&self.container, None::<TopOptions<String>>)
            .await?;
        let titles = resp.titles.unwrap_or_default();
        let rows = resp.processes.unwrap_or_default();
        Ok(parse_top(&titles, &rows))
    }

    /// Recent commits on the `/workspace` working tree (Dashboard "Recent
    /// commits"). Fields are joined by US (\x1f) and split in `parse_git_log` so
    /// a subject with spaces stays intact. `limit` is clamped to `GIT_LOG_CAP`.
    /// Not-a-repo / no-commits-yet come back as an empty list (the UI shows an
    /// honest note); errors only when the container is down.
    pub async fn git_log(&self, limit: u32) -> Result<Vec<CommitInfo>, DockerError> {
        if !self.is_running().await? {
            return Err(DockerError::ContainerDown(self.container.clone()));
        }
        let n = format!("-n{}", limit.clamp(1, GIT_LOG_CAP));
        let raw = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                "-c",
                "core.quotePath=false",
                "log",
                "--no-color",
                &n,
                "--pretty=format:%H%x1f%an%x1f%ar%x1f%s",
            ])
            .await?;
        Ok(parse_git_log(&raw))
    }

    /// Non-recursive listing of a `/workspace` directory (Files browser). `path`
    /// is confined to `/workspace` ([`workspace_path`] rejects traversal); empty
    /// → the workspace root. Uses `find -maxdepth 1` with a `%y\t%s\t%f` format
    /// (type / size / name) so the output is unambiguous regardless of locale,
    /// unlike parsing `ls`. Capped at [`DIR_ENTRIES_CAP`]. Errors when the
    /// container is down or the path escapes the workspace.
    pub async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, DockerError> {
        if !self.is_running().await? {
            return Err(DockerError::ContainerDown(self.container.clone()));
        }
        let dir = workspace_path(path)?;
        let raw = self
            .exec_capture(vec![
                "find",
                &dir,
                "-maxdepth",
                "1",
                "-mindepth",
                "1",
                "-printf",
                "%y\t%s\t%f\n",
            ])
            .await?;
        Ok(parse_find(&raw))
    }

    /// First [`FILE_READ_CAP`] bytes of a `/workspace` file (Files browser
    /// preview). `path` is confined to `/workspace`. `head -c` caps the read at
    /// the source so a huge file never streams into memory; the bytes are
    /// returned UTF-8-lossy (binary files show replacement chars — the UI notes
    /// the cap). Errors when the container is down or the path escapes.
    pub async fn read_file(&self, path: &str) -> Result<String, DockerError> {
        if !self.is_running().await? {
            return Err(DockerError::ContainerDown(self.container.clone()));
        }
        let file = workspace_path(path)?;
        // `workspace_path` only validates the path *text*; `head` would still
        // follow a symlink (or a symlinked parent dir) that points out of the
        // mount. Resolve the real path in-container and re-confine it so the
        // `/workspace` guarantee holds for the bytes actually read, not just the
        // requested name. `-m` canonicalizes without requiring the file to exist
        // (a missing file then fails at the `head` below, as before).
        let canonical = self
            .exec_capture(vec!["readlink", "-m", "--", &file])
            .await?;
        let canonical = canonical.trim();
        if canonical.is_empty() {
            return Err(DockerError::InvalidPath(file));
        }
        let real = workspace_path(canonical)?;
        let cap = FILE_READ_CAP.to_string();
        // `--` ends option parsing so a path starting with `-` is still a path.
        self.exec_capture(vec!["head", "-c", &cap, "--", &real])
            .await
    }

    /// Aggregate token-usage analytics from Claude Code's on-disk session
    /// transcripts under `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl` (the runtime
    /// pins `CLAUDE_CONFIG_DIR=/config/claude`, on the persistent `/config`
    /// mount). Concatenates every transcript — each JSONL line carries its own
    /// `sessionId`, so file boundaries don't matter — and folds the `usage`
    /// blocks of `assistant` lines into real token totals plus an estimated cost
    /// (see [`parse_claude_usage`]). Errors only when the container is down; a
    /// missing `projects` dir yields an all-zero report, not an error.
    pub async fn claude_usage(&self) -> Result<ClaudeUsage, DockerError> {
        if !self.is_running().await? {
            return Err(DockerError::ContainerDown(self.container.clone()));
        }
        // `find … -exec cat {} +` batches the reads; transcripts are newline-
        // terminated JSONL so concatenation never fuses two lines. `2>/dev/null`
        // and the `|| true` keep a missing projects dir from erroring — the
        // parser simply sees no input. Routed through `sh -c` for the glob/redirect.
        let raw = self
            .exec_capture(vec![
                "sh",
                "-c",
                "find /config/claude/projects -type f -name '*.jsonl' -exec cat {} + 2>/dev/null || true",
            ])
            .await?;
        Ok(parse_claude_usage(&raw))
    }

    /// List past Claude Code conversations from their on-disk transcripts (same
    /// source as [`claude_usage`]) so they can be reopened with `--resume`. Each
    /// distinct `sessionId` becomes one [`ClaudeSession`]; see [`parse_claude_sessions`]
    /// for how title/branch/turns are derived. Errors only when the container is
    /// down; a missing `projects` dir yields an empty list, not an error.
    pub async fn claude_sessions(&self) -> Result<Vec<ClaudeSession>, DockerError> {
        if !self.is_running().await? {
            return Err(DockerError::ContainerDown(self.container.clone()));
        }
        let raw = self
            .exec_capture(vec![
                "sh",
                "-c",
                "find /config/claude/projects -type f -name '*.jsonl' -exec cat {} + 2>/dev/null || true",
            ])
            .await?;
        Ok(parse_claude_sessions(&raw))
    }
}

/// Normalize and confine a browser path to `/workspace`. Empty → the workspace
/// root. Rejects any `..` component (and anything not under `/workspace`) so the
/// Files browser can never read outside the mount.
fn workspace_path(path: &str) -> Result<String, DockerError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok("/workspace".to_string());
    }
    let invalid = trimmed != "/workspace" && !trimmed.starts_with("/workspace/")
        || trimmed.split('/').any(|seg| seg == "..");
    if invalid {
        return Err(DockerError::InvalidPath(trimmed.to_string()));
    }
    Ok(trimmed.to_string())
}

/// Parse `find -printf '%y\t%s\t%f\n'` output into [`FileEntry`] rows. Each line
/// is `type<TAB>size<TAB>name`; `type` is find's single char (d/f/l/…). Lines
/// that don't split into three fields are skipped. Capped at [`DIR_ENTRIES_CAP`].
/// A name containing a literal newline (pathological) splits across lines and is
/// dropped rather than mis-parsed — the listing under-reports, never corrupts.
fn parse_find(raw: &str) -> Vec<FileEntry> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let ty = parts.next()?;
            let size = parts.next()?;
            let name = parts.next()?;
            if name.is_empty() {
                return None;
            }
            let kind = match ty {
                "d" => "dir",
                "f" => "file",
                "l" => "link",
                _ => "other",
            };
            Some(FileEntry {
                name: name.to_string(),
                kind: kind.to_string(),
                size: size.parse().unwrap_or(0),
            })
        })
        .take(DIR_ENTRIES_CAP)
        .collect()
}

/// Cap on changed paths returned to the UI; the rail only renders a short list.
const GIT_FILES_CAP: usize = 200;

/// Upper bound on commits a single `git_log` call will return.
const GIT_LOG_CAP: u32 = 50;

/// Cap on entries returned for one directory listing (Files browser).
const DIR_ENTRIES_CAP: usize = 500;

/// Cap on bytes returned for a file preview (Files browser): 256 KiB.
const FILE_READ_CAP: usize = 262_144;

/// As-of label for [`USAGE_RATES`]. Surfaced to the UI so the cost estimate is
/// honest about how current its prices are.
const RATES_AS_OF: &str = "2026-05";

/// Published per-million-token list prices (USD) by Claude model family, used
/// only to ESTIMATE cost from real token counts. Tuple is
/// `(family, input, output, cache_write_5m, cache_read)`. A model whose name
/// contains none of these families is left unpriced (its tokens are reported
/// under `unpriced_tokens` and excluded from the estimate). Update alongside
/// [`RATES_AS_OF`] when Anthropic's pricing changes.
const USAGE_RATES: &[(&str, f64, f64, f64, f64)] = &[
    ("opus", 15.0, 75.0, 18.75, 1.50),
    ("sonnet", 3.0, 15.0, 3.75, 0.30),
    ("haiku", 1.0, 5.0, 1.25, 0.10),
];

/// Match a transcript model id (e.g. `claude-opus-4-7`) to its rate row by
/// family substring. Returns `(input, output, cache_write, cache_read)` per Mtok.
fn model_rate(model: &str) -> Option<(f64, f64, f64, f64)> {
    USAGE_RATES
        .iter()
        .find(|(family, ..)| model.contains(family))
        .map(|&(_, i, o, cw, cr)| (i, o, cw, cr))
}

/// Estimated USD cost for one usage block at the given rates (per Mtok).
fn estimate_cost(t: &TokenTotals, rate: (f64, f64, f64, f64)) -> f64 {
    let (ri, ro, rcw, rcr) = rate;
    (t.input as f64 * ri
        + t.output as f64 * ro
        + t.cache_creation as f64 * rcw
        + t.cache_read as f64 * rcr)
        / 1_000_000.0
}

/// Running per-bucket accumulator (one per model and per day) folded by
/// [`parse_claude_usage`], then flattened into the serialized rollups.
#[derive(Default)]
struct UsageBucket {
    totals: TokenTotals,
    turns: u32,
    est_cost_usd: f64,
    priced: bool,
}

impl UsageBucket {
    fn add(&mut self, t: &TokenTotals, cost: f64, priced: bool) {
        self.totals.input += t.input;
        self.totals.output += t.output;
        self.totals.cache_read += t.cache_read;
        self.totals.cache_creation += t.cache_creation;
        self.est_cost_usd += cost;
        // A bucket counts as priced if any contribution to it was priced.
        self.priced |= priced;
    }
}

/// Fold concatenated Claude Code transcripts (JSONL, one event per line) into a
/// [`ClaudeUsage`] rollup. Distinct `sessionId`s are counted as sessions; each
/// `assistant` line is one turn and contributes its `message.usage` token counts
/// to the global, per-model, and per-day (UTC `timestamp[..10]`) totals. Cost is
/// estimated per line from [`USAGE_RATES`]; unpriced models contribute their
/// input+output tokens to `unpriced_tokens` and nothing to the estimate.
/// Unparseable or non-object lines are skipped, so partial/garbled input
/// under-reports rather than failing.
fn parse_claude_usage(raw: &str) -> ClaudeUsage {
    use std::collections::{BTreeMap, HashSet};

    let mut sessions: HashSet<String> = HashSet::new();
    // Dedup key for assistant lines: a resumed/forked/compacted session replays
    // earlier messages into a new transcript, so the same model response (same
    // `message.id` + `requestId`) recurs across files. Counting each occurrence
    // would inflate turns + tokens + the cost estimate — breaking the "factual"
    // contract. We fold each response once. (Distinct `sessionId`s still each
    // count as a session: a resume IS a real new session, just with replayed
    // history.) Lines without a `message.id` are never deduped (no safe key).
    let mut seen: HashSet<String> = HashSet::new();
    let mut global = UsageBucket::default();
    let mut by_model: BTreeMap<String, UsageBucket> = BTreeMap::new();
    let mut by_day: BTreeMap<String, UsageBucket> = BTreeMap::new();
    let mut unpriced_tokens: u64 = 0;

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(sid) = v.get("sessionId").and_then(|s| s.as_str()) {
            sessions.insert(sid.to_string());
        }
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let msg = v.get("message");
        // Skip a replayed duplicate before any accumulation.
        if let Some(id) = msg.and_then(|m| m.get("id")).and_then(|i| i.as_str()) {
            let req = v.get("requestId").and_then(|r| r.as_str()).unwrap_or("");
            if !seen.insert(format!("{id}\u{1f}{req}")) {
                continue;
            }
        }
        let usage = msg.and_then(|m| m.get("usage"));
        let Some(usage) = usage else { continue };
        let tok = |k: &str| usage.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
        let totals = TokenTotals {
            input: tok("input_tokens"),
            output: tok("output_tokens"),
            cache_read: tok("cache_read_input_tokens"),
            cache_creation: tok("cache_creation_input_tokens"),
        };
        let model = msg
            .and_then(|m| m.get("model"))
            .and_then(|m| m.as_str())
            .unwrap_or("unknown")
            .to_string();
        let rate = model_rate(&model);
        let priced = rate.is_some();
        let cost = rate.map(|r| estimate_cost(&totals, r)).unwrap_or(0.0);
        if !priced {
            unpriced_tokens += totals.input + totals.output;
        }

        global.add(&totals, cost, priced);
        global.turns += 1;
        let m = by_model.entry(model).or_default();
        m.add(&totals, cost, priced);
        m.turns += 1;

        if let Some(date) = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .filter(|t| t.len() >= 10)
            .map(|t| t[..10].to_string())
        {
            by_day.entry(date).or_default().add(&totals, cost, priced);
        }
    }

    let mut by_model: Vec<ModelUsage> = by_model
        .into_iter()
        .map(|(model, b)| ModelUsage {
            model,
            totals: b.totals,
            turns: b.turns,
            est_cost_usd: b.est_cost_usd,
            priced: b.priced,
        })
        .collect();
    // Heaviest spenders first; the UI shows a short ranked list.
    by_model.sort_by(|a, b| b.est_cost_usd.total_cmp(&a.est_cost_usd));

    let by_day: Vec<DayUsage> = by_day
        .into_iter()
        .map(|(date, b)| DayUsage {
            date,
            totals: b.totals,
            est_cost_usd: b.est_cost_usd,
        })
        .collect();

    let rates = USAGE_RATES
        .iter()
        .map(|&(family, i, o, cw, cr)| ModelRate {
            family: family.to_string(),
            input_per_mtok: i,
            output_per_mtok: o,
            cache_write_per_mtok: cw,
            cache_read_per_mtok: cr,
        })
        .collect();

    ClaudeUsage {
        sessions: sessions.len() as u32,
        turns: global.turns,
        totals: global.totals,
        est_cost_usd: global.est_cost_usd,
        by_model,
        by_day,
        rates,
        rates_as_of: RATES_AS_OF.to_string(),
        unpriced_tokens,
    }
}

/// Cap on past sessions returned to the Resume screen.
const SESSIONS_CAP: usize = 200;

/// Per-session accumulator folded by [`parse_claude_sessions`], one per
/// `sessionId`, then flattened into a [`ClaudeSession`].
#[derive(Default)]
struct SessionAcc {
    ai_title: Option<String>,
    first_prompt: Option<String>,
    branch: Option<String>,
    version: Option<String>,
    model: Option<String>,
    started: Option<String>,
    last_active: Option<String>,
    /// Distinct user-message uuids — a resumed transcript replays earlier user
    /// turns, so we dedupe by uuid to keep `turns` factual.
    turn_uuids: std::collections::HashSet<String>,
}

/// Claude Code injects its own wrapper text into the user role for slash
/// commands, hooks and caveats (e.g. `<local-command-caveat>…`). These are not
/// the human's prompt, so they make poor titles — we skip them when picking the
/// first-prompt fallback and use the first genuinely-typed prompt instead.
fn is_synthetic_prompt(text: &str) -> bool {
    const WRAPPERS: [&str; 6] = [
        "<local-command-",
        "<command-name>",
        "<command-message>",
        "<command-args>",
        "<bash-input>",
        "<user-prompt-submit-hook>",
    ];
    WRAPPERS.iter().any(|w| text.starts_with(w))
}

/// Extract a human-readable prompt from a Claude `message.content`, which is
/// either a string (simple prompt) or an array of typed blocks (text /
/// tool_result / …). Returns the first real text, trimmed; `None` if there is no
/// textual content (e.g. a pure tool result) or it is only Claude's own
/// command/hook wrapper boilerplate — so a title is never invented or boilerplate.
fn content_text(content: &serde_json::Value) -> Option<String> {
    let pick = |t: &str| {
        let t = t.trim();
        (!t.is_empty() && !is_synthetic_prompt(t)).then(|| t.to_string())
    };
    if let Some(s) = content.as_str() {
        return pick(s);
    }
    if let Some(arr) = content.as_array() {
        for block in arr {
            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                if let Some(text) = pick(t) {
                    return Some(text);
                }
            }
        }
    }
    None
}

/// Fold concatenated Claude Code transcripts (JSONL) into one [`ClaudeSession`]
/// per distinct `sessionId`, newest activity first. `title` prefers the
/// transcript's `ai-title`, falling back to its first user prompt, then a
/// placeholder. `branch` is the recorded `gitBranch` with detached `HEAD`
/// dropped to `None`. `turns` counts distinct user messages (deduped by uuid so
/// replayed history in a resumed transcript doesn't inflate it). Unparseable
/// lines are skipped, so garbled input under-reports rather than failing.
fn parse_claude_sessions(raw: &str) -> Vec<ClaudeSession> {
    use std::collections::HashMap;

    let mut acc: HashMap<String, SessionAcc> = HashMap::new();

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(sid) = v.get("sessionId").and_then(|s| s.as_str()) else {
            continue;
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let entry = acc.entry(sid.to_string()).or_default();

        // ai-title lines carry no timestamp; capture the title and move on.
        if ty == "ai-title" {
            if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                let t = t.trim();
                if !t.is_empty() {
                    entry.ai_title = Some(t.to_string());
                }
            }
            continue;
        }

        // Track the conversation's active window from any timestamped line.
        if let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) {
            if entry.started.as_deref().is_none_or(|s| ts < s) {
                entry.started = Some(ts.to_string());
            }
            if entry.last_active.as_deref().is_none_or(|s| ts > s) {
                entry.last_active = Some(ts.to_string());
            }
        }

        // gitBranch / version ride on user lines; keep the last seen non-empty
        // (both are effectively constant within a session, so order is moot).
        // Detached HEAD is not a real branch name → leave as None.
        if let Some(b) = v.get("gitBranch").and_then(|b| b.as_str()) {
            if !b.is_empty() && b != "HEAD" {
                entry.branch = Some(b.to_string());
            }
        }
        if let Some(ver) = v.get("version").and_then(|s| s.as_str()) {
            if !ver.is_empty() {
                entry.version = Some(ver.to_string());
            }
        }

        match ty {
            "user" => {
                if let Some(uuid) = v.get("uuid").and_then(|u| u.as_str()) {
                    entry.turn_uuids.insert(uuid.to_string());
                }
                if entry.first_prompt.is_none() {
                    if let Some(text) = v
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(content_text)
                    {
                        entry.first_prompt = Some(text);
                    }
                }
            },
            "assistant" => {
                if let Some(m) = v
                    .get("message")
                    .and_then(|m| m.get("model"))
                    .and_then(|m| m.as_str())
                {
                    entry.model = Some(m.to_string());
                }
            },
            _ => {},
        }
    }

    let mut sessions: Vec<ClaudeSession> = acc
        .into_iter()
        .map(|(id, a)| {
            // Title: real ai-title, else first user prompt (one line, clipped),
            // else an honest placeholder — never invented.
            let title = a
                .ai_title
                .or_else(|| a.first_prompt.map(|p| clip_title(&p)))
                .unwrap_or_else(|| "Untitled session".to_string());
            let last_active = a.last_active.clone().unwrap_or_default();
            ClaudeSession {
                id,
                title,
                branch: a.branch,
                started: a.started.unwrap_or_default(),
                last_active,
                turns: a.turn_uuids.len() as u32,
                model: a.model,
                version: a.version,
            }
        })
        .collect();

    // Most recently active first; the UI shows a ranked, capped list.
    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    sessions.truncate(SESSIONS_CAP);
    sessions
}

/// Collapse a user prompt to a single-line title: first line, whitespace
/// normalized, clipped to a sane length so a long paste can't dominate the list.
fn clip_title(prompt: &str) -> String {
    let one_line = prompt.split('\n').next().unwrap_or(prompt);
    let normalized = one_line.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 80;
    if normalized.chars().count() > MAX {
        let head: String = normalized.chars().take(MAX).collect();
        format!("{head}…")
    } else {
        normalized
    }
}

/// Parse the US-delimited `git log` output (one commit per line,
/// `hash\x1fauthor\x1frelative\x1fsubject`). Lines without all four fields —
/// notably a `fatal:` error on a non-repo, or the empty output of a commit-less
/// repo — are skipped, so callers get an empty list rather than garbage rows.
fn parse_git_log(raw: &str) -> Vec<CommitInfo> {
    raw.lines()
        .filter_map(|line| {
            let mut f = line.split('\u{1f}');
            let hash = f.next()?;
            let author = f.next()?;
            let relative = f.next()?;
            let subject = f.next()?;
            if hash.is_empty() {
                return None;
            }
            Some(CommitInfo {
                hash: hash.to_string(),
                author: author.to_string(),
                relative: relative.to_string(),
                subject: subject.to_string(),
            })
        })
        .collect()
}

/// Parse `git status --porcelain=v1 --branch` output. Pulled out of the async
/// method so the line-handling can be unit-tested without a container.
fn parse_git_status(raw: &str) -> GitStatus {
    // exec_capture merges stdout+stderr, so git's own errors land here. Treat
    // "not a repo" / "git missing" as a non-repo rather than a hard error.
    let lower = raw.to_ascii_lowercase();
    if lower.contains("fatal:") || lower.contains("not found") || lower.contains("no such file") {
        return GitStatus {
            is_repo: false,
            branch: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            total: 0,
        };
    }

    let mut branch = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut files = Vec::new();
    let mut total = 0;

    for line in raw.lines() {
        // The `## ` header line carries branch + ahead/behind tracking info.
        if let Some(rest) = line.strip_prefix("## ") {
            let name_part = rest.split("...").next().unwrap_or(rest);
            let name = name_part
                .strip_prefix("No commits yet on ")
                .unwrap_or(name_part)
                .split_whitespace()
                .next()
                .unwrap_or("");
            // "HEAD (no branch)" → detached; leave branch None.
            if !name.is_empty() && name != "HEAD" {
                branch = Some(name.to_string());
            }
            if let Some(inner) = rest
                .split_once('[')
                .and_then(|(_, b)| b.split_once(']'))
                .map(|(inner, _)| inner)
            {
                ahead = parse_track(inner, "ahead");
                behind = parse_track(inner, "behind");
            }
            continue;
        }
        // Each change is `XY <path>` — 2 status chars, a space, then the path.
        if line.len() < 3 {
            continue;
        }
        total += 1;
        if files.len() < GIT_FILES_CAP {
            let status = line[..2].to_string();
            let raw_path = &line[3..];
            // Rename/copy renders as "old -> new"; keep the new path. rsplit so
            // a ` -> ` inside the old path can't steal the split.
            let path_field = raw_path
                .rsplit_once(" -> ")
                .map(|(_, new)| new)
                .unwrap_or(raw_path);
            files.push(GitFile {
                path: unquote_git_path(path_field),
                status,
            });
        }
    }

    GitStatus {
        is_repo: true,
        branch,
        ahead,
        behind,
        files,
        total,
    }
}

/// Pull `ahead`/`behind` counts out of a porcelain bracket like
/// "ahead 1, behind 2".
fn parse_track(inner: &str, key: &str) -> u32 {
    inner
        .split(',')
        .find_map(|seg| {
            seg.trim()
                .strip_prefix(key)
                .and_then(|n| n.trim().parse().ok())
        })
        .unwrap_or(0)
}

/// Index of the first title matching any of `names` (case-insensitive). Lets
/// `parse_top` find a column by name regardless of the platform `ps` layout.
fn col(titles: &[String], names: &[&str]) -> Option<usize> {
    titles
        .iter()
        .position(|t| names.iter().any(|n| t.eq_ignore_ascii_case(n)))
}

/// Map a `docker top` response (titles + rows) to `ProcessInfo`, locating each
/// field by column title. `CMD`/`COMMAND` falls back to the last column (where
/// `ps` always puts the command). Pulled out of the async method so it can be
/// unit-tested without a container.
fn parse_top(titles: &[String], rows: &[Vec<String>]) -> Vec<ProcessInfo> {
    let pid_i = col(titles, &["PID"]);
    let user_i = col(titles, &["USER", "UID"]);
    let time_i = col(titles, &["TIME"]);
    let cmd_i = col(titles, &["CMD", "COMMAND"]);
    rows.iter()
        .filter_map(|r| {
            let at = |i: Option<usize>| i.and_then(|i| r.get(i)).cloned();
            let command = at(cmd_i).or_else(|| r.last().cloned()).unwrap_or_default();
            let pid = at(pid_i).unwrap_or_default();
            // Skip a wholly empty row (defensive against odd ps output).
            if pid.is_empty() && command.is_empty() {
                return None;
            }
            Some(ProcessInfo {
                pid,
                user: at(user_i).unwrap_or_default(),
                time: at(time_i),
                command,
            })
        })
        .collect()
}

/// Undo git's porcelain path quoting. With `core.quotePath=false` non-ASCII is
/// already raw, so only paths with spaces / control chars / quotes arrive in
/// the `"..."` form; strip the quotes and unescape the common C-escapes. A path
/// that isn't quoted is returned unchanged.
fn unquote_git_path(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'"' || bytes[bytes.len() - 1] != b'"' {
        return s.to_string();
    }
    let inner = &s[1..s.len() - 1];
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            // Unknown escape: keep it verbatim rather than dropping data.
            Some(other) => {
                out.push('\\');
                out.push(other);
            },
            None => out.push('\\'),
        }
    }
    out
}

pub struct AttachHandles {
    pub exec_id: String,
    pub output: std::pin::Pin<
        Box<
            dyn futures_util::Stream<
                    Item = Result<bollard::container::LogOutput, bollard::errors::Error>,
                > + Send,
        >,
    >,
    pub input: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>,
}

#[cfg(test)]
mod tests {
    use super::{
        clip_title, is_synthetic_prompt, is_version_like, parse_claude_sessions,
        parse_claude_usage, parse_find, parse_git_log, parse_git_status, parse_top, workspace_path,
    };

    #[test]
    fn version_like_accepts_real_versions_rejects_exec_errors() {
        assert!(is_version_like("2.1.148 (Claude Code)"));
        assert!(is_version_like("codex-cli 0.132.0"));
        // docker-exec failure text for an absent binary
        assert!(!is_version_like(
            "exec failed: unable to start container process: exec: \"antigravity\": executable file not found in $PATH"
        ));
        // no digits → not a version
        assert!(!is_version_like("command not found"));
        assert!(!is_version_like(""));
    }

    #[test]
    fn git_status_parses_branch_tracking_and_changes() {
        let raw = "## main...origin/main [ahead 2, behind 1]\n\
                    M src/app.rs\n\
                   ?? new_file.txt\n\
                   R  old.rs -> renamed.rs\n";
        let s = parse_git_status(raw);
        assert!(s.is_repo);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.ahead, 2);
        assert_eq!(s.behind, 1);
        assert_eq!(s.total, 3);
        assert_eq!(s.files.len(), 3);
        // Rename keeps the new path.
        assert_eq!(s.files[2].path, "renamed.rs");
        assert_eq!(s.files[2].status, "R ");
    }

    #[test]
    fn git_status_handles_clean_tree_and_no_upstream() {
        let s = parse_git_status("## feature/x\n");
        assert!(s.is_repo);
        assert_eq!(s.branch.as_deref(), Some("feature/x"));
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 0);
        assert_eq!(s.total, 0);
        assert!(s.files.is_empty());
    }

    #[test]
    fn git_status_unquotes_paths_with_spaces_and_renames() {
        // Paths with spaces arrive double-quoted even with core.quotePath=false.
        let raw = "## main\n\
                   ?? \"weird name.txt\"\n\
                   R  \"old name.rs\" -> \"new name.rs\"\n";
        let s = parse_git_status(raw);
        assert_eq!(s.files.len(), 2);
        assert_eq!(s.files[0].path, "weird name.txt");
        // Rename keeps the (unquoted) new path.
        assert_eq!(s.files[1].path, "new name.rs");
    }

    #[test]
    fn git_status_reports_non_repo() {
        let s = parse_git_status(
            "fatal: not a git repository (or any of the parent directories): .git\n",
        );
        assert!(!s.is_repo);
        assert!(s.branch.is_none());
        assert_eq!(s.total, 0);
    }

    #[test]
    fn top_maps_columns_by_title() {
        // Linux `docker top` default layout (UID-style USER column, CMD last).
        let titles: Vec<String> = ["UID", "PID", "PPID", "C", "STIME", "TTY", "TIME", "CMD"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let row = |cells: &[&str]| cells.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let rows = vec![
            row(&[
                "root",
                "1",
                "0",
                "0",
                "10:00",
                "?",
                "00:00:01",
                "tmux new-session",
            ]),
            row(&[
                "node",
                "42",
                "1",
                "2",
                "10:01",
                "pts/0",
                "00:00:09",
                "node /usr/bin/claude",
            ]),
        ];
        let procs = parse_top(&titles, &rows);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, "1");
        assert_eq!(procs[0].user, "root");
        assert_eq!(procs[0].time.as_deref(), Some("00:00:01"));
        assert_eq!(procs[0].command, "tmux new-session");
        assert_eq!(procs[1].command, "node /usr/bin/claude");
    }

    #[test]
    fn git_log_parses_us_delimited_commits() {
        let raw = "abc123\u{1f}Ada\u{1f}2 hours ago\u{1f}feat: add the thing\n\
                   def456\u{1f}Grace\u{1f}3 days ago\u{1f}fix: spaces, commas: kept\n";
        let commits = parse_git_log(raw);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "abc123");
        assert_eq!(commits[0].author, "Ada");
        assert_eq!(commits[0].relative, "2 hours ago");
        assert_eq!(commits[0].subject, "feat: add the thing");
        // A subject with its own separators survives intact.
        assert_eq!(commits[1].subject, "fix: spaces, commas: kept");
    }

    #[test]
    fn git_log_skips_non_commit_lines() {
        // fatal error (non-repo) and a blank line produce no rows.
        let raw = "fatal: not a git repository\n\n";
        assert!(parse_git_log(raw).is_empty());
    }

    #[test]
    fn top_falls_back_to_last_column_for_command() {
        // A layout with no CMD/COMMAND title still recovers the command from the
        // final column, and a column-less TIME comes back as None.
        let titles: Vec<String> = ["PID", "USER"].iter().map(|s| s.to_string()).collect();
        let rows = vec![vec!["7".to_string(), "app".to_string()]];
        let procs = parse_top(&titles, &rows);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].pid, "7");
        assert_eq!(procs[0].command, "app");
        assert!(procs[0].time.is_none());
    }

    #[test]
    fn find_parses_type_size_name() {
        // `%y\t%s\t%f` rows → typed entries; a malformed line is skipped, and a
        // name with spaces survives (splitn(3) keeps the remainder intact).
        let raw = "d\t4096\tsrc\nf\t128\tREADME.md\nf\t0\tmy notes.txt\nbogus line\n";
        let entries = parse_find(raw);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].kind, "dir");
        assert_eq!(entries[0].name, "src");
        assert_eq!(entries[1].kind, "file");
        assert_eq!(entries[1].size, 128);
        assert_eq!(entries[2].name, "my notes.txt");
    }

    #[test]
    fn workspace_path_confines_to_workspace() {
        assert_eq!(workspace_path("").unwrap(), "/workspace");
        assert_eq!(workspace_path("/workspace").unwrap(), "/workspace");
        assert_eq!(workspace_path("/workspace/src").unwrap(), "/workspace/src");
        // Traversal and escapes are rejected.
        assert!(workspace_path("/workspace/../etc/passwd").is_err());
        assert!(workspace_path("/etc/passwd").is_err());
        assert!(workspace_path("/workspaceevil").is_err());
    }

    #[test]
    fn claude_usage_sums_real_tokens_and_counts_sessions_turns() {
        // Two sessions; non-assistant lines contribute only their sessionId.
        let raw = concat!(
            r#"{"type":"user","sessionId":"s1","message":{"content":"hi"}}"#,
            "\n",
            r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-05-22T12:00:00.000Z","message":{"model":"claude-opus-4-7","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":1000,"cache_creation_input_tokens":50}}}"#,
            "\n",
            r#"{"type":"assistant","sessionId":"s2","timestamp":"2026-05-23T09:00:00.000Z","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":20}}}"#,
            "\n",
            "not json at all\n",
            "\n",
        );
        let u = parse_claude_usage(raw);
        assert_eq!(u.sessions, 2);
        assert_eq!(u.turns, 2); // two assistant lines
        assert_eq!(u.totals.input, 110);
        assert_eq!(u.totals.output, 220);
        assert_eq!(u.totals.cache_read, 1000);
        assert_eq!(u.totals.cache_creation, 50);
        // Opus: 100*15 + 200*75 + 50*18.75 + 1000*1.50 per Mtok.
        let opus = (100.0 * 15.0 + 200.0 * 75.0 + 50.0 * 18.75 + 1000.0 * 1.50) / 1_000_000.0;
        let sonnet = (10.0 * 3.0 + 20.0 * 15.0) / 1_000_000.0;
        assert!((u.est_cost_usd - (opus + sonnet)).abs() < 1e-12);
        assert_eq!(u.by_day.len(), 2); // grouped by UTC date
        assert_eq!(u.by_model.len(), 2);
        assert_eq!(u.unpriced_tokens, 0);
        assert_eq!(u.rates_as_of, "2026-05");
    }

    #[test]
    fn claude_usage_flags_unpriced_models_without_fabricating_cost() {
        let raw = concat!(
            r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-05-22T12:00:00.000Z","message":{"model":"some-future-model-x","usage":{"input_tokens":40,"output_tokens":60}}}"#,
            "\n",
        );
        let u = parse_claude_usage(raw);
        assert_eq!(u.turns, 1);
        assert_eq!(u.totals.input, 40);
        assert_eq!(u.est_cost_usd, 0.0); // no rate → no estimate, never guessed
        assert_eq!(u.unpriced_tokens, 100); // input + output
        assert_eq!(u.by_model.len(), 1);
        assert!(!u.by_model[0].priced);
    }

    #[test]
    fn claude_usage_dedupes_replayed_assistant_lines() {
        // The same response (message.id + requestId) replayed into a resumed
        // session's transcript must be counted once, not twice.
        let one = r#"{"type":"assistant","sessionId":"s1","requestId":"req-1","timestamp":"2026-05-22T12:00:00.000Z","message":{"id":"msg_abc","model":"claude-opus-4-7","usage":{"input_tokens":100,"output_tokens":200}}}"#;
        // s2 resumes s1 and replays msg_abc, then adds a genuinely new response.
        let two = r#"{"type":"assistant","sessionId":"s2","requestId":"req-2","timestamp":"2026-05-23T12:00:00.000Z","message":{"id":"msg_def","model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":20}}}"#;
        let raw = format!("{one}\n{one}\n{two}\n");
        let u = parse_claude_usage(&raw);
        // Two distinct sessions (s1, s2) even though one line was a replay.
        assert_eq!(u.sessions, 2);
        // Replayed msg_abc counted once → 2 unique turns, not 3.
        assert_eq!(u.turns, 2);
        assert_eq!(u.totals.input, 110);
        assert_eq!(u.totals.output, 220);
        // Only the genuinely-new line lands on the second day.
        assert_eq!(u.by_day.len(), 2);
    }

    #[test]
    fn claude_usage_empty_input_is_all_zero_not_error() {
        let u = parse_claude_usage("");
        assert_eq!(u.sessions, 0);
        assert_eq!(u.turns, 0);
        assert_eq!(u.totals, super::TokenTotals::default());
        assert_eq!(u.est_cost_usd, 0.0);
        assert!(u.by_model.is_empty());
        assert!(u.by_day.is_empty());
        // Rate table is always surfaced for UI transparency.
        assert_eq!(u.rates.len(), 3);
    }

    #[test]
    fn claude_sessions_groups_by_id_newest_first_with_real_metadata() {
        // s-old: a titled session on a branch with two distinct user turns.
        let old = [
            r#"{"type":"user","sessionId":"s-old","uuid":"u1","timestamp":"2026-05-20T10:00:00.000Z","gitBranch":"feat/login","version":"2.1.145","message":{"role":"user","content":"first prompt"}}"#,
            r#"{"type":"assistant","sessionId":"s-old","timestamp":"2026-05-20T10:00:05.000Z","message":{"model":"claude-opus-4-7"}}"#,
            r#"{"type":"user","sessionId":"s-old","uuid":"u2","timestamp":"2026-05-20T10:01:00.000Z","gitBranch":"feat/login","message":{"role":"user","content":"second prompt"}}"#,
            r#"{"type":"ai-title","sessionId":"s-old","aiTitle":"Wire up login"}"#,
        ]
        .join("\n");
        // s-new: more recent, detached HEAD (→ no branch), title falls back to
        // the first user prompt, and one user turn is replayed (same uuid).
        let new = [
            r#"{"type":"user","sessionId":"s-new","uuid":"v1","timestamp":"2026-05-22T09:00:00.000Z","gitBranch":"HEAD","message":{"role":"user","content":"  Fix the flaky test  "}}"#,
            r#"{"type":"user","sessionId":"s-new","uuid":"v1","timestamp":"2026-05-22T09:00:00.000Z","gitBranch":"HEAD","message":{"role":"user","content":"Fix the flaky test"}}"#,
        ]
        .join("\n");
        let raw = format!("{old}\n{new}\n");
        let sessions = parse_claude_sessions(&raw);

        assert_eq!(sessions.len(), 2);
        // Newest activity first.
        assert_eq!(sessions[0].id, "s-new");
        assert_eq!(sessions[1].id, "s-old");

        // s-new: no ai-title → first prompt (trimmed) is the title; replayed
        // turn deduped by uuid → 1; detached HEAD → no branch; no assistant line
        // → no model.
        assert_eq!(sessions[0].title, "Fix the flaky test");
        assert_eq!(sessions[0].turns, 1);
        assert_eq!(sessions[0].branch, None);
        assert_eq!(sessions[0].model, None);

        // s-old: real ai-title wins over the prompt; two distinct turns; branch
        // and model recorded; window spans first→last timestamp.
        assert_eq!(sessions[1].title, "Wire up login");
        assert_eq!(sessions[1].turns, 2);
        assert_eq!(sessions[1].branch.as_deref(), Some("feat/login"));
        assert_eq!(sessions[1].model.as_deref(), Some("claude-opus-4-7"));
        assert_eq!(sessions[1].version.as_deref(), Some("2.1.145"));
        assert_eq!(sessions[1].started, "2026-05-20T10:00:00.000Z");
        assert_eq!(sessions[1].last_active, "2026-05-20T10:01:00.000Z");
    }

    #[test]
    fn claude_sessions_empty_input_is_empty_list_not_error() {
        assert!(parse_claude_sessions("").is_empty());
    }

    #[test]
    fn claude_sessions_skips_command_wrapper_for_title() {
        assert!(is_synthetic_prompt("<local-command-caveat>Caveat: …"));
        assert!(is_synthetic_prompt("<command-name>/clear"));
        assert!(!is_synthetic_prompt("fix the parser bug"));
        // First user line is Claude's own caveat wrapper; the title should fall
        // through to the next genuinely-typed prompt, not the boilerplate.
        let raw = [
            r#"{"type":"user","sessionId":"s","uuid":"a","timestamp":"2026-05-22T09:00:00.000Z","message":{"role":"user","content":"<local-command-caveat>Caveat: messages below were generated…"}}"#,
            r#"{"type":"user","sessionId":"s","uuid":"b","timestamp":"2026-05-22T09:00:01.000Z","message":{"role":"user","content":"refactor the auth middleware"}}"#,
        ]
        .join("\n");
        let sessions = parse_claude_sessions(&raw);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "refactor the auth middleware");
        assert_eq!(sessions[0].turns, 2);
    }

    #[test]
    fn clip_title_collapses_and_clips() {
        // Multi-line + extra whitespace → single normalized line.
        assert_eq!(clip_title("  hello\nworld  "), "hello");
        assert_eq!(clip_title("a   b\t c"), "a b c");
        // Over the cap gets an ellipsis.
        let long = "x".repeat(200);
        let clipped = clip_title(&long);
        assert!(clipped.ends_with('…'));
        assert_eq!(clipped.chars().count(), 81); // 80 + ellipsis
    }
}
