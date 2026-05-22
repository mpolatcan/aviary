use bollard::container::{ListContainersOptions, MemoryStatsStats, StatsOptions};
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
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionInfo {
    pub name: String,
    pub windows: u32,
    pub attached: bool,
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
                "#{session_name}|#{session_windows}|#{session_attached}",
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
    use super::is_version_like;

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
}
