//! Per-workspace container stats ring buffer for sparkline charts.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const RING_CAP: usize = 120;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatsPoint {
    pub at: i64,
    pub cpu_pct: f64,
    pub mem_used: u64,
    pub net_rx_rate: u64,
    pub net_tx_rate: u64,
}

struct Sample {
    at: i64,
    cpu_pct: f64,
    mem_used: u64,
    net_rx: u64,
    net_tx: u64,
}

#[derive(Default)]
pub struct StatsHistory {
    inner: Mutex<HashMap<String, VecDeque<Sample>>>,
}

impl StatsHistory {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&self, workspace: &str, stats: &crate::docker::ContainerStats) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let ring = map.entry(workspace.to_string()).or_default();
        ring.push_back(Sample {
            at: now,
            cpu_pct: stats.cpu_pct,
            mem_used: stats.mem_used,
            net_rx: stats.net_rx,
            net_tx: stats.net_tx,
        });
        if ring.len() > RING_CAP {
            ring.pop_front();
        }
    }

    pub fn history(&self, workspace: &str) -> Vec<StatsPoint> {
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(ring) = map.get(workspace) else {
            return Vec::new();
        };
        let mut points = Vec::with_capacity(ring.len());
        let mut prev: Option<&Sample> = None;
        for s in ring.iter() {
            let (rx_rate, tx_rate) = if let Some(p) = prev {
                let dt = ((s.at - p.at).max(1) as u64).max(1);
                let dt_sec = dt as f64 / 1000.0;
                (
                    ((s.net_rx.saturating_sub(p.net_rx)) as f64 / dt_sec) as u64,
                    ((s.net_tx.saturating_sub(p.net_tx)) as f64 / dt_sec) as u64,
                )
            } else {
                (0, 0)
            };
            points.push(StatsPoint {
                at: s.at,
                cpu_pct: s.cpu_pct,
                mem_used: s.mem_used,
                net_rx_rate: rx_rate,
                net_tx_rate: tx_rate,
            });
            prev = Some(s);
        }
        points
    }
}
