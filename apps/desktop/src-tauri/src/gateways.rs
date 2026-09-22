//! The list of Hermie Web entries the shell can point its one webview at, and
//! the one validator every URL passes before it becomes one.
//!
//! Task 3 makes this store-backed (`gateways.json` via `tauri-plugin-store`,
//! with add / forget / probe / activate). What Task 2b needs is narrower and is
//! all that is here: the *type* — because the bridge's grants and its guard are
//! both defined against it — [`validate`], and the single entry `HERMIE_WEB_URL`
//! names in a **debug** build.
//!
//! The list is the security boundary's data half. Every entry in it is an origin
//! the shell has granted `bridge::REMOTE_PERMISSIONS` to, so an entry getting in
//! is exactly what "this page may use the bridge" means. Keep it that way: an
//! entry gets in because the reader typed it (Task 3) or, in a debug build,
//! because the developer set `HERMIE_WEB_URL` — never because a page asked.
//!
//! Task 3 inherits two rules from the revised D5:
//!
//! - `add` validates, stores, and then calls `bridge::grant` for the new entry;
//! - `forget` writes the store, clears the browsing data and calls
//!   `AppHandle::restart()`. A capability cannot be withdrawn, so the shell
//!   relaunches; that is what keeps "the granted set equals the stored list at
//!   every moment a page can run" exactly true rather than nearly true.

use std::sync::{OnceLock, RwLock};
#[cfg(any(debug_assertions, test))]
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{Url, Wry};

/// The environment variable the dev bed passes the Hermie Web address in.
///
/// **Debug builds only.** A release binary never reads it: an environment
/// variable that could name the window's first page would also name an origin
/// the shell then grants the bridge to, and an environment variable is not a
/// thing the reader configured.
#[cfg(debug_assertions)]
pub const DEV_URL_VAR: &str = "HERMIE_WEB_URL";

/// The id the implicit `HERMIE_WEB_URL` entry carries.
///
/// A fixed string rather than the random hex Task 3 mints for a real entry: it
/// is not stored, it cannot collide with anything (there is only ever one of
/// it), and it is recognisable in `hermie_shell_info`'s reply while reading a
/// dev session's logs.
#[cfg(debug_assertions)]
pub const DEV_ENTRY_ID: &str = "dev";

/// The origin the Vite dev server serves the shell's own pages from
/// (`build.devUrl` in `tauri.conf.json`), read from the app's own compiled
/// config rather than kept as a second literal here — a config edit and this
/// check could otherwise drift apart silently.
///
/// Refused by [`validate`] for the same reason `tauri.localhost` is: Tauri's
/// `is_local_url` would call a page there local, which means `core:default` and
/// the whole local API — the opposite of what a gateway entry is for.
///
/// `tauri::generate_context!()` embeds `tauri.conf.json` at compile time, so
/// reading it back out is not an I/O cost — but it is a small parse, worth
/// doing once. `Wry` (the runtime the shell actually runs) rather than a
/// generic parameter: the config does not vary by runtime, and `validate` is a
/// plain `&str -> Result` function nothing else here makes generic.
fn dev_server_origin() -> &'static str {
    static ORIGIN: OnceLock<Option<String>> = OnceLock::new();
    ORIGIN
        .get_or_init(|| {
            crate::context::<Wry>()
                .config()
                .build
                .dev_url
                .as_ref()
                .map(|url| url.origin().ascii_serialization())
        })
        .as_deref()
        .unwrap_or_default()
}

/// Why a URL cannot be a gateway entry.
///
/// One variant per rule so the connect page (Task 3) can say which one was
/// broken; [`Invalid::message`] is the English the reader sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invalid {
    /// Not a URL at all.
    NotAUrl,
    /// Not `http` or `https`.
    Scheme,
    /// No host (`http:///path`, `file:` shapes the parser accepts).
    NoHost,
    /// A host the origin pattern could not carry faithfully.
    Host,
    /// `https://user:pass@host` — a credential in an address is never stored.
    Userinfo,
    /// `https://host/#fragment`.
    Fragment,
    /// `https://host/?query`.
    Query,
    /// `https://host.` — a different origin from `https://host`, and one no
    /// browser will send back in an `Origin` header.
    TrailingDot,
    /// An origin the shell itself owns: its own pages would be granted the
    /// local API.
    Local,
}

impl Invalid {
    /// One sentence, in English, for the connect page.
    pub fn message(self) -> &'static str {
        match self {
            Self::NotAUrl => "That is not a web address.",
            Self::Scheme => "The address has to start with https:// or http://.",
            Self::NoHost => "The address needs a host name.",
            Self::Host => "That host name has characters an address cannot carry.",
            Self::Userinfo => "Leave the username and password out of the address.",
            Self::Fragment => "Leave the # and everything after it out of the address.",
            Self::Query => "Leave the ? and everything after it out of the address.",
            Self::TrailingDot => {
                "Type the host the way the browser will use it, without the final dot."
            }
            Self::Local => {
                "That address belongs to the app itself. Enter the address of your Hermie Web."
            }
        }
    }
}

/// The one gate every gateway URL passes, whatever it came from: typed on the
/// connect page, read back from `gateways.json`, or set in `HERMIE_WEB_URL`.
///
/// Each rule is here because of what happens downstream, not out of taste:
///
/// - **scheme and host**: an entry is granted an ACL pattern, and a pattern is
///   built from scheme, host and port. Anything else has no origin to grant.
/// - **no userinfo**: the shell stores no credential (D3), and a `Url` keeps
///   userinfo out of the origin anyway, so keeping it would store a secret that
///   changes nothing.
/// - **no query, no fragment**: neither is part of an origin. A
///   `RemoteUrlPattern`'s parser rewrites an empty search and hash to `*`, so
///   they would be silently dropped — better to say so than to drop them.
/// - **no trailing dot**: `host.` and `host` are different origins, the
///   `Origin` header a browser sends carries whichever form the page was
///   loaded with, and a reader who types one and is served the other would get
///   a shell that refuses its own app with no explanation.
/// - **a host of `[a-z0-9.-]` or a bracketed IP**: URLPattern's constructor
///   string gives `*`, `{`, `}`, `(`, `)`, `:` and `?` meanings of their own.
///   Restricting the host to what a real name or address uses — punycode is
///   already in that set — means the pattern can never be anything but the
///   origin it was built from.
/// - **not one of the shell's own origins**: Tauri's `is_local_url` calls
///   `tauri://localhost`, `http(s)://<protocol>.localhost` and anything under
///   `devUrl` local, and a local page gets `core:default`. Bare `localhost` is
///   *not* in that set and is allowed: it is where a dev Hermie Web runs.
///
/// `localhost` and `127.0.0.1` are two origins and stay two; nothing here maps
/// one onto the other, because cookies do not either.
pub fn validate(raw: &str) -> Result<Url, Invalid> {
    let url = Url::parse(raw.trim()).map_err(|_| Invalid::NotAUrl)?;

    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(Invalid::Scheme);
    }

    if !url.username().is_empty() || url.password().is_some() {
        return Err(Invalid::Userinfo);
    }

    if url.fragment().is_some() {
        return Err(Invalid::Fragment);
    }

    if url.query().is_some() {
        return Err(Invalid::Query);
    }

    let host = url.host_str().ok_or(Invalid::NoHost)?;
    if host.is_empty() {
        return Err(Invalid::NoHost);
    }

    if host.ends_with('.') {
        return Err(Invalid::TrailingDot);
    }

    if !is_plain_host(host) {
        return Err(Invalid::Host);
    }

    // `tauri.localhost` is the one Tauri uses today; any `<name>.localhost` is
    // the shape it uses for a custom protocol, so the whole suffix goes. Bare
    // `localhost` is deliberately not in this set.
    if host.ends_with(".localhost") {
        return Err(Invalid::Local);
    }

    let pattern = crate::bridge::origin_pattern(&url).ok_or(Invalid::NoHost)?;

    if pattern == dev_server_origin() {
        return Err(Invalid::Local);
    }

    // The last rule, and the one that makes the rest exact: the address has to
    // become a pattern the ACL can actually carry. `add_capability` parses the
    // pattern internally and unwraps, so a shape that gets past every rule above
    // and then fails to parse would be a panic at the reader's next launch, with
    // their address in the message. Refusing it here means the invariant "every
    // stored entry can be granted" holds by construction.
    if pattern
        .parse::<tauri::utils::acl::RemoteUrlPattern>()
        .is_err()
    {
        return Err(Invalid::Host);
    }

    Ok(url)
}

/// A host the origin pattern can carry verbatim: a domain or IPv4 in
/// `[a-z0-9.-]` (the `url` crate has already lowercased it and punycoded an IDN
/// one), or a bracketed IPv6 literal.
fn is_plain_host(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return !inner.is_empty()
            && inner
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.');
    }

    !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

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
    #[cfg(any(debug_assertions, test))]
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
    /// The list the shell starts with.
    ///
    /// A debug build reads `HERMIE_WEB_URL`; a release build starts empty and
    /// waits for the connect page (Task 3), whatever the environment says.
    pub fn at_launch() -> Self {
        #[cfg(debug_assertions)]
        {
            Self::from_env()
        }

        // Not `Self::default()`: the same constructor every other list goes
        // through, so a release build takes the path Task 3 will fill with what
        // `gateways.json` holds rather than a second one that skips validation.
        #[cfg(not(debug_assertions))]
        {
            Self::from_entries(Vec::new(), None)
        }
    }

    /// The list a dev session has: whatever `HERMIE_WEB_URL` holds, or nothing.
    ///
    /// The value goes through [`validate`] like any other, so the dev bed is not
    /// a way past the rules the connect page enforces. A value that fails is
    /// ignored rather than fatal: the shell still starts, opens its placeholder
    /// page and grants nothing — which is what a typo in a shell profile should
    /// cost.
    #[cfg(debug_assertions)]
    pub fn from_env() -> Self {
        match std::env::var(DEV_URL_VAR) {
            Ok(raw) => match validate(&raw) {
                Ok(url) => Self::single(DEV_ENTRY_ID, url),
                Err(invalid) => {
                    eprintln!("{DEV_URL_VAR} ignored: {}", invalid.message());
                    Self::default()
                }
            },
            Err(_) => Self::default(),
        }
    }

    /// A list holding one entry, active.
    ///
    /// Through [`Self::from_entries`] like every other way a list is built, so
    /// there is exactly one path an entry can take into the set of origins the
    /// shell grants the bridge to.
    ///
    /// Only the dev bed and the tests mint an entry this way; Task 3's `add`
    /// mints a real one with a random id and puts it in the store.
    #[cfg(any(debug_assertions, test))]
    pub fn single(id: &str, url: Url) -> Self {
        let entry = GatewayEntry {
            id: id.to_string(),
            name: GatewayEntry::name_from(&url),
            url,
            gateway_origin: None,
            added_at: now_seconds(),
            last_seen_version: None,
        };

        Self::from_entries(vec![entry], None)
    }

    /// The list as it comes back from storage, with every entry re-validated.
    ///
    /// An entry that no longer passes [`validate`] is **skipped and logged**,
    /// never granted and never navigated to. The store is a file on disk; a file
    /// that has been hand-edited, or written by an older build under a rule this
    /// one has since added, must not be able to widen what the ACL trusts.
    ///
    /// Task 3 calls this with what `gateways.json` holds.
    pub fn from_entries(entries: Vec<GatewayEntry>, active: Option<String>) -> Self {
        let entries: Vec<GatewayEntry> = entries
            .into_iter()
            .filter(|entry| match validate(entry.url.as_str()) {
                Ok(_) => true,
                Err(invalid) => {
                    eprintln!("gateway {} skipped: {}", entry.id, invalid.message());
                    false
                }
            })
            .collect();

        // An active id whose entry was skipped would leave the shell pointing at
        // nothing; fall back to the first entry that survived.
        let active = active
            .filter(|id| entries.iter().any(|entry| &entry.id == id))
            .or_else(|| entries.first().map(|entry| entry.id.clone()));

        Self { entries, active }
    }

    /// Every entry, for `setup()` to grant and for Task 3's picker to list.
    pub fn entries(&self) -> &[GatewayEntry] {
        &self.entries
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

#[cfg(any(debug_assertions, test))]
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
        let list = GatewayList::single("one", url("https://hermes.example.com:9443/"));

        let active = list.active().expect("the one entry is active");
        assert_eq!(active.id, "one");
        assert_eq!(active.name, "hermes.example.com");
        assert_eq!(active.gateway_origin, None);
        assert_eq!(list.urls(), vec![url("https://hermes.example.com:9443/")]);
    }

    #[test]
    fn a_loopback_entry_keeps_its_port_in_the_url_the_guard_reads() {
        let list = GatewayList::single("one", url("http://127.0.0.1:9120/"));

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

    // ---- validate (Revision 2026-09-22, decision 5) ----

    fn entry(id: &str, raw: &str) -> GatewayEntry {
        GatewayEntry {
            id: id.into(),
            name: id.into(),
            url: url(raw),
            gateway_origin: None,
            added_at: 0,
            last_seen_version: None,
        }
    }

    #[test]
    fn the_shapes_a_reader_types_are_accepted() {
        for raw in [
            "https://hermes.example.com",
            "https://hermes.example.com:9443",
            "https://hermes.example.com:9443/hermie",
            "http://127.0.0.1:9120",
            "http://localhost:9120",
            "http://[::1]:9120",
            "http://hermie.example",
            // A tailnet-style plain-http host: allowed, with the app's own
            // cleartext warning (plan Security, ADR-0014).
            "http://hermes.example.com:9443",
            // Punycode is what the `url` crate leaves an IDN host as.
            "https://xn--bcher-kva.example",
        ] {
            assert!(validate(raw).is_ok(), "{raw} should be a gateway address");
        }
    }

    #[test]
    fn the_host_is_lowercased_and_surrounding_space_is_ignored() {
        let accepted = validate("  HTTPS://Hermes.Example.COM:9443/hermie  ").expect("accepted");

        assert_eq!(accepted.host_str(), Some("hermes.example.com"));
        assert_eq!(accepted.scheme(), "https");
        assert_eq!(accepted.port(), Some(9443));
    }

    #[test]
    fn every_rule_refuses_with_the_reason_it_is_there_for() {
        let cases = [
            ("not a url at all", Invalid::NotAUrl),
            ("ftp://hermes.example.com", Invalid::Scheme),
            ("tauri://localhost", Invalid::Scheme),
            ("file:///etc/passwd", Invalid::Scheme),
            ("hermie://chat/researcher", Invalid::Scheme),
            ("https://user:pass@hermes.example.com", Invalid::Userinfo),
            ("https://reader@hermes.example.com", Invalid::Userinfo),
            ("https://hermes.example.com/#/chat", Invalid::Fragment),
            ("https://hermes.example.com/?next=/", Invalid::Query),
            ("https://hermes.example.com.:9443", Invalid::TrailingDot),
            ("http://tauri.localhost", Invalid::Local),
            ("https://tauri.localhost", Invalid::Local),
            // The Vite dev server's origin: Tauri would call a page there local
            // and hand it `core:default`.
            ("http://localhost:1420", Invalid::Local),
        ];

        for (raw, expected) in cases {
            assert_eq!(validate(raw), Err(expected), "{raw}");
        }
    }

    #[test]
    fn localhost_and_the_loopback_address_stay_two_origins() {
        // Both are accepted, and neither is rewritten into the other: cookies
        // do not treat them as one, so neither may this.
        assert_eq!(
            validate("http://localhost:9120")
                .expect("accepted")
                .host_str(),
            Some("localhost")
        );
        assert_eq!(
            validate("http://127.0.0.1:9120")
                .expect("accepted")
                .host_str(),
            Some("127.0.0.1")
        );
    }

    #[test]
    fn a_host_with_url_pattern_syntax_in_it_is_refused() {
        // The belt to the ACL's braces: a host that reached `origin_pattern`
        // with `*`, `{` or `:` in it would build a pattern that means something
        // other than the origin it came from. The `url` crate rejects most of
        // these itself; the rule exists so that stays true whatever it accepts.
        for raw in [
            "https://*.example.com",
            "https://ex{a}mple.com",
            "https://exa(m)ple.com",
        ] {
            assert!(
                matches!(validate(raw), Err(Invalid::Host) | Err(Invalid::NotAUrl)),
                "{raw} should not become an entry"
            );
        }
    }

    #[test]
    fn a_stored_entry_that_no_longer_validates_is_skipped_and_never_granted() {
        let list = GatewayList::from_entries(
            vec![
                entry("good", "https://hermes.example.com:9443/"),
                entry("hand-edited", "https://user:pass@evil.example/"),
                entry("also-good", "http://127.0.0.1:9120/"),
            ],
            Some("good".into()),
        );

        assert_eq!(list.entries().len(), 2);
        assert_eq!(
            list.urls(),
            vec![
                url("https://hermes.example.com:9443/"),
                url("http://127.0.0.1:9120/")
            ]
        );
        assert_eq!(list.active().map(|e| e.id.as_str()), Some("good"));
    }

    #[test]
    fn an_active_id_whose_entry_was_skipped_falls_back_to_one_that_survived() {
        let list = GatewayList::from_entries(
            vec![
                entry("gone", "https://hermes.example.com./"),
                entry("kept", "http://127.0.0.1:9120/"),
            ],
            Some("gone".into()),
        );

        assert_eq!(list.active().map(|e| e.id.as_str()), Some("kept"));
    }

    #[test]
    fn a_list_whose_every_entry_was_skipped_is_empty_and_has_no_active_entry() {
        let list = GatewayList::from_entries(
            vec![entry("gone", "https://hermes.example.com./")],
            Some("gone".into()),
        );

        assert!(list.entries().is_empty());
        assert!(list.active().is_none());
        assert!(list.urls().is_empty());
    }
}
