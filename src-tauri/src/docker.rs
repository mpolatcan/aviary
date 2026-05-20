use bollard::container::ListContainersOptions;
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
                    env: Some(vec!["TMUX_TMPDIR=/tmp/aviary".into()]),
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

    pub async fn create_tmux_session(&self, name: &str, cli: Cli) -> Result<(), DockerError> {
        let bin = cli.binary();
        self.exec_capture(vec!["tmux", "new-session", "-d", "-s", name, bin])
            .await?;
        Ok(())
    }

    pub async fn kill_tmux_session(&self, name: &str) -> Result<(), DockerError> {
        self.exec_capture(vec!["tmux", "kill-session", "-t", name])
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
                        "TMUX_TMPDIR=/tmp/aviary".into(),
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
