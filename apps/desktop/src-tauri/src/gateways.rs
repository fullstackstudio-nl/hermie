//! The list of Hermie Web entries the shell can point its one webview at.
//!
//! Task 3 makes this store-backed (`gateways.json` via `tauri-plugin-store`,
//! with add / forget / probe / activate). What Task 2 needs is narrower and is
//! all that is here: the *type* — because the bridge's origin guard is defined
//! against it — and the single entry `HERMIE_WEB_URL` names in development, so
//! the guard has something real to compare against before the connect page
//! exists.
//!
//! The list is the security boundary's data half. `bridge::origin_allowed`
//! compares the calling webview's current origin against the entries here and
//! nothing else, so an entry being in this list is exactly what "the app page
//! may use the bridge" means. Keep it that way: an entry gets in because the
//! reader typed it (Task 3) or because the developer set `HERMIE_WEB_URL`,
//! never because a page asked.

use std::env;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Url;

/// The environment variable the dev bed passes the Hermie Web address in.
pub const DEV_URL_VAR: &str = "HERMIE_WEB_URL";

/// The id the implicit `HERMIE_WEB_URL` entry carries.
///
/// A fixed string rather than the random hex Task 3 mints for a real entry: it
/// is not stored, it cannot collide with anything (there is only ever one of
/// it), and it is recognisable in `hermie_shell_info`'s reply while reading a
/// dev session's logs.
pub const DEV_ENTRY_ID: &str = "dev";

/// One Hermie Web the shell knows about.
///
/// The field names are the ones `gateways.json` will carry in Task 3 (camelCase
/// on the wire, snake_case in Rust), so that task adds persistence without
/// changing this shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayEntry {
    /// Random hex, minted once, never derived from the URL (ADR-0024's
    /// reasoning: an address can change and a name can repeat).
    pub id: String,
    /// What to call it in the menu and the picker. Defaults to the gateway host
    /// `/hermie/config.json` reports; the URL's own host until then.
    pub name: String,
    /// The Hermie Web origin, plus an optional path prefix.
    pub url: Url,
    /// The gateway origin cached from `/hermie/config.json`, which is what a
    /// `hermie://chat/…?gateway=<key>` link is matched against (Task 6). Not
    /// probed yet in Task 2, so always `None` here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_origin: Option<String>,
    /// Seconds since the epoch.
    pub added_at: u64,
    /// The Hermie Web version seen on the last successful load. Task 3 fills it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_version: Option<String>,
}

impl GatewayEntry {
    /// A name for an entry nothing has been probed for yet: the URL's own host,
    /// which is what the reader typed and will recognise.
    fn name_from(url: &Url) -> String {
        url.host_str().unwrap_or("Hermie Web").to_string()
    }
}

/// Every Hermie Web the shell knows about, and which one is live.
///
/// `Default` is the honest state of a first run with no `HERMIE_WEB_URL`: no
/// entries, nothing active, and therefore an origin guard that refuses
/// everything. That is the right answer — with no configured Hermie Web there
/// is no page the bridge belongs to.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct GatewayList {
    entries: Vec<GatewayEntry>,
    active: Option<String>,
}

impl GatewayList {
    /// The list a dev session has: whatever `HERMIE_WEB_URL` holds, or nothing.
    ///
    /// A value that is not a URL is ignored rather than fatal. The shell still
    /// starts, opens its placeholder page and refuses the bridge — which is
    /// what a typo in a shell profile should cost.
    pub fn from_env() -> Self {
        match env::var(DEV_URL_VAR) {
            Ok(raw) => match Url::parse(raw.trim()) {
                Ok(url) => Self::single(url),
                Err(_) => Self::default(),
            },
            Err(_) => Self::default(),
        }
    }

    /// A list holding one entry, active.
    pub fn single(url: Url) -> Self {
        let entry = GatewayEntry {
            id: DEV_ENTRY_ID.to_string(),
            name: GatewayEntry::name_from(&url),
            url,
            gateway_origin: None,
            added_at: now_seconds(),
            last_seen_version: None,
        };

        Self {
            active: Some(entry.id.clone()),
            entries: vec![entry],
        }
    }

    /// The entry the webview is meant to be on, if there is one.
    pub fn active(&self) -> Option<&GatewayEntry> {
        let id = self.active.as_deref()?;
        self.entries.iter().find(|entry| entry.id == id)
    }

    /// Every configured URL, for the origin guard to compare against.
    ///
    /// Every entry, not only the active one: switching gateways is a navigation
    /// and the page that was live a moment ago is still the app. A bridge call
    /// that lands mid-switch is the app's, and refusing it would be a race the
    /// page cannot see or retry.
    pub fn urls(&self) -> Vec<Url> {
        self.entries.iter().map(|entry| entry.url.clone()).collect()
    }
}

/// The list as Tauri-managed state.
///
/// A lock because Task 3's add / forget / activate write it while the bridge
/// reads it from whichever thread an `invoke` arrived on.
#[derive(Debug, Default)]
pub struct GatewayState(RwLock<GatewayList>);

impl GatewayState {
    pub fn new(list: GatewayList) -> Self {
        Self(RwLock::new(list))
    }

    /// Read the list. A poisoned lock reads as "no entries", which refuses the
    /// bridge rather than panicking inside a command — the guard's failure
    /// direction is always "no".
    pub fn read<T>(&self, read: impl FnOnce(&GatewayList) -> T) -> Option<T> {
        self.0.read().ok().map(|list| read(&list))
    }

    /// Every configured URL, or none at all if the lock is poisoned.
    pub fn urls(&self) -> Vec<Url> {
        self.read(GatewayList::urls).unwrap_or_default()
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("test URL")
    }

    #[test]
    fn an_empty_list_has_no_active_entry_and_no_urls() {
        let list = GatewayList::default();

        assert!(list.active().is_none());
        assert!(list.urls().is_empty());
    }

    #[test]
    fn a_single_entry_is_active_and_named_after_its_host() {
        let list = GatewayList::single(url("https://hermes.example.com:9443/"));

        let active = list.active().expect("the one entry is active");
        assert_eq!(active.id, DEV_ENTRY_ID);
        assert_eq!(active.name, "hermes.example.com");
        assert_eq!(active.gateway_origin, None);
        assert_eq!(list.urls(), vec![url("https://hermes.example.com:9443/")]);
    }

    #[test]
    fn a_loopback_entry_keeps_its_port_in_the_url_the_guard_reads() {
        let list = GatewayList::single(url("http://127.0.0.1:9120/"));

        assert_eq!(list.urls(), vec![url("http://127.0.0.1:9120/")]);
    }

    #[test]
    fn state_with_a_poisoned_lock_would_report_no_urls() {
        // Not the poisoning itself (that needs a panicking thread), but the
        // shape the guard depends on: `urls()` never panics and its empty
        // answer refuses everything.
        let state = GatewayState::default();

        assert!(state.urls().is_empty());
    }
}
