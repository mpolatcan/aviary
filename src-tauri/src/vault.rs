//! OS-keychain credential vault for built-in agent accounts + GitHub.
//!
//! Secrets are stored in the platform keychain (macOS Keychain, Windows
//! Credential Manager, Linux Secret Service) via the `keyring` crate. CodeHub
//! is the ONLY reader/writer — no password prompt, the OS handles access
//! control. Entries are namespaced by the bundle identifier so they're
//! discoverable in Keychain Access and can't collide with other apps.
//!
//! **Security contract**: this module is the ONLY code that touches secrets.
//! - `tracing` calls log the profile id, NEVER the secret value.
//! - The `Debug` impl on `Vault` redacts internals.
//! - No public method returns a secret to a Tauri command / IPC boundary.
//!   `read()` is `pub(crate)` — launch paths use it just-in-time to inject
//!   the selected account into a pane.

use std::collections::HashMap;
use std::time::{Duration, Instant};

const SERVICE: &str = "com.mutlupolatcan.codehub";

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("keyring: {0}")]
    Keyring(String),
    #[error("oauth: {0}")]
    OAuth(String),
}

impl From<keyring::Error> for VaultError {
    fn from(e: keyring::Error) -> Self {
        VaultError::Keyring(e.to_string())
    }
}

pub struct Vault {
    service: String,
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault")
            .field("service", &self.service)
            .finish()
    }
}

impl Default for Vault {
    fn default() -> Self {
        Self::new()
    }
}

impl Vault {
    pub fn new() -> Self {
        Self {
            service: SERVICE.to_string(),
        }
    }

    fn entry(&self, profile_id: &str) -> Result<keyring::Entry, VaultError> {
        let user = format!("vault/{profile_id}");
        keyring::Entry::new(&self.service, &user).map_err(VaultError::from)
    }

    pub fn store(&self, profile_id: &str, secret: &str) -> Result<(), VaultError> {
        tracing::debug!("vault: storing secret for profile {profile_id}");
        self.entry(profile_id)?.set_password(secret)?;
        Ok(())
    }

    /// Read a secret from the vault. `pub(crate)` — only lifecycle injection
    /// calls this. Never exposed over IPC.
    pub(crate) fn read(&self, profile_id: &str) -> Result<Option<String>, VaultError> {
        match self.entry(profile_id)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(VaultError::from(e)),
        }
    }

    pub fn delete(&self, profile_id: &str) -> Result<(), VaultError> {
        tracing::debug!("vault: deleting secret for profile {profile_id}");
        match self.entry(profile_id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(VaultError::from(e)),
        }
    }

    /// Metadata-only presence check. On macOS this intentionally uses the
    /// `security` CLI without `-w`, so listing accounts can tell missing vs
    /// present without asking Keychain to reveal the secret value.
    pub fn exists(&self, profile_id: &str) -> bool {
        #[cfg(target_os = "macos")]
        {
            let user = format!("vault/{profile_id}");
            std::process::Command::new("security")
                .args(["find-generic-password", "-s", &self.service, "-a", &user])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }

        #[cfg(not(target_os = "macos"))]
        {
            self.entry(profile_id)
                .and_then(|e| e.get_password().map_err(VaultError::from))
                .is_ok()
        }
    }
}

// ── GitHub Device Flow ──────────────────────────────────────────────────────

/// Request a device code from GitHub. Returns (device_code, user_code,
/// verification_uri, interval) or an error.
pub async fn github_request_device_code(
    client_id: &str,
) -> Result<(String, String, String, u64), VaultError> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id), ("scope", "repo,read:user")])
        .send()
        .await
        .map_err(|e| VaultError::OAuth(e.to_string()))?;

    let body: HashMap<String, serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| VaultError::OAuth(e.to_string()))?;

    let device_code = body
        .get("device_code")
        .and_then(|v| v.as_str())
        .ok_or_else(|| VaultError::OAuth("missing device_code".into()))?
        .to_string();
    let user_code = body
        .get("user_code")
        .and_then(|v| v.as_str())
        .ok_or_else(|| VaultError::OAuth("missing user_code".into()))?
        .to_string();
    let verification_uri = body
        .get("verification_uri")
        .and_then(|v| v.as_str())
        .ok_or_else(|| VaultError::OAuth("missing verification_uri".into()))?
        .to_string();
    let interval = body.get("interval").and_then(|v| v.as_u64()).unwrap_or(5);

    Ok((device_code, user_code, verification_uri, interval))
}

/// Poll GitHub for the device flow token. Returns the access token on success.
pub async fn github_poll_token(
    client_id: &str,
    device_code: &str,
    interval: u64,
    deadline: Instant,
) -> Result<String, VaultError> {
    let client = reqwest::Client::new();
    let mut poll_interval = Duration::from_secs(interval);

    loop {
        if Instant::now() >= deadline {
            return Err(VaultError::OAuth("device flow timed out".into()));
        }
        tokio::time::sleep(poll_interval).await;

        let resp = client
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", client_id),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(|e| VaultError::OAuth(e.to_string()))?;

        let body: HashMap<String, serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| VaultError::OAuth(e.to_string()))?;

        if let Some(token) = body.get("access_token").and_then(|v| v.as_str()) {
            return Ok(token.to_string());
        }

        let error = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        match error {
            "authorization_pending" => continue,
            "slow_down" => {
                poll_interval += Duration::from_secs(5);
                continue;
            },
            "expired_token" => {
                return Err(VaultError::OAuth("device code expired".into()));
            },
            "access_denied" => {
                return Err(VaultError::OAuth("user denied access".into()));
            },
            _ => {
                return Err(VaultError::OAuth(format!("github oauth error: {error}")));
            },
        }
    }
}
