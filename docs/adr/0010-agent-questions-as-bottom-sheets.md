# 0010. Questions from the agent are bottom sheets

- Status: Accepted
- Date: 2026-09-19

## Context

While a bot works it can block on the user: a permission request before running a command
(`approval`), a clarifying question with choices or free text (`clarify`, optionally a batch), and a
few desktop-only prompts Hermie declines. Each request is a JSON-RPC server-to-client request that
holds the agent's turn until it is answered, withdrawn (`request.cancel`) or times out. Requests are
replayed after a reconnect so a client that was in the background can still answer them.

## Decision

Approval and clarify requests are presented as **bottom sheets** that slide up over the chat. The
sheet shows the command or question and its answer options as explicit buttons; there are no swipe
or long-press gestures that could answer a request by accident, and a short guard after the sheet
appears ignores taps that were meant for the chat underneath. A request answered on another device
collapses into an "answered elsewhere" state.

The same sheet component hosts the chat options panel (YOLO, fast mode, reasoning effort, model,
verbosity, bot-to-bot and thinking visibility), whose toggles are commands to the gateway.

## Consequences

- The sheet component is implemented on `Modal` and `Animated` rather than on a gesture library, so
  that a sheet cannot be answered by a swipe and there is one implementation to keep in step with the
  tokens.
- On return to the foreground Hermie re-reads pending approvals and open requests and rebuilds the
  sheets before rendering the chat.
- Unsupported request kinds are answered with a "method not found" error immediately so the agent
  does not wait for a prompt the app cannot show.
