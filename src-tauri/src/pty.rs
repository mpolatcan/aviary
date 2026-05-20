use crate::docker::{DockerClient, DockerError, SessionInfo as _SessionInfo};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

pub use crate::docker::SessionInfo;

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("docker: {0}")]
    Docker(#[from] DockerError),
    #[error("pane not found: {0}")]
    NotFound(String),
    #[error("send: {0}")]
    Send(String),
}

pub(crate) enum InputMsg {
    Data(Vec<u8>),
    Shutdown,
}

pub struct Pane {
    pub session: String,
    pub exec_id: String,
    pub input_tx: mpsc::UnboundedSender<InputMsg>,
}

pub struct PtyRegistry {
    panes: Mutex<HashMap<String, Pane>>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self {
            panes: Mutex::new(HashMap::new()),
        }
    }

    pub async fn attach(
        &self,
        docker: &Arc<DockerClient>,
        session: &str,
        cols: u16,
        rows: u16,
        app: AppHandle,
    ) -> Result<String, PtyError> {
        // Caller is expected to call `create_session` first.
        let mut handles = docker.attach_exec(session, cols, rows).await?;
        let pane_id = Uuid::new_v4().to_string();
        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<InputMsg>();

        // Output pump: bollard stream -> tauri event
        let app_out = app.clone();
        let pane_id_out = pane_id.clone();
        tokio::spawn(async move {
            while let Some(chunk) = handles.output.next().await {
                match chunk {
                    Ok(log) => {
                        let bytes = match log {
                            bollard::container::LogOutput::StdOut { message }
                            | bollard::container::LogOutput::StdErr { message }
                            | bollard::container::LogOutput::Console { message } => message,
                            _ => continue,
                        };
                        let text = String::from_utf8_lossy(&bytes).to_string();
                        let _ = app_out.emit(&format!("pty://data/{}", pane_id_out), text);
                    },
                    Err(e) => {
                        tracing::warn!("output stream error: {e}");
                        break;
                    },
                }
            }
            let _ = app_out.emit::<i32>(&format!("pty://exit/{}", pane_id_out), 0);
        });

        // Input pump: channel -> bollard stdin
        let pane_id_in = pane_id.clone();
        tokio::spawn(async move {
            while let Some(msg) = input_rx.recv().await {
                match msg {
                    InputMsg::Data(buf) => {
                        if let Err(e) = handles.input.write_all(&buf).await {
                            tracing::warn!("input write failed for {}: {e}", pane_id_in);
                            break;
                        }
                        let _ = handles.input.flush().await;
                    },
                    InputMsg::Shutdown => {
                        let _ = handles.input.shutdown().await;
                        break;
                    },
                }
            }
        });

        let mut panes = self.panes.lock().await;
        panes.insert(
            pane_id.clone(),
            Pane {
                session: session.to_string(),
                exec_id: handles.exec_id,
                input_tx,
            },
        );

        Ok(pane_id)
    }

    pub async fn write(&self, pane_id: &str, data: &[u8]) -> Result<(), PtyError> {
        let panes = self.panes.lock().await;
        let pane = panes
            .get(pane_id)
            .ok_or_else(|| PtyError::NotFound(pane_id.into()))?;
        pane.input_tx
            .send(InputMsg::Data(data.to_vec()))
            .map_err(|e| PtyError::Send(e.to_string()))?;
        Ok(())
    }

    pub async fn resize(
        &self,
        docker: &Arc<DockerClient>,
        pane_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), PtyError> {
        let exec_id = {
            let panes = self.panes.lock().await;
            panes
                .get(pane_id)
                .ok_or_else(|| PtyError::NotFound(pane_id.into()))?
                .exec_id
                .clone()
        };
        docker.resize_exec(&exec_id, cols, rows).await?;
        Ok(())
    }

    pub async fn detach(&self, pane_id: &str) {
        let mut panes = self.panes.lock().await;
        if let Some(pane) = panes.remove(pane_id) {
            let _ = pane.input_tx.send(InputMsg::Shutdown);
        }
    }

    /// Drop every pane attached to `session`. Used when a tmux session is killed
    /// to guarantee bookkeeping cannot outlive the upstream session.
    pub async fn detach_by_session(&self, session: &str) {
        let mut panes = self.panes.lock().await;
        let ids: Vec<String> = panes
            .iter()
            .filter(|(_, p)| p.session == session)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(pane) = panes.remove(&id) {
                let _ = pane.input_tx.send(InputMsg::Shutdown);
            }
        }
    }
}

// Re-export to keep lib.rs simple
#[allow(dead_code)]
fn _ensure_session_info_export(_: _SessionInfo) {}
