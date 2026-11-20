# First-turn relay protocol

`first-turn-relay.ts` is a self-contained module for pi extensions that each want to own the first turn of a new session: inject a block of instructions (a guidance set, a style profile, ...), let the model confirm it, and only then deliver the user's original message.

Copy the file into your extension directory (or import it from a shared location) and call `createFirstTurnRelay` from your extension's factory. No other setup is required.

## The problem

Pi dispatches the `input` event to handlers in registration order, and the first handler to return `{ action: "handled" }` wins — the remaining handlers do not run for that event. With two or more block-injecting extensions, exactly one wins the slot and the other's block is lost (or duplicated by naive fallbacks). The protocol makes the order deterministic and total.

## The protocol

The extension whose input handler takes the first user message of a new session becomes the **slot-holder**. Extensions whose input handler did not run become **relays**.

**Slot-holder** (the module's input proxy branch):

1. Announces itself with a custom session entry `{ customType: "relay-handshake", data: { role: "slot-holder", sid, userMsg } }`, where `userMsg` is the user's original message text, trimmed.
2. Queues its block as a follow-up.
3. Waits up to 9 x 50ms for a relay to announce itself (relays announce at session_start + ~350ms). When one appears, it waits a 150ms settle delay so the relay's block lands ahead of the user's message in the follow-up queue; with no relay it queues right away.
4. Queues the user's message as a follow-up — behind the relay's block when a relay is present, right behind its own block otherwise.
5. Keeps a backstop copy of the user's message. On `agent_settled` it delivers that copy only if the follow-up queue failed and no relay announced itself; otherwise it stands down.

**Relay** (the module's session_start path plus its dedupe input branch):

1. After 7 x 50ms of confirming its own proxy did not take the slot, announces itself with `{ customType: "relay-handshake", data: { role: "relay", sid } }` and reads the slot-holder's entry to learn `userMsg`.
2. Queues its own block as a follow-up, immediately after the announcement, so the slot-holder's settle delay covers it.
3. Its dedupe branch watches the input pipeline: follow-ups loop back as extension-source inputs, and the slot-holder's delivery of the user's message passes through here. The dedupe re-queues exactly the announced `userMsg`, so the user's message lands behind the relay's block. Any other text passes through untouched; the relay's own block is allowed once (while the user message is still pending) and suppressed on duplicates.

**Net order in a two-extension session:** slot-holder's block, relay's block, the user's message — each exactly once.

## Guarantees and edge cases

- Coordination is through public session entries only. Extensions do not import each other or share memory, and no identity fields are exchanged.
- A slot-holder that does not implement the protocol (no handshake entry) is handled by observation: on the first `agent_settled` of a session whose first turn went elsewhere, the module queues its block after that run (the `maybeRelay` fallback) and leaves the user's message with the slot-holder.
- If the relay path armed at session_start but the module's own proxy later claimed the first message (possible when the session has no prior user entries), both blocks are queued. This is the module's one known double-injection case; in practice it requires the first user message to arrive after ~350ms of session silence.
- Timing knobs are exported as `TIMING`. They are small relative to a model turn, and the exact values matter only in that they fit inside the windows described above.

## Usage

```ts
import { createFirstTurnRelay } from "./first-turn-relay.ts";

export default function (pi: ExtensionAPI) {
  createFirstTurnRelay(pi, {
    label: "My extension",              // used in UI notifications
    directivePrefix: "Apply this",      // prefix unique to your block
    block: () => myBlockText(),         // the block to inject
  });
}
```

The module registers three handlers: an input handler (the slot proxy and the dedupe, branched on `event.source`), a `session_start` handler (the relay path), and an `agent_settled` handler (the backstop and the fallback). For your own session-start or settled behavior, use the `onSessionStart` / `onSettled` config hooks. Keep other extension-specific handlers (`before_agent_start`, `session_compact`, ...) in your own extension file.

### Config

| Field | Required | Purpose |
| --- | --- | --- |
| `label` | yes | Short label for UI notifications. |
| `directivePrefix` | yes | Prefix identifying your own block text; the dedupe uses it to tell your block (allow first, suppress duplicates) apart from everything else. Use a prefix that appears at the start of your block's directive line. |
| `block` | yes | Returns the block text to inject on the first turn. |
| `blockReady` | no | When false, the relay path stays off for this session (e.g. the block's source document is missing). Default: true. |
| `onSessionStart` | no | Called from the module's session_start handler, before the relay path arms. |
| `onSettled` | no | Called from the module's agent_settled handler, after the backstop. |
| `verbose` | no | Log protocol decisions to stderr. Default: false. |

The returned handle exposes `proxyActive()` (true once this extension claimed the slot) and `relayed(sid)` (true once this extension queued its block as the relay for that session).

## Testing

Behavior is covered by a differential test harness (mock pi, scripted scenarios) that compares a module against a reference trace for: the proxy solo, relay in both load orders, the backstop, the `maybeRelay` fallback and its queue-failure path, the proxy guard clauses, and user messages carrying images. The harness lives outside the extension directory; the four live smoke cases (greedy in both directions, no-greedy single-extension in both directions) are the executable check against a real pi instance.

## License

GPL-3.0 (see the repository LICENSE).
