# Architecture decision records

Every decision that is expensive to reverse gets a short record here: what we decided, why, and what
it costs. The point is not ceremony — it is that six months later the reasoning is still readable,
including the parts that turned out to be wrong.

Records are numbered and immutable once accepted. A decision that no longer holds is not edited: a
new record supersedes it, and the old one gets a line at the top pointing forward.

## Index

| #                                                | Title                                                        | Status             |
| ------------------------------------------------ | ------------------------------------------------------------ | ------------------ |
| [0001](0001-expo-sdk-54-rn-081.md)               | Expo SDK 54 and React Native 0.81                            | Accepted           |
| [0002](0002-macos-via-react-native-macos.md)     | macOS through react-native-macos, in the same app package    | Superseded by 0011 |
| [0003](0003-vendor-hermes-shared.md)             | Vendor the Hermes protocol sources with a sync script        | Accepted           |
| [0004](0004-native-pkce-via-webview.md)          | Native PKCE sign-in through an intercepted web view redirect | Accepted           |
| [0005](0005-ticket-per-websocket-dial.md)        | A fresh ticket per WebSocket dial, offered as a subprotocol  | Accepted           |
| [0006](0006-single-gateway-no-relay.md)          | One gateway per install, no cross-gateway bot relay          | Accepted           |
| [0007](0007-canonical-bot-chats-only.md)         | Only canonical Bot Chats                                     | Accepted           |
| [0008](0008-verbosity-as-client-selector.md)     | Verbosity is a client-side selector                          | Accepted           |
| [0009](0009-bot-to-bot-detection.md)             | Bot-to-bot traffic is detected from transcript conventions   | Accepted           |
| [0010](0010-agent-questions-as-bottom-sheets.md) | Questions from the agent are bottom sheets                   | Accepted           |
| [0011](0011-mac-via-the-ipad-build.md)           | The Mac version is the iPad build                            | Accepted           |
| [0012](0012-local-chat-list-layout.md)           | The chat list's arrangement and colours are client-local     | Accepted           |

## Template

```markdown
# NNNN. Title in one line

- Status: Proposed | Accepted | Superseded by [NNNN](NNNN-....md)
- Date: YYYY-MM-DD

## Context

What forces are at play? What is true about the problem that makes this a decision rather than a
detail? Facts, constraints and the options that were actually considered.

## Decision

What we will do, stated plainly and in the present tense.

## Consequences

What becomes easier, what becomes harder, and what we are now committed to. Include the costs —
a record that only lists benefits is not describing a decision.
```
