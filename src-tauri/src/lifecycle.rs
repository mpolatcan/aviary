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

        let mut env = vec!["TMUX_TMPDIR=/tmp/codehub".to_string()];
        if let Ok(token) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
            env.push(format!("CLAUDE_CODE_OAUTH_TOKEN={}", token));
        }

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
