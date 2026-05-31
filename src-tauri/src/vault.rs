//! Encrypted-file credential vault for built-in agent accounts + GitHub.
//!
//! Secrets are stored in an XChaCha20-Poly1305-encrypted file under the app
//! data dir (`vault.bin`), with the 32-byte key in a sibling `vault.key` (both
//! mode 0600 on Unix). This replaces the OS keychain: an unsigned / ad-hoc
//! open-source build has no stable code signature, so the macOS Keychain ACL
//! never matches the binary and re-prompts on every launch. A local key file
//! removes the prompt and is cross-platform.
//!
//! **Threat model — be honest:** the key sits next to the ciphertext, so a
//! local attacker who can read the user's files gets both. This is obfuscation
//! at rest, the SAME posture as the agent CLIs themselves (Claude/Codex keep
//! their credentials as plaintext 0600 files). It does NOT defend against local
//! malware. For real at-rest protection, layer an optional user passphrase
//! (derive the key, never store it) — a deliberate follow-up, off by default.
//!
//! **Security contract** (unchanged): this module is the ONLY code that touches
//! secrets.
//! - `tracing` calls log the profile id, NEVER the secret value.
//! - The `Debug` impl on `Vault` redacts internals.
//! - No public method returns a secret to a Tauri command / IPC boundary.
//!   `read()` is `pub(crate)` — launch paths use it just-in-time to inject the
//!   selected account into a pane.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chacha20poly1305::aead::Aead;
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault: {0}")]
    Store(String),
    #[error("oauth: {0}")]
    OAuth(String),
}

impl From<std::io::Error> for VaultError {
    fn from(e: std::io::Error) -> Self {
        VaultError::Store(e.to_string())
    }
}

/// Encrypted-file credential vault. Holds the decrypted map in memory (guarded
/// by a mutex) and re-encrypts the whole file on every mutation. Constructed
/// once and shared via `Arc` — CodeHub is the only process touching the files.
pub struct Vault {
    bin_path: PathBuf,
    key: [u8; KEY_LEN],
    cache: Mutex<HashMap<String, String>>,
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault")
            .field("bin_path", &self.bin_path)
            .field("entries", &self.cache.lock().map(|m| m.len()).unwrap_or(0))
            .finish()
    }
}

impl Vault {
    /// Open (or initialize) the vault in `dir`. Best-effort: any I/O or decrypt
    /// failure logs and yields an EMPTY in-memory vault rather than panicking,
    /// so a missing/corrupt file degrades to "no stored accounts" (re-login)
    /// instead of crashing app startup — mirroring the keychain backend's
    /// forgiving `NoEntry` behavior.
    pub fn new(dir: PathBuf) -> Self {
        let bin_path = dir.join("vault.bin");
        let key_path = dir.join("vault.key");
        let key = load_or_init_key(&dir, &key_path).unwrap_or_else(|e| {
            tracing::error!("vault: key init failed ({e}); secrets will not persist this run");
            [0u8; KEY_LEN]
        });
        let cache = load_cache(&bin_path, &key).unwrap_or_else(|e| {
            tracing::error!("vault: load failed ({e}); starting empty");
            HashMap::new()
        });
        Self {
            bin_path,
            key,
            cache: Mutex::new(cache),
        }
    }

    pub fn store(&self, profile_id: &str, secret: &str) -> Result<(), VaultError> {
        tracing::debug!("vault: storing secret for profile {profile_id}");
        let mut map = self.cache.lock().map_err(lock_err)?;
        map.insert(profile_id.to_string(), secret.to_string());
        persist(&self.bin_path, &self.key, &map)
    }

    /// Read a secret from the vault. `pub(crate)` — only lifecycle injection
    /// calls this. Never exposed over IPC.
    pub(crate) fn read(&self, profile_id: &str) -> Result<Option<String>, VaultError> {
        let map = self.cache.lock().map_err(lock_err)?;
        Ok(map.get(profile_id).cloned())
    }

    pub fn delete(&self, profile_id: &str) -> Result<(), VaultError> {
        tracing::debug!("vault: deleting secret for profile {profile_id}");
        let mut map = self.cache.lock().map_err(lock_err)?;
        if map.remove(profile_id).is_none() {
            return Ok(());
        }
        persist(&self.bin_path, &self.key, &map)
    }

    /// Metadata-only presence check — reads the in-memory index, reveals no
    /// secret and triggers no prompt. Used to list which accounts are stored.
    pub fn exists(&self, profile_id: &str) -> bool {
        self.cache
            .lock()
            .map(|m| m.contains_key(profile_id))
            .unwrap_or(false)
    }
}

fn lock_err<T>(_: std::sync::PoisonError<T>) -> VaultError {
    VaultError::Store("vault lock poisoned".into())
}

/// Read the 32-byte key, or generate + persist one on first run. A wrong-length
/// key file is regenerated (any prior ciphertext becomes unreadable → re-login).
fn load_or_init_key(dir: &Path, key_path: &Path) -> Result<[u8; KEY_LEN], VaultError> {
    if let Ok(bytes) = std::fs::read(key_path) {
        if bytes.len() == KEY_LEN {
            let mut k = [0u8; KEY_LEN];
            k.copy_from_slice(&bytes);
            return Ok(k);
        }
        tracing::warn!("vault: key file wrong length; regenerating (prior secrets unreadable)");
    }
    std::fs::create_dir_all(dir)?;
    let mut k = [0u8; KEY_LEN];
    fill_random(&mut k)?;
    write_private(key_path, &k)?;
    Ok(k)
}

/// Decrypt `vault.bin` into the profile→secret map. A missing file is an empty
/// vault; a present-but-undecryptable file is an error (caller starts empty).
fn load_cache(bin_path: &Path, key: &[u8; KEY_LEN]) -> Result<HashMap<String, String>, VaultError> {
    let blob = match std::fs::read(bin_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(e.into()),
    };
    if blob.len() < NONCE_LEN {
        return Err(VaultError::Store("vault file truncated".into()));
    }
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let pt = cipher
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| VaultError::Store("decrypt failed (wrong key or corrupt file)".into()))?;
    serde_json::from_slice(&pt).map_err(|e| VaultError::Store(e.to_string()))
}

/// Encrypt the whole map under a fresh random nonce and write it atomically.
/// On-disk layout: `nonce (24 bytes) || XChaCha20-Poly1305 ciphertext`.
fn persist(
    bin_path: &Path,
    key: &[u8; KEY_LEN],
    map: &HashMap<String, String>,
) -> Result<(), VaultError> {
    let pt = serde_json::to_vec(map).map_err(|e| VaultError::Store(e.to_string()))?;
    let mut nonce = [0u8; NONCE_LEN];
    fill_random(&mut nonce)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), pt.as_slice())
        .map_err(|_| VaultError::Store("encrypt failed".into()))?;
    let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    write_private(bin_path, &blob)
}

/// Write via a temp file + rename so a crash mid-write can't truncate the live
/// file, and set 0600 before the rename so the bytes are never world-readable.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), VaultError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    set_private_perms(&tmp)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(unix)]
fn set_private_perms(path: &Path) -> Result<(), VaultError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_perms(_path: &Path) -> Result<(), VaultError> {
    Ok(())
}

fn fill_random(buf: &mut [u8]) -> Result<(), VaultError> {
    getrandom::getrandom(buf).map_err(|e| VaultError::Store(format!("rng: {e}")))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("codehub-vault-test-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn roundtrip_persists_and_encrypts() {
        let dir = tmp("roundtrip");
        {
            let v = Vault::new(dir.clone());
            v.store("p1", "secret-one").unwrap();
            v.store("p2", "secret-two").unwrap();
            assert_eq!(v.read("p1").unwrap().as_deref(), Some("secret-one"));
            assert!(v.exists("p2"));
            assert!(!v.exists("nope"));
        }
        // Reopen with the persisted key file: decrypts what the prior run wrote.
        let v2 = Vault::new(dir.clone());
        assert_eq!(v2.read("p2").unwrap().as_deref(), Some("secret-two"));
        // The ciphertext on disk must not leak the plaintext secret.
        let blob = std::fs::read(dir.join("vault.bin")).unwrap();
        let needle = b"secret-one";
        assert!(!blob.windows(needle.len()).any(|w| w == needle));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_is_idempotent() {
        let dir = tmp("delete");
        let v = Vault::new(dir.clone());
        v.store("p", "x").unwrap();
        v.delete("p").unwrap();
        assert!(!v.exists("p"));
        assert_eq!(v.read("p").unwrap(), None);
        v.delete("p").unwrap(); // deleting a missing entry is Ok
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_key_degrades_to_empty() {
        let dir = tmp("wrongkey");
        {
            let v = Vault::new(dir.clone());
            v.store("p", "secret").unwrap();
        }
        // Swap the key for one that can't decrypt the existing file → start empty,
        // never panic (mirrors keychain NoEntry forgiveness).
        std::fs::write(dir.join("vault.key"), [7u8; KEY_LEN]).unwrap();
        let v = Vault::new(dir.clone());
        assert!(!v.exists("p"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("perms");
        let v = Vault::new(dir.clone());
        v.store("p", "x").unwrap();
        for f in ["vault.key", "vault.bin"] {
            let mode = std::fs::metadata(dir.join(f)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{f} must be 0600");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
