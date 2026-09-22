//! What a page on an origin nobody configured can actually reach.
//!
//! Everything else in this crate tests functions. This module tests the
//! decision, by sending real IPC requests through `Webview::on_message` — the
//! same entry point wry's IPC handler uses — against an app built from the real
//! `tauri::generate_context!()`.
//!
//! **The context has to be the real one.** `tauri::test::mock_context` carries
//! no app ACL manifest, and `RuntimeAuthority::has_app_manifest` being false is
//! what makes Tauri skip the ACL for an app's own commands altogether. A suite
//! built on it would pass with every capability deleted, which is the shape of
//! proof this round exists to replace.
//!
//! The seven groups below are the Revision 2026-09-22 list, in its order.

use tauri::http::{HeaderMap, HeaderValue};
use tauri::ipc::CallbackFn;
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::bridge;
use crate::gateways::{GatewayEntry, GatewayList, GatewayState};

/// The gateway the reader configured. Never a real host (repo rule).
const CONFIGURED: &str = "https://hermes.example.com:9443";

/// Everything else in the world: an identity provider mid-sign-in, a page the
/// reader followed a link to, a third-party iframe inside the app page on
/// Windows. The bridge cannot tell them apart and does not need to.
const UNCONFIGURED: &str = "https://unconfigured.example";

/// The id and name the configured entry carries, so `hermie_shell_info`'s reply
/// can be checked for the right one.
const ENTRY_ID: &str = "a1b2c3";

/// Every command on the bridge, with an argument payload each one accepts.
///
/// The list is the contract: if a seventh ever appears, these tests do not
/// cover it and the count assertion below fails.
fn commands() -> Vec<(&'static str, serde_json::Value)> {
    vec![
        ("hermie_shell_info", serde_json::json!({})),
        (
            "hermie_set_menu",
            serde_json::json!({
                "titles": {
                    "chats": "Chats",
                    "search": "Search",
                    "settings": "Settings",
                    "close": "Close",
                    "newConversation": "New Conversation",
                    "toggleSidebar": "Hide Sidebar",
                },
                "chats": ["researcher"],
            }),
        ),
        (
            "hermie_notify",
            serde_json::json!({
                "notification": { "id": "evt-1", "title": "researcher" },
            }),
        ),
        ("hermie_set_badge", serde_json::json!({ "count": 3 })),
        ("hermie_open_gateways", serde_json::json!({})),
        (
            "hermie_close_handled",
            serde_json::json!({ "handled": true }),
        ),
    ]
}

fn entry(id: &str, url: &str) -> GatewayEntry {
    GatewayEntry {
        id: id.into(),
        name: format!("{id}.example"),
        url: Url::parse(url).expect("test URL"),
        gateway_origin: None,
        added_at: 0,
        last_seen_version: None,
    }
}

/// An app that knows about `entries`, has granted each of them, and whose one
/// webview is parked on `top_frame`.
///
/// This is the whole shell's trust setup in four lines, which is the point: if
/// `setup()` ever stops granting before it navigates, or grants something other
/// than the stored list, these tests stop describing it.
fn shell(
    entries: Vec<GatewayEntry>,
    top_frame: &str,
) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let list = GatewayList::from_entries(entries, None);
    let granted: Vec<GatewayEntry> = list.entries().to_vec();

    let app = mock_builder()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(GatewayState::new(list))
        .invoke_handler(tauri::generate_handler![
            bridge::hermie_shell_info,
            bridge::hermie_set_menu,
            bridge::hermie_notify,
            bridge::hermie_set_badge,
            bridge::hermie_open_gateways,
            bridge::hermie_close_handled
        ])
        .build(crate::context())
        .expect("build the mock app");

    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .build()
        .expect("build the main webview");

    for entry in &granted {
        bridge::grant(&app, entry).expect("grant the configured gateway");
    }

    webview
        .navigate(Url::parse(top_frame).expect("top frame URL"))
        .expect("navigate the webview");

    (app, webview)
}

/// The shell as it is in every test but the host ones: one configured gateway,
/// webview on it.
fn configured_shell() -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    shell(vec![entry(ENTRY_ID, CONFIGURED)], CONFIGURED)
}

fn request(cmd: &str, args: serde_json::Value, url: &str) -> InvokeRequest {
    InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: url.parse().expect("calling frame URL"),
        body: args.into(),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

/// The answer as JSON, or `None` when the ACL refused the call outright.
fn call(webview: &WebviewWindow<MockRuntime>, request: InvokeRequest) -> Option<serde_json::Value> {
    get_ipc_response(webview, request)
        .ok()
        .map(|body| body.deserialize().expect("a JSON reply"))
}

fn refusal() -> serde_json::Value {
    serde_json::json!({ "ok": false, "reason": "origin" })
}

// ---------------------------------------------------------------------------
// 1. Six commands from an unconfigured frame
// ---------------------------------------------------------------------------

#[test]
fn no_command_answers_a_frame_on_an_origin_nobody_configured() {
    // The Windows-iframe shape and the navigate-mid-flight shape in one: the
    // webview's top frame IS the configured gateway — the state the old guard
    // read and accepted — and the call still never reaches a command, because
    // the ACL matches the frame that asked.
    let (_app, webview) = configured_shell();

    for (cmd, args) in commands() {
        assert_eq!(
            call(&webview, request(cmd, args, UNCONFIGURED)),
            None,
            "{cmd} answered a frame on {UNCONFIGURED}"
        );
    }
}

#[test]
fn no_command_answers_a_frame_on_about_blank() {
    let (_app, webview) = shell(vec![entry(ENTRY_ID, CONFIGURED)], "about:blank");

    for (cmd, args) in commands() {
        assert_eq!(
            call(&webview, request(cmd, args, UNCONFIGURED)),
            None,
            "{cmd} answered from about:blank"
        );
    }
}

#[test]
fn a_shell_with_no_configured_gateway_grants_nothing_at_all() {
    // First run, before the connect page: there is no origin the bridge belongs
    // to, so there is no capability and every call is refused by the ACL.
    let (_app, webview) = shell(Vec::new(), "about:blank");

    for (cmd, args) in commands() {
        assert_eq!(call(&webview, request(cmd, args.clone(), CONFIGURED)), None);
        assert_eq!(call(&webview, request(cmd, args, UNCONFIGURED)), None);
    }
}

// ---------------------------------------------------------------------------
// 2. Six commands from the configured frame
// ---------------------------------------------------------------------------

#[test]
fn every_command_answers_the_configured_frame() {
    let (_app, webview) = configured_shell();

    for (cmd, args) in commands() {
        let reply = call(&webview, request(cmd, args, CONFIGURED))
            .unwrap_or_else(|| panic!("{cmd} was refused by the ACL from {CONFIGURED}"));

        assert_eq!(
            reply["ok"],
            serde_json::json!(true),
            "{cmd} answered {reply}"
        );
    }
}

#[test]
fn shell_info_names_the_entry_the_page_is_on() {
    let (_app, webview) = configured_shell();

    let reply = call(
        &webview,
        request("hermie_shell_info", serde_json::json!({}), CONFIGURED),
    )
    .expect("the configured frame gets an answer");

    assert_eq!(reply["ok"], serde_json::json!(true));
    assert_eq!(reply["gatewayId"], serde_json::json!(ENTRY_ID));
    assert_eq!(reply["gatewayName"], serde_json::json!("a1b2c3.example"));
    assert_eq!(reply["bridge"], serde_json::json!(bridge::BRIDGE_VERSION));
    assert!(reply["platform"].is_string());
    assert!(reply["version"].is_string());
}

#[test]
fn a_second_gateway_is_granted_too_so_a_switch_is_not_a_race() {
    // Both entries are granted, not only the active one: switching is a
    // navigation, and a call from the page that was live a moment ago is still
    // the app's.
    let second = "http://127.0.0.1:9120";
    let (_app, webview) = shell(
        vec![entry(ENTRY_ID, CONFIGURED), entry("second", second)],
        second,
    );

    let reply = call(
        &webview,
        request("hermie_shell_info", serde_json::json!({}), second),
    )
    .expect("the second gateway's page gets an answer");
    assert_eq!(reply["ok"], serde_json::json!(true));

    // And the first one is still answered while the window is already on the
    // second — the mid-switch shape. Both layers compare against the whole
    // list, not the active entry, so a call the app made a moment before the
    // navigation is not a race it has to lose.
    let reply = call(
        &webview,
        request(
            "hermie_set_badge",
            serde_json::json!({ "count": 1 }),
            CONFIGURED,
        ),
    )
    .expect("a call from the gateway the window just left");
    assert_eq!(reply["ok"], serde_json::json!(true));

    // A third address is still nobody: granting every entry is not granting
    // every origin.
    assert_eq!(
        call(
            &webview,
            request(
                "hermie_set_badge",
                serde_json::json!({ "count": 1 }),
                UNCONFIGURED
            )
        ),
        None
    );
}

// ---------------------------------------------------------------------------
// 3. The permission surface is exactly the eight
// ---------------------------------------------------------------------------

#[test]
fn the_grant_carries_eight_permissions_and_succeeds_in_a_real_app() {
    // A typo in a permission identifier panics inside `CapabilityBuilder`, and
    // a pattern the ACL cannot carry panics inside `add_capability`. Better here
    // than at a reader's first launch.
    assert_eq!(bridge::REMOTE_PERMISSIONS.len(), 8);
    assert_eq!(commands().len(), 6, "the bridge has exactly six commands");

    let (_app, _webview) = configured_shell();
}

#[test]
fn the_configured_page_reaches_nothing_beyond_the_bridge() {
    let (_app, webview) = configured_shell();

    // Registered plugins whose permission the grant deliberately leaves out.
    for cmd in ["plugin:opener|open_url", "plugin:store|load"] {
        assert_eq!(
            call(&webview, request(cmd, serde_json::json!({}), CONFIGURED)),
            None,
            "{cmd} was reachable from the app page"
        );
    }

    // A core plugin that is always present, and the one that would matter most:
    // a page that could drive the window could retitle or move the shell.
    assert_eq!(
        call(
            &webview,
            request(
                "plugin:window|set_title",
                serde_json::json!({ "label": "main", "value": "anything" }),
                CONFIGURED
            )
        ),
        None,
        "core:window was reachable from the app page"
    );

    // A plugin that is not even compiled in: the answer is the same refusal, and
    // adding the dependency later must not change that.
    assert_eq!(
        call(
            &webview,
            request(
                "plugin:fs|read_text_file",
                serde_json::json!({ "path": "/etc/passwd" }),
                CONFIGURED
            )
        ),
        None
    );
}

// ---------------------------------------------------------------------------
// 4. Events
// ---------------------------------------------------------------------------

fn listen_request(url: &str) -> InvokeRequest {
    request(
        "plugin:event|listen",
        serde_json::json!({
            "event": "tauri://focus",
            "target": { "kind": "Any" },
            "handler": 7,
        }),
        url,
    )
}

#[test]
fn an_unconfigured_frame_cannot_even_register_a_listener() {
    // This is what "receives no event" means. `core:event:allow-listen` is not
    // scoped to event names, so the only way to keep the shell's four events —
    // and Tauri's own `tauri://focus`, `resize`, `move`, `close-requested` —
    // away from a page is for that page to hold no listener at all.
    let (_app, webview) = configured_shell();

    assert_eq!(call(&webview, listen_request(UNCONFIGURED)), None);
}

#[test]
fn the_configured_frame_may_register_a_listener() {
    let (_app, webview) = configured_shell();

    assert!(
        call(&webview, listen_request(CONFIGURED)).is_some(),
        "the app page must be able to listen for the shell's events"
    );
}

#[test]
fn should_emit_follows_the_top_frame() {
    let (_app, webview) = configured_shell();
    assert!(crate::should_emit(webview.as_ref()));

    webview
        .navigate(Url::parse(UNCONFIGURED).unwrap())
        .expect("navigate away");
    assert!(
        !crate::should_emit(webview.as_ref()),
        "an identity provider's page must not be emitted to"
    );

    webview
        .navigate(Url::parse("about:blank").unwrap())
        .expect("navigate to about:blank");
    assert!(!crate::should_emit(webview.as_ref()));
}

// ---------------------------------------------------------------------------
// 5. The second layer
// ---------------------------------------------------------------------------

fn with_origin_header(mut request: InvokeRequest, origin: &str) -> InvokeRequest {
    let mut headers = HeaderMap::new();
    headers.insert("Origin", HeaderValue::from_str(origin).expect("header"));
    request.headers = headers;
    request
}

#[test]
fn an_origin_header_naming_an_unconfigured_origin_refuses_the_call() {
    // The ACL has already said yes (the calling frame is configured). The guard
    // refuses anyway: the header may only ever make a call stricter, and a
    // request that claims to come from somewhere the reader did not configure
    // gets nothing.
    let (_app, webview) = configured_shell();

    for (cmd, args) in commands() {
        let call_with_header = call(
            &webview,
            with_origin_header(request(cmd, args, CONFIGURED), UNCONFIGURED),
        );

        assert_eq!(call_with_header, Some(refusal()), "{cmd}");
    }
}

#[test]
fn an_origin_header_naming_the_configured_origin_changes_nothing() {
    let (_app, webview) = configured_shell();

    let reply = call(
        &webview,
        with_origin_header(
            request("hermie_shell_info", serde_json::json!({}), CONFIGURED),
            CONFIGURED,
        ),
    )
    .expect("answered");

    assert_eq!(reply["ok"], serde_json::json!(true));
}

#[test]
fn an_origin_header_that_is_not_a_url_refuses_the_call() {
    let (_app, webview) = configured_shell();

    assert_eq!(
        call(
            &webview,
            with_origin_header(
                request("hermie_shell_info", serde_json::json!({}), CONFIGURED),
                "null",
            )
        ),
        Some(refusal())
    );
}

#[test]
fn a_configured_page_framed_by_an_unconfigured_one_is_refused() {
    // The reverse of the Windows shape, and the case the second layer is
    // actually for: the calling frame is the app, so the ACL says yes, but the
    // window the reader is looking at belongs to somebody else.
    let (_app, webview) = shell(vec![entry(ENTRY_ID, CONFIGURED)], UNCONFIGURED);

    for (cmd, args) in commands() {
        assert_eq!(
            call(&webview, request(cmd, args, CONFIGURED)),
            Some(refusal()),
            "{cmd}"
        );
    }
}

// ---------------------------------------------------------------------------
// 6 and 7. Hosts and patterns, through the ACL rather than beside it
// ---------------------------------------------------------------------------

/// Invoke `hermie_shell_info` from `frame` against a shell configured for
/// `configured`, with the webview parked on `configured`.
fn reachable_from(configured: &str, frame: &str) -> bool {
    let (_app, webview) = shell(vec![entry(ENTRY_ID, configured)], configured);

    call(
        &webview,
        request("hermie_shell_info", serde_json::json!({}), frame),
    )
    .is_some()
}

#[test]
fn localhost_and_the_loopback_address_are_not_the_same_gateway() {
    assert!(reachable_from(
        "http://localhost:9120",
        "http://localhost:9120"
    ));
    assert!(!reachable_from(
        "http://localhost:9120",
        "http://127.0.0.1:9120"
    ));
    assert!(!reachable_from(
        "http://127.0.0.1:9120",
        "http://localhost:9120"
    ));
    assert!(!reachable_from(
        "http://localhost:9120",
        "http://[::1]:9120"
    ));
}

#[test]
fn a_trailing_dot_is_a_different_host() {
    assert!(!reachable_from(
        CONFIGURED,
        "https://hermes.example.com.:9443"
    ));
}

#[test]
fn a_port_is_part_of_the_gateway() {
    assert!(!reachable_from(
        CONFIGURED,
        "https://hermes.example.com:9444"
    ));
    assert!(!reachable_from(CONFIGURED, "https://hermes.example.com"));
    assert!(reachable_from(
        "https://hermes.example.com",
        "https://hermes.example.com:443"
    ));
}

#[test]
fn a_scheme_is_part_of_the_gateway() {
    assert!(!reachable_from(
        CONFIGURED,
        "http://hermes.example.com:9443"
    ));
}

#[test]
fn a_host_that_merely_contains_the_configured_one_is_not_it() {
    assert!(!reachable_from(
        CONFIGURED,
        "https://evil-hermes.example.com:9443"
    ));
    assert!(!reachable_from(
        CONFIGURED,
        "https://hermes.example.com.attacker.test:9443"
    ));
    assert!(!reachable_from(
        CONFIGURED,
        "https://sub.hermes.example.com:9443"
    ));
}

#[test]
fn a_path_prefix_does_not_narrow_the_grant_and_a_deeper_path_still_reaches_it() {
    // The entry may carry a path (`https://host/hermie`); the grant is its
    // origin, because that is where cookies and the same-origin policy are
    // drawn, and the app navigates within it.
    let (_app, webview) = shell(
        vec![entry(ENTRY_ID, "https://hermes.example.com:9443/hermie")],
        "https://hermes.example.com:9443/hermie/chat/researcher",
    );

    let reply = call(
        &webview,
        request(
            "hermie_shell_info",
            serde_json::json!({}),
            "https://hermes.example.com:9443/hermie/chat/researcher?q=1#top",
        ),
    )
    .expect("the app's own deeper page is still the app");

    assert_eq!(reply["ok"], serde_json::json!(true));
}

#[test]
fn an_uppercase_address_is_the_same_gateway_lowercased() {
    let configured = crate::gateways::validate("HTTPS://Hermes.Example.COM:9443")
        .expect("accepted and lowercased");

    let (_app, webview) = shell(
        vec![GatewayEntry {
            id: ENTRY_ID.into(),
            name: "upper".into(),
            url: configured,
            gateway_origin: None,
            added_at: 0,
            last_seen_version: None,
        }],
        CONFIGURED,
    );

    assert!(call(
        &webview,
        request("hermie_shell_info", serde_json::json!({}), CONFIGURED)
    )
    .is_some());
}

#[test]
fn an_ipv6_gateway_is_reachable_and_its_neighbours_are_not() {
    assert!(reachable_from("http://[::1]:9120", "http://[::1]:9120"));
    assert!(!reachable_from("http://[::1]:9120", "http://[::1]:9121"));
    assert!(!reachable_from(
        "http://[::1]:9120",
        "http://127.0.0.1:9120"
    ));
}
