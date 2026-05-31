//! Container-mediated agent login flows.
//!
//! Each agent CLI has its own interactive login. CodeHub creates a temporary
//! container, runs the login command as a visible tmux session (the user sees
//! the terminal and interacts with it), then reads the resulting credential
//! file from the container and stores it in the vault.

use crate::docker::DockerClient;
use crate::vault::Vault;
use std::sync::Arc;
use tauri::Emitter;

pub const CLAUDE_AUTH_BUNDLE_PREFIX: &str = "CODEHUB_CLAUDE_AUTH_TGZ_V1:";

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthProgress {
    pub profile_id: String,
    pub provider: String,
    pub stage: String,
    pub url: Option<String>,
    pub user_code: Option<String>,
    pub message: Option<String>,
}

fn emit_progress(app: &tauri::AppHandle, progress: &AuthProgress) {
    let _ = app.emit("codehub://auth-progress", progress);
}

/// Login command + credential file path per agent.
pub fn login_spec(provider: &str) -> Option<(Vec<&'static str>, &'static str)> {
    match provider {
        "claude" => Some((
            vec!["/root/.local/bin/claude", "auth", "login", "--claudeai"],
            "__claude_config_bundle__",
        )),
        "codex" => Some((
            // Codex writes auth under $CODEX_HOME (=/config/codex). /config is NOT
            // mounted, so this is container-local — we read it here, right after
            // login, and store it in the vault; the vault is what persists,
            // re-injected per launch by account_launch_script.
            vec!["codex", "login", "--device-auth"],
            "/config/codex/auth.json",
        )),
        "antigravity" => Some((
            vec!["agy", "auth", "login"],
            "/root/.config/agy/credentials.json",
        )),
        // gh's own device-flow OAuth (no CodeHub OAuth app to register). `--web`
        // prints the one-time code + device URL into the terminal for the user to
        // open. env -u clears any stray GH_TOKEN/GITHUB_TOKEN, which would make gh
        // refuse an interactive login. The "__gh_token__" marker tells
        // capture_credential to read the token back via `gh auth token`.
        "github" => Some((
            vec![
                "env",
                "-u",
                "GH_TOKEN",
                "-u",
                "GITHUB_TOKEN",
                "gh",
                "auth",
                "login",
                "--hostname",
                "github.com",
                "--git-protocol",
                "https",
                "--web",
            ],
            "__gh_token__",
        )),
        _ => None,
    }
}

pub fn login_capture_path(session_name: &str) -> String {
    format!(
        "/tmp/codehub/auth-{}.log",
        safe_session_fragment(session_name)
    )
}

pub fn claude_login_config_dir(session_name: &str) -> String {
    format!(
        "/tmp/codehub/claude-auth-{}",
        safe_session_fragment(session_name)
    )
}

pub fn claude_onboarding_patch_script(dir_var: &str) -> String {
    let dir_ref = format!("${dir_var}");
    let template = r#"f="__DIR_REF__/.claude.json"
if [ -f "$f" ] && command -v jq >/dev/null 2>&1; then
  tmp="$f.tmp.$$"
  jq '
    .hasCompletedOnboarding = true
    | .hasCompletedProjectOnboarding = true
    | .theme = (.theme // "dark")
    | .onboardingShown = true
    | .projects = (.projects // {})
    | .projects["/workspace"] = ((.projects["/workspace"] // {}) + {
        allowedTools: (.projects["/workspace"].allowedTools // []),
        mcpContextUris: (.projects["/workspace"].mcpContextUris // []),
        mcpServers: (.projects["/workspace"].mcpServers // {}),
        enabledMcpjsonServers: (.projects["/workspace"].enabledMcpjsonServers // []),
        disabledMcpjsonServers: (.projects["/workspace"].disabledMcpjsonServers // []),
        hasTrustDialogAccepted: true,
        projectOnboardingSeenCount: 1,
        hasClaudeMdExternalIncludesApproved: (.projects["/workspace"].hasClaudeMdExternalIncludesApproved // false),
        hasClaudeMdExternalIncludesWarningShown: (.projects["/workspace"].hasClaudeMdExternalIncludesWarningShown // false),
        hasUnseenTeamArtifacts: (.projects["/workspace"].hasUnseenTeamArtifacts // false)
      })
  ' "$f" > "$tmp" && mv "$tmp" "$f" || rm -f "$tmp"
fi
"#;
    template.replace("__DIR_REF__", &dir_ref)
}

fn safe_session_fragment(session_name: &str) -> String {
    let safe: String = session_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    safe
}

/// After the login session exits, read the credential from the container.
/// Claude interactive login stores OAuth state under its config dir, so capture
/// a small tar bundle of that state. Codex/Antigravity write credential files.
pub async fn capture_credential(
    docker: &Arc<DockerClient>,
    provider: &str,
    session_name: Option<&str>,
) -> Result<Option<String>, String> {
    let (_, cred_path) = login_spec(provider).ok_or("unknown provider")?;
    if cred_path == "__claude_config_bundle__" {
        let session_name = session_name
            .ok_or_else(|| "missing login session name for Claude credential".to_string())?;
        return capture_claude_bundle(docker, session_name).await;
    }
    if cred_path == "__stdout__" {
        let session_name = session_name
            .ok_or_else(|| "missing login session name for stdout credential".to_string())?;
        let log_path = login_capture_path(session_name);
        let read_script = format!("[ -s {log_path} ] && cat {log_path} || true");
        let content = docker
            .exec_capture_pub(vec!["sh", "-c", &read_script])
            .await
            .map_err(|e| e.to_string())?;
        return Ok(extract_claude_token(&content));
    }
    if cred_path == "__gh_token__" {
        // gh wrote ~/.config/gh/hosts.yml during `gh auth login`; read the token
        // back via `gh auth token` (env -u so a stray GH_TOKEN/GITHUB_TOKEN can't
        // shadow the freshly-logged-in one). `|| true` keeps a cancelled login
        // (no hosts.yml) returning empty → Ok(None), mirroring the file path.
        let content = docker
            .exec_capture_pub(vec![
                "sh",
                "-c",
                "env -u GH_TOKEN -u GITHUB_TOKEN gh auth token 2>/dev/null || true",
            ])
            .await
            .map_err(|e| e.to_string())?;
        let trimmed = content.trim();
        return Ok(if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        });
    }
    let read_script = format!("[ -s {cred_path} ] && cat {cred_path} || true");
    let content = docker
        .exec_capture_pub(vec!["sh", "-c", &read_script])
        .await
        .map_err(|e| e.to_string())?;
    let trimmed = content.trim();
    if trimmed.is_empty() || trimmed.starts_with("cat: ") {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

pub async fn login_failure_message(
    docker: &Arc<DockerClient>,
    provider: &str,
    session_name: Option<&str>,
) -> Option<String> {
    let session_name = session_name?;
    let log_path = login_capture_path(session_name);
    let script = format!("[ -s {log_path} ] && tail -80 {log_path} || true");
    let output: String = docker
        .exec_capture_pub(vec!["sh", "-c", &script])
        .await
        .ok()?;
    let clean = strip_ansi(&output);
    if provider == "codex"
        && clean
            .to_ascii_lowercase()
            .contains("enable device code authorization")
    {
        return Some(
            "Codex device auth is disabled for this ChatGPT account or workspace. Enable it in ChatGPT Settings > Security, then run Codex sign-in again."
                .into(),
        );
    }
    let last = clean
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" ");
    if last.is_empty() {
        None
    } else {
        Some(format!(
            "No credential found after login. Last output: {last}"
        ))
    }
}

async fn capture_claude_bundle(
    docker: &Arc<DockerClient>,
    session_name: &str,
) -> Result<Option<String>, String> {
    capture_claude_bundle_at(docker, &claude_login_config_dir(session_name)).await
}

/// Tar+base64 a live Claude config `dir` into a vault bundle string, guarded on
/// that dir reporting a logged-in account. Shared by the interactive login
/// capture (which reads the temp login dir) and the background credential-sync
/// loop (which reads a session's `/config/claude-profiles/<env>` dir to persist
/// the token Claude refreshed in place). Returns `None` when the dir is absent or
/// not logged in — so a logged-out dir never overwrites a good vault entry.
///
/// The bundle is an ALLOWLIST of the auth-essential files only — `.credentials.json`
/// (the token), `.claude.json` (account + onboarding flags + project trust), and
/// `settings.json`. NOT the whole dir: a denylist let `plugins/` (and any future
/// big dir Claude writes) bloat the bundle to MEGABYTES, and the bundle is later
/// delivered to the restore as a single ENV VAR — which Linux caps at
/// `MAX_ARG_STRLEN` (128 KiB). A 3 MB bundle silently broke restore (`argument list
/// too long`) → Claude launched logged-out. The three files stay well under the cap.
pub async fn capture_claude_bundle_at(
    docker: &DockerClient,
    dir: &str,
) -> Result<Option<String>, String> {
    let script = format!(
        r#"set -eu
dir={dir}
PATH="/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if [ ! -d "$dir" ]; then
  exit 0
fi
if ! CLAUDE_CONFIG_DIR="$dir" PATH="$PATH" claude auth status --json 2>/dev/null | jq -e '.loggedIn == true' >/dev/null 2>&1; then
  exit 0
fi
{onboarding}
tmp="$(mktemp)"
cleanup() {{ rm -f "$tmp"; }}
trap cleanup EXIT
(
  cd "$dir"
  files=""
  for f in .credentials.json .claude.json settings.json; do
    [ -e "$f" ] && files="$files ./$f"
  done
  # `.credentials.json` is guaranteed present (loggedIn check above), so $files is
  # never empty — but guard anyway so `set -e` can't abort on an empty tar.
  [ -n "$files" ] && tar -czf "$tmp" $files || tar -czf "$tmp" --files-from /dev/null
)
printf %s {prefix}
base64 "$tmp" | tr -d '\n'
"#,
        dir = shell_single_quote(dir),
        onboarding = claude_onboarding_patch_script("dir"),
        prefix = shell_single_quote(CLAUDE_AUTH_BUNDLE_PREFIX),
    );
    let content = docker
        .exec_capture_pub(vec!["sh", "-c", &script])
        .await
        .map_err(|e| e.to_string())?;
    let trimmed = content.trim();
    if trimmed.starts_with(CLAUDE_AUTH_BUNDLE_PREFIX) {
        Ok(Some(trimmed.to_string()))
    } else {
        Ok(None)
    }
}

/// `mtime-size` of a profile dir's `.credentials.json`, or `None` when the file
/// is absent (the profile was never seeded into this container) or the stat
/// fails. The runtime base is Debian, so GNU `stat -c` is available. The value
/// changes whenever Claude Code rewrites the file on a token refresh — that change
/// is the cheap signal the sync loop uses to skip unchanged creds.
async fn credential_fingerprint(docker: &DockerClient, file: &str) -> Option<String> {
    let script = format!(
        "stat -c '%Y-%s' {file} 2>/dev/null || true",
        file = shell_single_quote(file),
    );
    let out = docker
        .exec_capture_pub(vec!["sh", "-c", &script])
        .await
        .ok()?;
    let fp = out.trim().to_string();
    if fp.is_empty() {
        None
    } else {
        Some(fp)
    }
}

/// Read the live Codex `auth.json` from a profile's `CODEX_HOME` dir, or `None`
/// when it's absent or lacks a usable access token (so a cleared/partial file
/// never overwrites a good vault entry). With per-profile homes
/// (`/config/codex-profiles/<env>`) each account has its own `auth.json`, keyed
/// directly to a profile — like Claude's per-profile dirs.
async fn capture_codex_auth_at(
    docker: &DockerClient,
    home: &str,
) -> Result<Option<String>, String> {
    let script = format!(
        "[ -f {home}/auth.json ] && cat {home}/auth.json || true",
        home = shell_single_quote(home),
    );
    let out = docker
        .exec_capture_pub(vec!["sh", "-c", &script])
        .await
        .map_err(|e| e.to_string())?;
    let trimmed = out.trim();
    if codex_has_access_token(trimmed) {
        Ok(Some(trimmed.to_string()))
    } else {
        Ok(None)
    }
}

/// True when `json` is a Codex `auth.json` carrying a non-empty OAuth access
/// token — the marker that it's a real logged-in credential worth persisting.
fn codex_has_access_token(json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| {
            v.get("tokens")
                .and_then(|t| t.get("access_token"))
                .and_then(|a| a.as_str())
                .map(|s| !s.is_empty())
        })
        .unwrap_or(false)
}

/// Read the signed-in account's email from a freshly-captured credential, run
/// against the still-alive login container right after `capture_credential`.
/// Identity only — the same address already surfaced in the Integrations pane —
/// so it's safe to persist on the profile (config), unlike the token.
///
/// The decode is done container-side (`jq` + `base64` are in the runtime image)
/// because the credential we hold here is opaque to the host: Claude's is a
/// tar+gzip bundle and Codex's email lives inside a base64url JWT — neither is
/// parseable in-process without pulling new Rust deps. Returns `None` on any
/// miss (no file, no field, unparseable) — the caller treats email as optional.
pub async fn capture_account_email(
    docker: &Arc<DockerClient>,
    provider: &str,
    session_name: Option<&str>,
) -> Option<String> {
    let script = match provider {
        "claude" => {
            let dir = claude_login_config_dir(session_name?);
            format!(
                "PATH=\"/root/.local/bin:$PATH\"; f={}/.claude.json; [ -f \"$f\" ] && jq -r '.oauthAccount.emailAddress // empty' \"$f\" 2>/dev/null || true",
                shell_single_quote(&dir),
            )
        },
        // Codex's email is a claim in the id_token JWT. Pull the payload (2nd
        // dot-segment), convert base64url→base64, pad, decode, and read `email`
        // (falling back to the OpenAI profile claim some tokens use instead).
        "codex" => r#"f=/config/codex/auth.json
[ -f "$f" ] || exit 0
tok=$(jq -r '.tokens.id_token // empty' "$f" 2>/dev/null)
[ -n "$tok" ] || exit 0
payload=$(printf '%s' "$tok" | cut -d. -f2 | tr '_-' '/+')
case $(( ${#payload} % 4 )) in 2) payload="${payload}==";; 3) payload="${payload}=";; esac
printf '%s' "$payload" | base64 -d 2>/dev/null \
  | jq -r '.email // (."https://api.openai.com/profile".email) // empty' 2>/dev/null || true"#
            .to_string(),
        _ => return None,
    };
    let out = docker
        .exec_capture_pub(vec!["sh", "-c", &script])
        .await
        .ok()?;
    let email = out.trim();
    if email.is_empty() || !email.contains('@') {
        None
    } else {
        Some(email.to_string())
    }
}

/// Interval between credential-sync sweeps. Claude access tokens live for hours,
/// so a 10-minute sweep captures a refresh well within the access-token window
/// while costing only one cheap `stat` per running container in steady state.
const CREDENTIAL_SYNC_INTERVAL: std::time::Duration = std::time::Duration::from_secs(600);

/// Single global loop that keeps each vault-backed Claude **and Codex** profile's
/// stored credential current with the token the CLI refreshes *in place* inside
/// the container.
///
/// Why this exists: login captures a one-time snapshot into the vault, and
/// every session launch restores that snapshot. The CLI then refreshes the
/// short-lived access token in place, but the refresh is never written back — so
/// the vault's tokens stay frozen at login and eventually 401 once the refresh
/// token ages out, forcing manual re-login. This loop closes that gap by writing
/// the live, refreshed credential back to the vault.
///
/// One task, not one-per-container (cf. the events tailer): each sweep lists the
/// running workspace containers and, per profile, stats the on-disk credential
/// file; only when the fingerprint changed since the last sweep (the CLI just
/// refreshed) does it re-capture and `vault.store` it. The `seen` map is keyed by
/// `(container id, profile id)` so a recreated container (fresh `/config`)
/// re-syncs and independent containers don't suppress each other. Tauri-only —
/// the dev bridge has no vault.
///
/// Claude vs Codex shape: Claude isolates each profile under its own
/// `/config/claude-profiles/<env>` dir; Codex likewise now isolates each account
/// in its own `CODEX_HOME` (`/config/codex-profiles/<env>`), so both are keyed
/// directly by profile — one `auth.json` per profile dir, no account_id guessing.
pub async fn credential_sync_loop(
    manager: Arc<crate::manager::LifecycleManager>,
    config: Arc<crate::config::ConfigStore>,
    vault: Arc<Vault>,
) {
    use crate::lifecycle::ContainerState;
    let mut seen: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();
    loop {
        tokio::time::sleep(CREDENTIAL_SYNC_INTERVAL).await;

        let all = config.get().account_profiles;
        let is_vault = |p: &crate::config::AccountProfile| {
            matches!(p.credential, crate::config::CredentialSource::Vault)
        };
        // Vault-backed Claude profiles: (profile id, per-profile config dir).
        let claude_profiles: Vec<(String, String)> = all
            .iter()
            .filter(|p| p.agent == "claude" && is_vault(p))
            .map(|p| {
                let dir = crate::docker::claude_profile_dir_for_env(
                    &crate::config::vault_env_name(&p.id),
                );
                (p.id.clone(), dir)
            })
            .collect();
        // Vault-backed Codex profiles: (profile id, per-profile CODEX_HOME dir),
        // mirroring Claude — each account's auth.json lives in its own home.
        let codex_profiles: Vec<(String, String)> = all
            .iter()
            .filter(|p| p.agent == "codex" && is_vault(p))
            .map(|p| {
                let dir =
                    crate::docker::codex_profile_dir_for_env(&crate::config::vault_env_name(&p.id));
                (p.id.clone(), dir)
            })
            .collect();
        if claude_profiles.is_empty() && codex_profiles.is_empty() {
            continue;
        }

        // A transient daemon error must not churn the `seen` map — skip the sweep.
        let containers = match manager.list_workspace_containers().await {
            Ok(list) => list,
            Err(e) => {
                tracing::debug!("credential sync: fleet list failed ({e}); skipping sweep");
                continue;
            },
        };
        // Forget fingerprints for containers that no longer exist (removed or
        // recreated) so the map stays bounded across the app's lifetime.
        let live_ids: std::collections::HashSet<String> = containers
            .iter()
            .filter_map(|wc| wc.status.id.clone())
            .collect();
        seen.retain(|(cid, _), _| live_ids.contains(cid));

        for wc in containers {
            if wc.status.state != ContainerState::Running {
                continue;
            }
            let Some(cid) = wc.status.id.clone() else {
                continue;
            };
            let docker = manager.workspace_container(&wc.key).docker_client();

            // Claude: one credential file per profile dir.
            for (pid, dir) in &claude_profiles {
                let file = format!("{dir}/.credentials.json");
                let Some(fp) = credential_fingerprint(&docker, &file).await else {
                    continue; // profile not seeded in this container
                };
                let key = (cid.clone(), pid.clone());
                if seen.get(&key) == Some(&fp) {
                    continue; // unchanged since the last sweep
                }
                match capture_claude_bundle_at(&docker, dir).await {
                    Ok(Some(bundle)) => {
                        if vault.store(pid, &bundle).is_ok() {
                            seen.insert(key, fp);
                        }
                    },
                    // Logged-out / no bundle: leave the existing vault entry intact
                    // and don't record the fingerprint, so the next sweep retries.
                    Ok(None) => {},
                    Err(e) => tracing::debug!("credential sync capture failed: {e}"),
                }
            }

            // Codex: one auth.json per profile home (same shape as Claude above).
            for (pid, dir) in &codex_profiles {
                let file = format!("{dir}/auth.json");
                let Some(fp) = credential_fingerprint(&docker, &file).await else {
                    continue; // profile not seeded in this container
                };
                let key = (cid.clone(), pid.clone());
                if seen.get(&key) == Some(&fp) {
                    continue; // unchanged since the last sweep
                }
                match capture_codex_auth_at(&docker, dir).await {
                    Ok(Some(json)) => {
                        if vault.store(pid, &json).is_ok() {
                            seen.insert(key, fp);
                        }
                    },
                    // No usable creds on disk: keep the vault entry, retry next sweep.
                    Ok(None) => {},
                    Err(e) => tracing::debug!("codex credential sync capture failed: {e}"),
                }
            }
        }
    }
}

fn extract_claude_token(output: &str) -> Option<String> {
    let output = strip_ansi(output);
    for line in output.lines().rev() {
        if let Some(pos) = line.find("CLAUDE_CODE_OAUTH_TOKEN") {
            let rest = &line[pos + "CLAUDE_CODE_OAUTH_TOKEN".len()..];
            if let Some(token) = first_claude_token(rest) {
                return Some(token);
            }
        }
        if let Some(token) = first_claude_token(line) {
            return Some(token);
        }
    }
    None
}

fn first_claude_token(s: &str) -> Option<String> {
    s.split_whitespace().find_map(|part| {
        let token = part.trim_matches(|c: char| {
            matches!(
                c,
                '"' | '\'' | '`' | ',' | ';' | ')' | ']' | '}' | '(' | '[' | '{' | '=' | ':'
            )
        });
        if token.starts_with("sk-ant-") && token.len() > "sk-ant-".len() {
            Some(token.to_string())
        } else {
            None
        }
    })
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            let _ = chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Store a captured credential in the vault and emit success.
pub fn store_credential(
    vault: &Arc<Vault>,
    profile_id: &str,
    provider: &str,
    credential: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    vault
        .store(profile_id, credential)
        .map_err(|e| e.to_string())?;
    emit_progress(
        app,
        &AuthProgress {
            profile_id: profile_id.to_string(),
            provider: provider.to_string(),
            stage: "success".into(),
            url: None,
            user_code: None,
            message: Some(format!(
                "{} credentials stored in the vault",
                provider_label(provider)
            )),
        },
    );
    Ok(())
}

fn provider_label(provider: &str) -> &str {
    match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        "antigravity" => "Antigravity",
        "github" => "GitHub",
        _ => provider,
    }
}

// ── GitHub: device flow (no container needed) ───────────────────────────────

pub async fn github_login(
    vault: &Arc<Vault>,
    profile_id: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let pid = profile_id.to_string();

    let client_id = std::env::var("CODEHUB_GITHUB_CLIENT_ID").unwrap_or_default();
    if client_id.is_empty() {
        emit_progress(
            app,
            &AuthProgress {
                profile_id: pid.clone(),
                provider: "github".into(),
                stage: "error".into(),
                url: None,
                user_code: None,
                message: Some(
                    "CODEHUB_GITHUB_CLIENT_ID not set. Use 'Paste GitHub PAT' instead.".into(),
                ),
            },
        );
        return Err("CODEHUB_GITHUB_CLIENT_ID not set".into());
    }

    emit_progress(
        app,
        &AuthProgress {
            profile_id: pid.clone(),
            provider: "github".into(),
            stage: "starting".into(),
            url: None,
            user_code: None,
            message: Some("Requesting GitHub device code...".into()),
        },
    );

    let (device_code, user_code, verification_uri, interval) =
        crate::vault::github_request_device_code(&client_id)
            .await
            .map_err(|e| e.to_string())?;

    let _ = open::that(&verification_uri);

    emit_progress(
        app,
        &AuthProgress {
            profile_id: pid.clone(),
            provider: "github".into(),
            stage: "device_code".into(),
            url: Some(verification_uri.clone()),
            user_code: Some(user_code.clone()),
            message: Some(format!("Enter code {} at {}", user_code, verification_uri)),
        },
    );

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(900);
    let token = crate::vault::github_poll_token(&client_id, &device_code, interval, deadline)
        .await
        .map_err(|e| e.to_string())?;

    store_credential(vault, &pid, "github", &token, app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_token_extraction_handles_export_lines() {
        let output = "\u{1b}[32mComplete.\u{1b}[0m\n\
            export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-test_123';\n";

        assert_eq!(
            extract_claude_token(output).as_deref(),
            Some("sk-ant-test_123")
        );
    }

    #[test]
    fn claude_token_extraction_prefers_last_token() {
        let output = "old token sk-ant-old\n\
            paste this command:\n\
            CLAUDE_CODE_OAUTH_TOKEN=sk-ant-new_456\n";

        assert_eq!(
            extract_claude_token(output).as_deref(),
            Some("sk-ant-new_456")
        );
    }

    #[test]
    fn login_capture_path_sanitizes_session_names() {
        assert_eq!(
            login_capture_path("login:claude/abc"),
            "/tmp/codehub/auth-login_claude_abc.log"
        );
    }

    #[test]
    fn claude_config_dir_sanitizes_session_names() {
        assert_eq!(
            claude_login_config_dir("login:claude/abc"),
            "/tmp/codehub/claude-auth-login_claude_abc"
        );
    }

    #[test]
    fn claude_onboarding_patch_targets_selected_config_dir() {
        let script = claude_onboarding_patch_script("dir");

        assert!(script.contains("f=\"$dir/.claude.json\""));
        assert!(script.contains("hasCompletedOnboarding = true"));
        assert!(script.contains("hasTrustDialogAccepted: true"));
        assert!(script.contains("projectOnboardingSeenCount: 1"));
    }
}
