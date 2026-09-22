//! The bridge: the six commands the app page may call, and the origin guard
//! that decides whether the page asking is the app at all.
//!
//! # Why a guard on top of a capability
//!
//! The shell navigates one webview across origins on purpose. Signing in walks
//! through an identity provider's pages, Cloudflare Access's page, or Hermie
//! Web's own OIDC issuer, and every one of those is a page the shell loaded.
//! Tauri's capabilities are static — `capabilities/remote-app.json` can only
//! say "some remote origin", not "the origin the reader configured this
//! morning" — so the capability narrows WHAT is reachable (these six commands,
//! plus listening for events, and nothing else: no `fs`, no `shell`, no
//! `dialog`, no `opener`, no window control) and this module narrows WHO may
//! reach it.
//!
//! Both halves are load-bearing and neither is sufficient:
//!
//! - Without the capability, a remote page granted `core:default` would hold
//!   the whole core API.
//! - Without the guard, the login page of whatever identity provider an
//!   operator uses could call `hermie_notify` and raise OS notifications, read
//!   the active gateway's name out of `hermie_shell_info`, and — once Task 6
//!   lands — listen for `hermie://link` and learn every deep link the reader
//!   follows.
//!
//! # The shape of an answer
//!
//! Every command answers `{ ok: true, … }` or `{ ok: false, reason }` and never
//! rejects. A page that feature-detects the bridge should not have to
//! distinguish "this shell is too old for that call" from "that call threw",
//! and the app-side facade (`apps/hermie/src/platform/desktop-shell.ts`) treats
//! both as "no". A refusal is a fact about the caller, not an error the caller
//! can do anything about.

use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime, Url, Webview};

use crate::gateways::GatewayState;

/// The bridge contract's version, reported as `bridge` by `hermie_shell_info`.
///
/// The app keys its behaviour on this, not on the shell's release version: an
/// incompatible change bumps it and the app keeps the old path for one release
/// (the same rule the Swift module follows for "an older binary under a newer
/// bundle").
pub const BRIDGE_VERSION: u32 = 1;

/// The events the shell emits to the app page. Only through
/// `crate::emit_to_app`, which checks the origin first.
///
/// Written down here in Task 2 because they are half of the bridge contract the
/// app-side facade is built against; Tasks 5 and 6 are what emit them.
#[allow(dead_code)]
pub mod events {
    /// A menu accelerator resolved to one of the page's own `SHORTCUTS` rows.
    pub const SHORTCUT: &str = "hermie://shortcut";
    /// A `hermie://…` deep link, from the OS or from a notification click.
    pub const LINK: &str = "hermie://link";
    /// The active gateway changed; sent before the navigation.
    pub const GATEWAY: &str = "hermie://gateway";
    /// The window regained focus.
    pub const FOCUS: &str = "hermie://focus";
}

/// Which desktop the shell is running on, in the marker's own spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

impl Platform {
    /// The platform this binary was built for.
    ///
    /// Anything that is neither macOS nor Windows answers `Linux`, because what
    /// the app does with this is pick the `command` modifier (⌘ on macOS, Ctrl
    /// elsewhere) and draw platform-appropriate copy. A FreeBSD build running
    /// WebKitGTK wants every answer the Linux build gets, and "unknown" would
    /// only give the app a fourth case to get wrong.
    pub fn current() -> Self {
        match std::env::consts::OS {
            "macos" => Self::Macos,
            "windows" => Self::Windows,
            _ => Self::Linux,
        }
    }
}

/// Why a command refused. One variant today; later tasks add their own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    /// The calling webview is not on a configured Hermie Web origin.
    Origin,
}

/// `{ ok: false, reason }` — the only failure shape the page ever sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Refusal {
    ok: bool,
    reason: Reason,
}

impl Refusal {
    fn new(reason: Reason) -> Self {
        Self { ok: false, reason }
    }
}

/// `{ ok: true }` — what a command with nothing to report answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Ack {
    ok: bool,
}

impl Ack {
    fn new() -> Self {
        Self { ok: true }
    }
}

/// `{ ok: true, … }` or `{ ok: false, reason }`, flattened into one JSON object
/// either way so the page reads `ok` first and nothing else until it is true.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Reply<T> {
    Accepted(T),
    Refused(Refusal),
}

impl<T> Reply<T> {
    fn refused(reason: Reason) -> Self {
        Self::Refused(Refusal::new(reason))
    }
}

/// `hermie_shell_info`'s answer: everything the app needs to know that it is in
/// the shell and which gateway the shell believes it is showing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    ok: bool,
    /// The shell's own version — `apps/desktop`'s, which `set-version.mjs`
    /// keeps equal to the app's. Not the version of the page, which is Hermie
    /// Web's business and may legitimately differ.
    version: &'static str,
    platform: Platform,
    bridge: u32,
    /// `None` when no gateway is configured, which in Task 2 means
    /// `HERMIE_WEB_URL` was not set — the guard has then already refused, so
    /// the page never sees this.
    gateway_id: Option<String>,
    gateway_name: Option<String>,
}

/// The titles the page's own strings supply for the native menu.
///
/// Deserialized here rather than passed through as opaque JSON so the contract
/// is checked at the boundary: a page that sends the wrong shape is refused by
/// Tauri's own argument deserialization before any menu is rebuilt. Mirrors
/// `MenuBarTitles` in `apps/hermie/src/platform/desktop-shortcuts.shared.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarTitles {
    pub chats: String,
    pub search: String,
    pub settings: String,
    pub close: String,
    pub new_conversation: String,
    pub toggle_sidebar: String,
}

/// One OS notification the page asks for.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    /// The transcript event id, so the shell can drop a repeat.
    pub id: String,
    pub title: String,
    pub body: Option<String>,
    /// A `hermie://…` URL to emit back when the notification is clicked. Parsed
    /// as a URL before it is used (Task 5); never executed.
    pub link: Option<String>,
}

/// An origin as the guard compares them: `scheme://host:port`.
///
/// `None` for anything that is not http(s), which is deliberate and is what
/// refuses `about:blank`, `data:` documents, `file://`, and the shell's own
/// local pages on `tauri://localhost` — none of those is a configured Hermie
/// Web, and the shell's pages have their own capability rather than borrowing
/// the app's.
///
/// Normalisation, all of it needed for the comparison to mean what it says:
///
/// - the scheme is lowercased (`HTTPS://…` is the same origin as `https://…`);
/// - the host is lowercased, because DNS is case-insensitive and
///   `HERMES.example.com` is the same machine;
/// - the port is always explicit, so a configured `https://host` and a webview
///   on `https://host:443` match — the `url` crate drops a default port, which
///   would otherwise make those two different strings.
pub fn origin_of(url: &Url) -> Option<String> {
    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }

    let host = url.host_str()?.to_ascii_lowercase();
    let port = url.port_or_known_default()?;

    Some(format!("{scheme}://{host}:{port}"))
}

/// May a page on `current` use the bridge?
///
/// Origin only: scheme, host and port. A configured entry may carry a path
/// prefix (`https://host/hermie`) and the app navigates within it, so comparing
/// paths would refuse the app on its second screen. Cookies, storage and the
/// same-origin policy are all drawn at the origin too, so this is the same line
/// the browser already draws around the session — nothing narrower would be
/// enforceable and nothing wider would be honest.
///
/// An empty list refuses everything. That is the state of a shell with no
/// configured Hermie Web, and "no" is the only safe answer there.
pub fn origin_allowed(current: &Url, configured: &[Url]) -> bool {
    let Some(origin) = origin_of(current) else {
        return false;
    };

    configured
        .iter()
        .filter_map(origin_of)
        .any(|allowed| allowed == origin)
}

/// Is the page in this webview right now one of the configured Hermie Webs?
///
/// A webview whose URL cannot be read is refused: the guard's failure direction
/// is always "no".
pub fn guard<R: Runtime>(webview: &Webview<R>) -> bool {
    let Ok(url) = webview.url() else {
        return false;
    };

    origin_allowed(&url, &webview.state::<GatewayState>().urls())
}

/// Run `accepted` only if the calling webview passes the guard.
///
/// Every command goes through here, which is the point: a command that forgets
/// the guard is a command that does not compile into this shape.
fn guarded<R, T>(webview: &Webview<R>, accepted: impl FnOnce() -> T) -> Reply<T>
where
    R: Runtime,
{
    if guard(webview) {
        Reply::Accepted(accepted())
    } else {
        Reply::refused(Reason::Origin)
    }
}

/// `{ version, platform, bridge, gatewayId, gatewayName }`.
///
/// The app's whole feature detection: a reply means the bridge is there, is
/// reachable from this page, and speaks version `bridge`.
#[tauri::command]
pub fn hermie_shell_info<R: Runtime>(webview: Webview<R>) -> Reply<ShellInfo> {
    guarded(&webview, || {
        // Read inside the closure, not before it: a refused caller learns
        // nothing about the gateway list, not even by timing.
        let gateway = webview
            .state::<GatewayState>()
            .read(|list| {
                list.active()
                    .map(|entry| (entry.id.clone(), entry.name.clone()))
            })
            .flatten();

        let (gateway_id, gateway_name) = match gateway {
            Some((id, name)) => (Some(id), Some(name)),
            None => (None, None),
        };

        ShellInfo {
            ok: true,
            version: env!("CARGO_PKG_VERSION"),
            platform: Platform::current(),
            bridge: BRIDGE_VERSION,
            gateway_id,
            gateway_name,
        }
    })
}

/// Rebuild the native Chats menu from the page's own titles and chat list.
///
/// Stubbed in Task 2: the contract exists, the guard runs, and Task 6 builds
/// the menu. Accepting and doing nothing is the right stub — the app already
/// treats `setMenuBar` as something that may reach nothing (it does on a phone),
/// so a shell that answers `ok` and draws no menu is a state the app handles.
#[tauri::command]
pub fn hermie_set_menu<R: Runtime>(
    webview: Webview<R>,
    titles: MenuBarTitles,
    chats: Vec<String>,
) -> Reply<Ack> {
    let _ = (titles, chats);
    guarded(&webview, Ack::new)
}

/// Raise an OS notification. Stubbed in Task 2; Task 5 wires the plugin.
#[tauri::command]
pub fn hermie_notify<R: Runtime>(webview: Webview<R>, notification: Notification) -> Reply<Ack> {
    let _ = notification;
    guarded(&webview, Ack::new)
}

/// Set the dock badge / taskbar overlay / tray tooltip. Stubbed; Task 5.
#[tauri::command]
pub fn hermie_set_badge<R: Runtime>(webview: Webview<R>, count: Option<u32>) -> Reply<Ack> {
    let _ = count;
    guarded(&webview, Ack::new)
}

/// Show the shell's gateway picker. Stubbed; Task 3 navigates to
/// `connect.html?pick=1`.
#[tauri::command]
pub fn hermie_open_gateways<R: Runtime>(webview: Webview<R>) -> Reply<Ack> {
    guarded(&webview, Ack::new)
}

/// The page's answer to a `close` shortcut: `false` means nothing was open and
/// the shell should hide the window. Stubbed; Task 6.
#[tauri::command]
pub fn hermie_close_handled<R: Runtime>(webview: Webview<R>, handled: bool) -> Reply<Ack> {
    let _ = handled;
    guarded(&webview, Ack::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("test URL")
    }

    fn configured() -> Vec<Url> {
        vec![
            url("https://hermes.example.com:9443/"),
            url("http://127.0.0.1:9120/"),
        ]
    }

    #[test]
    fn a_configured_origin_is_allowed() {
        assert!(origin_allowed(
            &url("https://hermes.example.com:9443/chat/researcher"),
            &configured()
        ));
        assert!(origin_allowed(
            &url("http://127.0.0.1:9120/"),
            &configured()
        ));
    }

    #[test]
    fn a_different_port_on_the_same_host_is_refused() {
        assert!(!origin_allowed(
            &url("https://hermes.example.com:9444/"),
            &configured()
        ));
        assert!(!origin_allowed(
            &url("https://hermes.example.com/"),
            &configured()
        ));
        assert!(!origin_allowed(
            &url("http://127.0.0.1:9121/"),
            &configured()
        ));
    }

    #[test]
    fn a_different_scheme_on_the_same_host_and_port_is_refused() {
        // An operator who moved their Hermie Web behind TLS has to say so; a
        // plaintext page on the same host:port is not the same origin and is
        // not the session the cookie belongs to.
        assert!(!origin_allowed(
            &url("http://hermes.example.com:9443/"),
            &configured()
        ));
        assert!(!origin_allowed(
            &url("https://127.0.0.1:9120/"),
            &configured()
        ));
    }

    #[test]
    fn an_unconfigured_host_is_refused() {
        assert!(!origin_allowed(&url("https://example.com/"), &configured()));
        // The one that matters most in practice: an identity provider's page,
        // reached by a legitimate top-level navigation the shell allows.
        assert!(!origin_allowed(
            &url("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"),
            &configured()
        ));
        // And a host that merely ends in a configured one.
        assert!(!origin_allowed(
            &url("https://evil-hermes.example.com:9443/"),
            &configured()
        ));
        // …or has it as a suffix through a subdomain of its own.
        assert!(!origin_allowed(
            &url("https://hermes.example.com.attacker.test:9443/"),
            &configured()
        ));
    }

    #[test]
    fn the_shells_own_local_pages_are_refused_by_the_remote_guard() {
        // `connect.html` and `offline.html` have their own capability
        // (`local-pages.json`); they must not reach the app's bridge, and on
        // Windows/Linux their origin is a real http one, so this is not an
        // accident of scheme parsing.
        assert!(!origin_allowed(
            &url("tauri://localhost/connect.html"),
            &configured()
        ));
        assert!(!origin_allowed(
            &url("http://tauri.localhost/connect.html"),
            &configured()
        ));
        assert!(!origin_allowed(&url("about:blank"), &configured()));
        assert!(!origin_allowed(&url("file:///etc/passwd"), &configured()));
        assert!(!origin_allowed(&url("data:text/html,<p>hi"), &configured()));
    }

    #[test]
    fn an_empty_list_refuses_every_page() {
        assert!(!origin_allowed(
            &url("https://hermes.example.com:9443/"),
            &[]
        ));
        assert!(!origin_allowed(&url("http://127.0.0.1:9120/"), &[]));
    }

    #[test]
    fn a_default_port_matches_whether_or_not_it_was_written_out() {
        let configured = vec![url("https://hermes.example.com/")];

        assert!(origin_allowed(
            &url("https://hermes.example.com/"),
            &configured
        ));
        assert!(origin_allowed(
            &url("https://hermes.example.com:443/login"),
            &configured
        ));

        let spelled_out = vec![url("http://hermes.example.com:80/")];
        assert!(origin_allowed(
            &url("http://hermes.example.com/x"),
            &spelled_out
        ));
    }

    #[test]
    fn the_host_is_compared_case_insensitively() {
        assert!(origin_allowed(
            &url("https://HERMES.EXAMPLE.COM:9443/"),
            &configured()
        ));
        assert!(origin_allowed(
            &url("https://hermes.example.com:9443/"),
            &[url("https://HERMES.Example.Com:9443/")]
        ));
    }

    #[test]
    fn a_path_prefix_on_the_configured_entry_does_not_narrow_the_origin() {
        let configured = vec![url("https://hermes.example.com:9443/hermie/")];

        assert!(origin_allowed(
            &url("https://hermes.example.com:9443/hermie/chat"),
            &configured
        ));
        assert!(origin_allowed(
            &url("https://hermes.example.com:9443/"),
            &configured
        ));
    }

    #[test]
    fn credentials_and_fragments_do_not_change_the_origin() {
        // `Url` keeps userinfo out of the origin, and Task 3 refuses a typed
        // URL that carries any. Neither may be a way past the comparison.
        assert!(origin_allowed(
            &url("https://user:pass@hermes.example.com:9443/#/chat"),
            &configured()
        ));
        assert!(!origin_allowed(
            &url("https://user:pass@example.com/#hermes.example.com:9443"),
            &configured()
        ));
    }

    #[test]
    fn an_ipv6_loopback_keeps_its_brackets_on_both_sides() {
        let configured = vec![url("http://[::1]:9120/")];

        assert!(origin_allowed(&url("http://[::1]:9120/chat"), &configured));
        assert!(!origin_allowed(&url("http://[::1]:9121/"), &configured));
    }

    #[test]
    fn origin_of_normalises_what_it_accepts_and_rejects_the_rest() {
        assert_eq!(
            origin_of(&url("HTTPS://Hermes.Example.COM/x")).as_deref(),
            Some("https://hermes.example.com:443")
        );
        assert_eq!(
            origin_of(&url("http://127.0.0.1:9120/")).as_deref(),
            Some("http://127.0.0.1:9120")
        );
        assert_eq!(origin_of(&url("tauri://localhost/index.html")), None);
        assert_eq!(origin_of(&url("hermie://chat/researcher")), None);
        assert_eq!(origin_of(&url("about:blank")), None);
    }

    #[test]
    fn a_refusal_serialises_as_ok_false_with_a_reason() {
        let refused: Reply<Ack> = Reply::refused(Reason::Origin);

        assert_eq!(
            serde_json::to_string(&refused).expect("serialise"),
            r#"{"ok":false,"reason":"origin"}"#
        );
    }

    #[test]
    fn an_ack_serialises_as_ok_true_and_nothing_else() {
        let accepted = Reply::Accepted(Ack::new());

        assert_eq!(
            serde_json::to_string(&accepted).expect("serialise"),
            r#"{"ok":true}"#
        );
    }

    #[test]
    fn shell_info_serialises_flat_and_in_the_pages_spelling() {
        let info = Reply::Accepted(ShellInfo {
            ok: true,
            version: "0.1.0",
            platform: Platform::Macos,
            bridge: BRIDGE_VERSION,
            gateway_id: Some("dev".into()),
            gateway_name: Some("127.0.0.1".into()),
        });

        assert_eq!(
            serde_json::to_string(&info).expect("serialise"),
            r#"{"ok":true,"version":"0.1.0","platform":"macos","bridge":1,"gatewayId":"dev","gatewayName":"127.0.0.1"}"#
        );
    }

    #[test]
    fn every_event_name_is_one_tauri_will_accept_and_the_app_subscribes_to() {
        // Tauri refuses an event name with a character outside
        // `[alphanumeric]`, `-`, `/`, `:` and `_` (`event::is_event_name_valid`),
        // and the refusal is a runtime error from `emit`, which `emit_to_app`
        // deliberately swallows — so a typo here would be silent. These must
        // also match the strings in
        // `apps/hermie/src/platform/desktop-shell.ts`.
        let names = [
            events::SHORTCUT,
            events::LINK,
            events::GATEWAY,
            events::FOCUS,
        ];

        for name in names {
            assert!(name.starts_with("hermie://"), "{name} is not namespaced");
            assert!(
                name.chars().all(|c| c.is_alphanumeric()
                    || c == '-'
                    || c == '/'
                    || c == ':'
                    || c == '_'),
                "{name} has a character Tauri will refuse"
            );
        }

        assert_eq!(names.len(), 4, "the contract has four events");
    }

    #[test]
    fn the_platform_marker_spells_the_three_the_app_branches_on() {
        assert_eq!(
            serde_json::to_string(&Platform::Macos).expect("serialise"),
            r#""macos""#
        );
        assert_eq!(
            serde_json::to_string(&Platform::Windows).expect("serialise"),
            r#""windows""#
        );
        assert_eq!(
            serde_json::to_string(&Platform::Linux).expect("serialise"),
            r#""linux""#
        );
    }
}
