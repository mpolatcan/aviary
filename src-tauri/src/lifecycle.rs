use crate::docker::DockerClient;
use bollard::container::{
    Config, CreateContainerOptions, ListContainersOptions, RemoveContainerOptions,
    StartContainerOptions, StopContainerOptions,
};
use bollard::image::CreateImageOptions;
use bollard::models::{HostConfig, Mount, MountTypeEnum, PortBinding};
use bollard::Docker;
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LifecycleError {
    #[error("bollard: {0}")]
    Bollard(#[from] bollard::errors::Error),
    #[error("docker daemon unreachable — is Docker Desktop running?")]
    DaemonDown,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContainerState {
    Missing,
    Stopped,
    Starting,
    Running,
    Unreachable,
}

#[derive(Debug, Serialize, Clone)]
pub struct ContainerStatus {
    pub state: ContainerState,
    pub id: Option<String>,
    pub image: String,
    pub name: String,
}

// Host auth env vars each CLI can authenticate from, in priority order. Keys are
// read from the host environment and forwarded into the runtime container —
// CodeHub never stores them (see BACKEND_PLAN.md). The empty-state / settings
// "key status" reports presence only and must NEVER surface the value.
const CLAUDE_VARS: &[&str] = &["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
const CODEX_VARS: &[&str] = &["OPENAI_API_KEY"];
const ANTIGRAVITY_VARS: &[&str] = &["GOOGLE_API_KEY", "GEMINI_API_KEY"];

fn all_auth_vars() -> impl Iterator<Item = &'static str> {
    CLAUDE_VARS
        .iter()
        .chain(CODEX_VARS)
        .chain(ANTIGRAVITY_VARS)
        .copied()
}

/// `KEY=value` pairs for every known auth var present on the host, forwarded
/// verbatim into the container so each CLI reads the name it expects. Values are
/// never logged.
pub fn auth_env() -> Vec<String> {
    all_auth_vars()
        .filter_map(|v| std::env::var(v).ok().map(|val| format!("{v}={val}")))
        .collect()
}

/// Presence-only auth status for one CLI. Carries which env var satisfied it by
/// NAME only — never the value. Serialized to the frontend as-is.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub present: bool,
    /// Always "env": keys come from the host environment, not a keychain.
    pub source: &'static str,
    /// Name of the env var that satisfied the check, if any. Name only.
    pub var_name: Option<String>,
}

fn key_status_for(vars: &[&str]) -> KeyStatus {
    for v in vars {
        // Presence probe only — `is_ok()` never binds the secret value.
        if std::env::var(v).is_ok() {
            return KeyStatus {
                present: true,
                source: "env",
                var_name: Some((*v).to_string()),
            };
        }
    }
    KeyStatus {
        present: false,
        source: "env",
        var_name: None,
    }
}

/// Per-CLI presence of a host auth key. Reports booleans + var names only.
pub fn agent_key_status() -> HashMap<String, KeyStatus> {
    HashMap::from([
        ("claude".to_string(), key_status_for(CLAUDE_VARS)),
        ("codex".to_string(), key_status_for(CODEX_VARS)),
        ("antigravity".to_string(), key_status_for(ANTIGRAVITY_VARS)),
    ])
}

/// Docker daemon reachability + version, for the empty-state pill and Settings.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DockerInfo {
    pub reachable: bool,
    pub version: Option<String>,
    pub api_version: Option<String>,
}

pub struct Lifecycle {
    pub docker: Docker,
    pub container_name: String,
    pub image: String,
    pub config_dir: PathBuf,
    pub workspace_dir: PathBuf,
}

impl Lifecycle {
    pub fn new(
        container_name: String,
        image: String,
        config_dir: PathBuf,
        workspace_dir: PathBuf,
    ) -> Result<Self, LifecycleError> {
        let docker = Docker::connect_with_local_defaults()?;
        Ok(Self {
            docker,
            container_name,
            image,
            config_dir,
            workspace_dir,
        })
    }

    /// Single source of truth: returns the current state of the runtime container.
    pub async fn status(&self) -> ContainerStatus {
        let mut status = ContainerStatus {
            state: ContainerState::Missing,
            id: None,
            image: self.image.clone(),
            name: self.container_name.clone(),
        };

        // probe daemon
        if self.docker.version().await.is_err() {
            status.state = ContainerState::Unreachable;
            return status;
        }

        let mut filters = HashMap::new();
        filters.insert("name".to_string(), vec![self.container_name.clone()]);
        let containers = self
            .docker
            .list_containers(Some(ListContainersOptions::<String> {
                all: true,
                filters,
                ..Default::default()
            }))
            .await
            .unwrap_or_default();

        if let Some(c) = containers.first() {
            status.id = c.id.clone();
            status.state = match c.state.as_deref() {
                Some("running") => ContainerState::Running,
                Some("created") | Some("exited") | Some("paused") | Some("dead") => {
                    ContainerState::Stopped
                },
                Some("restarting") => ContainerState::Starting,
                _ => ContainerState::Stopped,
            };
        }

        status
    }

    pub async fn ensure_image(&self) -> Result<(), LifecycleError> {
        // already present?
        if self.docker.inspect_image(&self.image).await.is_ok() {
            return Ok(());
        }

        let mut pull = self.docker.create_image(
            Some(CreateImageOptions {
                from_image: self.image.clone(),
                ..Default::default()
            }),
            None,
            None,
        );

        while let Some(info) = pull.next().await {
            let info = info?;
            tracing::debug!(?info, "image pull progress");
        }
        Ok(())
    }

    pub async fn ensure_container(&self) -> Result<String, LifecycleError> {
        let status = self.status().await;

        if let Some(id) = status.id {
            if status.state == ContainerState::Running {
                return Ok(id);
            }
            // exists but stopped — start it
            self.docker
                .start_container(&id, None::<StartContainerOptions<String>>)
                .await?;
            return Ok(id);
        }

        // create new
        std::fs::create_dir_all(&self.config_dir)?;
        std::fs::create_dir_all(&self.workspace_dir)?;

        let mounts = vec![
            Mount {
                target: Some("/config".into()),
                source: Some(self.config_dir.to_string_lossy().to_string()),
                typ: Some(MountTypeEnum::BIND),
                ..Default::default()
            },
            Mount {
                target: Some("/workspace".into()),
                source: Some(self.workspace_dir.to_string_lossy().to_string()),
                typ: Some(MountTypeEnum::BIND),
                ..Default::default()
            },
        ];

        let host_config = HostConfig {
            mounts: Some(mounts),
            network_mode: Some(host_network_mode()),
            restart_policy: Some(bollard::models::RestartPolicy {
                name: Some(bollard::models::RestartPolicyNameEnum::UNLESS_STOPPED),
                maximum_retry_count: None,
            }),
            // Empty map keeps Docker happy when network_mode = host
            port_bindings: Some(HashMap::<String, Option<Vec<PortBinding>>>::new()),
            ..Default::default()
        };

        // Forward every host auth key the CLIs may need (Claude / Codex /
        // Antigravity) — not just Claude's. Values never touch the logs.
        let mut env = vec!["TMUX_TMPDIR=/tmp/codehub".to_string()];
        env.extend(auth_env());

        let config = Config {
            image: Some(self.image.clone()),
            env: Some(env),
            host_config: Some(host_config),
            working_dir: Some("/workspace".into()),
            tty: Some(true),
            open_stdin: Some(true),
            ..Default::default()
        };

        let created = self
            .docker
            .create_container(
                Some(CreateContainerOptions {
                    name: self.container_name.clone(),
                    platform: None,
                }),
                config,
            )
            .await?;

        self.docker
            .start_container(&created.id, None::<StartContainerOptions<String>>)
            .await?;

        Ok(created.id)
    }

    pub async fn ensure_runtime(&self) -> Result<ContainerStatus, LifecycleError> {
        self.ensure_image().await?;
        self.ensure_container().await?;
        Ok(self.status().await)
    }

    pub async fn start(&self) -> Result<(), LifecycleError> {
        self.ensure_container().await?;
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), LifecycleError> {
        let status = self.status().await;
        if let Some(id) = status.id {
            self.docker
                .stop_container(&id, Some(StopContainerOptions { t: 10 }))
                .await?;
        }
        Ok(())
    }

    pub async fn restart(&self) -> Result<(), LifecycleError> {
        self.stop().await.ok();
        self.start().await
    }

    pub async fn remove(&self) -> Result<(), LifecycleError> {
        let status = self.status().await;
        if let Some(id) = status.id {
            self.docker
                .remove_container(
                    &id,
                    Some(RemoveContainerOptions {
                        force: true,
                        v: false,
                        link: false,
                    }),
                )
                .await?;
        }
        Ok(())
    }

    /// Daemon reachability + version. Best-effort: an unreachable daemon yields
    /// `reachable: false` with empty version fields rather than an error.
    pub async fn docker_info(&self) -> DockerInfo {
        match self.docker.version().await {
            Ok(v) => DockerInfo {
                reachable: true,
                version: v.version,
                api_version: v.api_version,
            },
            Err(_) => DockerInfo {
                reachable: false,
                version: None,
                api_version: None,
            },
        }
    }

    pub fn docker_client(&self) -> DockerClient {
        DockerClient::from_docker(self.docker.clone(), self.container_name.clone())
    }
}

fn host_network_mode() -> String {
    // macOS Docker Desktop supports host network behind a feature flag.
    // Default to `bridge` to maximize compatibility; users can override.
    std::env::var("CODEHUB_NETWORK_MODE")
        .or_else(|_| std::env::var("AVIARY_NETWORK_MODE"))
        .unwrap_or_else(|_| "bridge".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The single most important property of `agent_key_status`: it must report
    // presence only and never let a secret value reach the serialized payload.
    #[test]
    fn key_status_reports_presence_without_leaking_value() {
        let secret = "sk-codehub-test-DO-NOT-LEAK-9f3a2b";
        // SAFETY: process-global env mutation; no other test reads this var.
        unsafe {
            std::env::set_var("OPENAI_API_KEY", secret);
        }

        let status = agent_key_status();
        let codex = status.get("codex").expect("codex entry present");
        assert!(codex.present, "codex key should read as present");
        assert_eq!(codex.var_name.as_deref(), Some("OPENAI_API_KEY"));
        assert_eq!(codex.source, "env");

        let json = serde_json::to_string(&status).expect("serializes");
        assert!(
            !json.contains(secret),
            "secret value leaked into serialized key status: {json}"
        );

        unsafe {
            std::env::remove_var("OPENAI_API_KEY");
        }
    }

    #[test]
    fn auth_env_forwards_present_vars_only() {
        unsafe {
            std::env::set_var("GOOGLE_API_KEY", "g-test-token");
            std::env::remove_var("GEMINI_API_KEY");
        }
        let env = auth_env();
        assert!(env.iter().any(|e| e.starts_with("GOOGLE_API_KEY=")));
        assert!(!env.iter().any(|e| e.starts_with("GEMINI_API_KEY=")));
        unsafe {
            std::env::remove_var("GOOGLE_API_KEY");
        }
    }
}
