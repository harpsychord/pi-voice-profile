# Tests for first-turn-relay

Two independent verification levels, both runnable from this directory:

## Differential test (no pi needed)

`harness.mjs` runs ten scripted scenarios against a module using a fake pi
that models input dispatch, the follow-up queue, and session entries, then
compares the observable trace (handshake entries appended, messages sent, in
order) against the reference baseline in `oracle/baseline.json`.

```
npm install        # installs esbuild, the only dependency
node harness.mjs   # tests ../first-turn-relay.ts against the baseline
```

The scenarios cover: the proxy solo, the relay in both load orders, the
backstop delivery, the maybeRelay fallback and its queue-failure path, the
proxy guard clauses, and user messages carrying images.

`oracle/` contains the reference material:

- `first-turn-relay.original.ts` — the original implementation (commit
  `07c4a10`), kept as the behavioral oracle.
- `baseline.json` — the reference trace, generated from the original and
  validated against the current module.

To regenerate the baseline after a reviewed, intentional behavior change:

```
node harness.mjs --regenerate-baseline ../first-turn-relay.ts
```

Do not regenerate the baseline to make a mismatch go away; a mismatch means
the module under test behaves differently from the recorded protocol.

## Live smoke test (needs a real pi)

`smoke.mjs` runs a real pi session in RPC mode with one or two extensions
that use the module, sends a prompt, and verifies the transcript: the
slot-holder handshake entry (plus exactly one relay entry for two
extensions), the block(s) in load order, the prompt last and exactly once,
and an assistant reply between each pair of user messages.

```
node smoke.mjs <extension1.ts> [extension2.ts] [--prompt "text"]
```

The paths are extension entry points (files with a default-exported factory
that calls `createFirstTurnRelay`). With one extension it checks the
no-relay shape; with two, the full protocol in load order. The session makes
real model calls, so a working pi and model access are required. No other
dependencies.

The standard matrix is the four combinations of the two bundled extensions,
in both load orders and singly:

```
node smoke.mjs <vera-guidance entry point>
node smoke.mjs <voice-profile entry point>
node smoke.mjs <vera-guidance entry point> <voice-profile entry point>
node smoke.mjs <voice-profile entry point> <vera-guidance entry point>
```

All four exiting 0 is the full live check.
