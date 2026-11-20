// Differential test harness for first-turn-relay.ts
//
// Runs scripted scenarios against a module using a fake pi (a scripted
// "world" that models pi's input dispatch, follow-up queue, and session
// entries), records observable traces (entries appended, messages sent,
// in order), and compares them against the reference baseline in
// oracle/baseline.json. The baseline was generated from the original
// implementation (oracle/first-turn-relay.original.ts, commit 07c4a10)
// and validated against the refactored module.
//
// Usage (from this directory, after `npm install`):
//   node harness.mjs [module.ts]
//     Runs the scenarios against module.ts (default: ../first-turn-relay.ts)
//     and compares the trace against oracle/baseline.json.
//     Exits 0 on a full match, 1 otherwise.
//
//   node harness.mjs --regenerate-baseline module.ts
//     Runs the scenarios against module.ts and writes the resulting trace
//     to oracle/baseline.json. Only do this after a change that has been
//     reviewed as an intentional behavior change.
//
// Requirements: Node >= 18, esbuild (npm install in this directory).
// The live smoke tests are separate (smoke.mjs) and need a real pi.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, "oracle", "baseline.json");

const [,, arg1, arg2] = process.argv;
const regenerate = arg1 === "--regenerate-baseline";
const modulePath = path.resolve(regenerate ? arg2 : (arg1 ?? path.join(HERE, "..", "first-turn-relay.ts")));

// --- transpile the module under test ---------------------------------------

async function loadModule(file) {
	try {
		const esbuild = await import("esbuild");
		const src = fs.readFileSync(file, "utf8");
		const { code } = esbuild.transformSync(src, { loader: "ts", format: "esm" });
		const out = path.join(
			os.tmpdir(),
			`ft-relay-test-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`,
		);
		fs.writeFileSync(out, code);
		const mod = await import(out);
		fs.rmSync(out, { force: true });
		return mod.createFirstTurnRelay;
	} catch (err) {
		console.error(`failed to load module ${file}: ${String(err)}`);
		console.error("make sure you ran `npm install` in this directory (esbuild is required)");
		process.exit(1);
	}
}

// --- the fake pi world ------------------------------------------------------

const HANDSHAKE = "relay-handshake";

function makeWorld() {
	const entries = [];
	const globalInput = []; // {pi, fn} in registration order
	const followUps = [];
	const trace = [];

	const session = {
		sid: `sid-${Math.random().toString(36).slice(2)}`,
		manager: {
			getSessionId: () => session.sid,
			getEntries: () => entries.slice(),
		},
		appendCustom: (type, data) => entries.push({ type: "custom", customType: type, data }),
		addUser: (text) => entries.push({ type: "message", message: { role: "user", content: text } }),
	};

	function makePi({ failSend } = {}) {
		const own = { session_start: [], agent_settled: [] };
		const pi = {
			failSend,
			on: (type, fn) => {
				if (type === "input") globalInput.push({ pi, fn });
				else own[type].push(fn);
			},
			appendEntry: (type, data) => {
				session.appendCustom(type, data);
				trace.push({ op: "entry", type, data });
			},
			sendUserMessage: async (msg, opts) => {
				trace.push({ op: "send", msg, opts: opts ?? {} });
				if (pi.failSend) {
					const n = pi.failSend();
					if (n > 0) throw new Error(`send failed (scenario)`);
				}
				if (opts?.deliverAs === "followUp") followUps.push({ msg, opts });
			},
		};
		pi.ctx = { sessionManager: session.manager, hasUI: false, isIdle: () => true };
		pi.fireSessionStart = async () => {
			for (const fn of own.session_start) await fn({}, pi.ctx);
		};
		pi.fireAgentSettled = async () => {
			for (const fn of own.agent_settled) await fn({}, pi.ctx);
		};
		return pi;
	}

	async function dispatchInput(event) {
		for (const { pi, fn } of globalInput) {
			const r = await fn(event, pi.ctx);
			if (r && r.action === "handled") return "handled";
		}
		return "passed";
	}

	async function flushFollowUps() {
		while (followUps.length > 0) {
			const item = followUps.shift();
			const text = typeof item.msg === "string" ? item.msg : (item.msg.find((p) => p.type === "text")?.text ?? "");
			const images = typeof item.msg === "string" ? undefined : item.msg.filter((p) => p.type === "image");
			await dispatchInput({ source: "extension", text, images, streamingBehavior: undefined });
		}
	}

	return { session, makePi, dispatchInput, flushFollowUps, trace, followUps };
}

function normalizeTrace(trace) {
	return trace.map((t) => {
		if (t.op === "entry") {
			const data = { ...t.data };
			if (typeof data.sid === "string") data.sid = "SID";
			return { op: "entry", type: t.type, data };
		}
		const isParts = Array.isArray(t.msg);
		return {
			op: "send",
			kind: isParts ? "parts" : "text",
			text: isParts ? t.msg.map((p) => (p.type === "image" ? { image: true } : p.text)) : t.msg,
			deliverAs: t.opts.deliverAs ?? null,
		};
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- scenarios ---------------------------------------------------------------

// S1: single extension, its proxy takes the slot, no relay.
async function s1ProxySolo(mod) {
	const w = makeWorld();
	const pi = w.makePi();
	mod(pi, { label: "P1", directivePrefix: "P1 directive", block: () => "P1 directive block" });
	await pi.fireSessionStart();
	await sleep(20);
	const r = await w.dispatchInput({ source: "user", text: "hello", streamingBehavior: undefined });
	await sleep(200);
	return { results: [r], trace: normalizeTrace(w.trace) };
}

// S2: A (loaded first) takes the slot, B relays; includes a duplicate
// delivery of B's own block after the flush (dedupe suppression window).
async function s2Relay(mod, labels) {
	const w = makeWorld();
	const [first, second] = labels;
	const p1 = w.makePi();
	const p2 = w.makePi();
	const mk = (pi, label, prefix, blk) => mod(pi, { label, directivePrefix: prefix, block: () => blk });
	if (first === "A") { mk(p1, "A", "A directive", "A directive block"); mk(p2, "B", "B directive", "B directive block"); }
	else { mk(p2, "B", "B directive", "B directive block"); mk(p1, "A", "A directive", "A directive block"); }
	const slotPi = first === "A" ? p1 : p2;
	const relayPi = first === "A" ? p2 : p1;
	await slotPi.fireSessionStart();
	await relayPi.fireSessionStart();
	await sleep(20);
	const r = await w.dispatchInput({ source: "user", text: "hello", streamingBehavior: undefined });
	await sleep(200);
	await w.flushFollowUps();
	const relayPrefix = first === "A" ? "B directive block" : "A directive block";
	const r2 = await w.dispatchInput({ source: "extension", text: relayPrefix, streamingBehavior: undefined });
	await sleep(200);
	return { results: [r, r2], trace: normalizeTrace(w.trace) };
}

async function s8NewIdle(mod, labels) {
	const w = makeWorld();
	const pi = w.makePi();
	for (const n of labels) {
		mod(pi, { label: n, directivePrefix: n + " directive", block: () => n + " directive block" });
	}
	await pi.fireSessionStart();
	// /new case: the first message arrives well after session_start,
	// when the old 350ms relay poll would have fired into the empty session.
	await sleep(1000);
	const r = await w.dispatchInput({ source: "user", text: "hello", streamingBehavior: undefined });
	await sleep(500);
	return { results: [r], trace: normalizeTrace(w.trace) };
}

// S3: backstop. The proxy's follow-up queue fails for the block; on
// agent_settled (no relay, nothing held-queued) the held user message is
// delivered plainly.
async function s3Backstop(mod) {
	let failsLeft = 1;
	const w = makeWorld();
	const pi = w.makePi({ failSend: () => { if (failsLeft > 0) { failsLeft--; return 1; } return 0; } });
	mod(pi, { label: "P1", directivePrefix: "P1 directive", block: () => "P1 directive block" });
	await pi.fireSessionStart();
	await sleep(20);
	const r = await w.dispatchInput({ source: "user", text: "hello", streamingBehavior: undefined });
	await sleep(200);
	await pi.fireAgentSettled();
	await sleep(200);
	return { results: [r], trace: normalizeTrace(w.trace) };
}

// S4: maybeRelay fallback — a non-protocol slot-holder already used the
// first turn; the relay path arms at session_start and queues the block.
async function s4MaybeRelay(mod, seed) {
	const w = makeWorld();
	const pi = w.makePi();
	mod(pi, { label: "P1", directivePrefix: "P1 directive", block: () => "P1 directive block" });
	if (seed) w.session.addUser(seed);
	await pi.fireSessionStart();
	await sleep(700); // relay poll (350ms) sees no proxy -> announces + queues
	const r = await w.dispatchInput({ source: "user", text: "hello", streamingBehavior: undefined });
	await pi.fireAgentSettled();
	await sleep(200);
	return { results: [r], trace: normalizeTrace(w.trace) };
}

// S5: proxy guard clauses — streamingBehavior, blank text, second message
// in an already-claimed session all pass through untouched.
async function s5Guards(mod) {
	const w = makeWorld();
	const pi = w.makePi();
	mod(pi, { label: "P1", directivePrefix: "P1 directive", block: () => "P1 directive block" });
	await pi.fireSessionStart();
	await sleep(20);
	const r1 = await w.dispatchInput({ source: "user", text: "streaming", streamingBehavior: "pause" });
	const r2 = await w.dispatchInput({ source: "user", text: "   ", streamingBehavior: undefined });
	const r3 = await w.dispatchInput({ source: "user", text: "hello", streamingBehavior: undefined });
	await sleep(200);
	await w.flushFollowUps();
	const r4 = await w.dispatchInput({ source: "user", text: "again", streamingBehavior: undefined });
	await sleep(200);
	return { results: [r1, r2, r3, r4], trace: normalizeTrace(w.trace) };
}

// S6: like S2 but the user's message carries an image part.
async function s6RelayWithImage(mod) {
	const w = makeWorld();
	const p1 = w.makePi();
	const p2 = w.makePi();
	mod(p1, { label: "A", directivePrefix: "A directive", block: () => "A directive block" });
	mod(p2, { label: "B", directivePrefix: "B directive", block: () => "B directive block" });
	const img = { type: "image", data: "AAAA", mimeType: "image/png" };
	await p1.fireSessionStart();
	await p2.fireSessionStart();
	await sleep(20);
	const r = await w.dispatchInput({ source: "user", text: "hello", images: [img], streamingBehavior: undefined });
	await sleep(200);
	await w.flushFollowUps();
	await sleep(200);
	return { results: [r], trace: normalizeTrace(w.trace) };
}

// S7: maybeRelay queue failure. blockReady is off so the relay path never
// arms; a non-protocol slot-holder seeded the session. On agent_settled the
// fallback queues, the queue fails, observed is cleared (so the fallback
// retries on the next settlement), and -- quirk of the original code, kept
// as oracle -- awaitingUserMsg is left true, so a later extension-source
// input matching nothing is re-queued anyway.
async function s7MaybeRelayFail(mod) {
	const w = makeWorld();
	const pi = w.makePi({ failSend: () => 1 });
	mod(pi, { label: "P1", directivePrefix: "P1 directive", block: () => "P1 directive block", blockReady: () => false });
	w.session.addUser("hi there");
	await pi.fireSessionStart();
	await sleep(500);
	await pi.fireAgentSettled();
	await sleep(200);
	const r1 = await w.dispatchInput({ source: "extension", text: "zzz", streamingBehavior: undefined });
	await sleep(200);
	await pi.fireAgentSettled();
	await sleep(200);
	return { results: [r1], trace: normalizeTrace(w.trace) };
}

const SCENARIOS = [
	["S1 proxy solo", s1ProxySolo],
	["S2 A proxy / B relay", (m) => s2Relay(m, ["A", "B"])],
	["S2b B proxy / A relay", (m) => s2Relay(m, ["B", "A"])],
	["S3 backstop", s3Backstop],
	["S4 maybeRelay (seeded)", (m) => s4MaybeRelay(m, "hi there")],
	["S8 /new idle then message", (m) => s8NewIdle(m, ["A", "B"])],
	["S4b maybeRelay (own block seed)", (m) => s4MaybeRelay(m, "P1 directive something")],
	["S4c maybeRelay (no seed)", (m) => s4MaybeRelay(m, null)],
	["S5 guard clauses", s5Guards],
	["S6 relay with image", s6RelayWithImage],
	["S7 maybeRelay failure", s7MaybeRelayFail],
];

// --- runner -------------------------------------------------------------------

const createFirstTurnRelay = await loadModule(modulePath);
if (typeof createFirstTurnRelay !== "function") {
	console.error(`module does not export createFirstTurnRelay: ${modulePath}`);
	process.exit(1);
}

const out = {};
for (const [name, fn] of SCENARIOS) {
	try {
		out[name] = await fn(createFirstTurnRelay);
	} catch (err) {
		out[name] = { error: String(err) };
	}
}

if (regenerate) {
	fs.writeFileSync(BASELINE, JSON.stringify(out, null, 1) + "\n");
	console.log(`baseline regenerated from ${modulePath} -> ${BASELINE}`);
	process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
let allMatch = true;
for (const name of Object.keys(baseline)) {
	const mine = out[name];
	if (!mine) {
		console.log(`FAIL  ${name}: missing from run results`);
		allMatch = false;
		continue;
	}
	if (JSON.stringify(mine) === JSON.stringify(baseline[name])) {
		console.log(`PASS  ${name}`);
	} else {
		allMatch = false;
		console.log(`FAIL  ${name}`);
		console.log(`      expected: ${JSON.stringify(baseline[name]).slice(0, 300)}`);
		console.log(`      actual:   ${JSON.stringify(mine).slice(0, 300)}`);
	}
}
console.log(allMatch ? "\nALL SCENARIOS MATCH" : "\nDIFFERENCES FOUND");
process.exit(allMatch ? 0 : 1);
