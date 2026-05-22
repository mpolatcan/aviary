//! Dev-only entrypoint: runs the HTTP + WS bridge so the frontend can be driven
//! from a browser against a live backend. Built only with `--features devserver`
//! (see Cargo.toml `[[bin]]` required-features). Use `make dev-web`.
//! Built via `cargo run --bin codehub-devserver --features devserver`.

#[tokio::main]
async fn main() {
    codehub_lib::devserver::serve().await;
}
