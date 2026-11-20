// Live smoke test for the first-turn relay protocol.
//
// Runs a real pi session (RPC mode) with one or two extensions that use
// first-turn-relay.ts, sends one user prompt, and verifies the session
// transcript:
//
//   - one relay-handshake slot-holder entry, and exactly one relay entry
//     when two extensions are loaded
//   - the end
//   - user messages, in order: first extension's block, (second extension's
//     block), the prompt — the prompt last, exactly once
//   - at least one assistant reply between consecutive user messages
//     (each block got its dedicated confirmed turn)
//
// Usage (from this directory):
//   node smoke.mjs <extension1.ts> [extension2.ts] [--prompt "text"]
//
// The extension paths are entry points (a file with a default-exported
// factory that calls createFirstTurnRelay). With one extension the test
// checks the no-relay shape; with two, the full protocol in load order.
//
// Requirements: Node >= 18, a working pi on PATH (the session makes real
// model calls). No other dependencies.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

function parseArgs(argv) {
	const exts = [];
	let prompt = "Say hello in one short sentence.";
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--prompt") prompt = argv[++i];
		else exts.push(argv[i]);
	}
	if (exts.length < 1 || exts.length > 2) {
		console.error("usage: node smoke.mjs <extension1.ts> [extension2.ts] [--prompt \"text\"]");
		process.exit(2);
	}
	for (const e of exts) {
		if (!fs.existsSync(e)) {
			console.error(`extension not found: ${e}`);
			process.exit(2);
		}
	}
	return { exts, prompt };
}

function userText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
			.map((p) => p.text)
			.join(" ");
	}
	return "";
}

function transcript(sessionFile) {
	const lines = fs.readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim());
	const out = { user: [], assistant: [], handshake: [], raw: [] };
	for (const line of lines) {
		let e;
		try { e = JSON.parse(line); } catch { continue; }
		out.raw.push(e);
		const m = e.message;
		if (m && m.role === "user") out.user.push(userText(m.content).trim());
		else if (m && m.role === "assistant") out.assistant.push(true);
		if (e.customType === "relay-handshake" && e.data) out.handshake.push(e.data);
	}
	return out;
}

async function run() {
	const { exts, prompt } = parseArgs(process.argv.slice(2));
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "ft-relay-smoke-"));
	const sessDir = path.join(work, "sessions");
	const cwd = path.join(work, "work");
	fs.mkdirSync(sessDir);
	fs.mkdirSync(cwd);

	const args = ["--mode", "rpc", "--session-dir", sessDir, "--name", "ft-smoke",
		"--no-extensions", "-e", exts[0]];
	if (exts[1]) args.push("-e", exts[1]);

	const proc = spawn("pi", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
	const stderr = [];
	proc.stderr.on("data", (d) => stderr.push(d));

	const queue = [];
	const waiters = [];
	proc.stdout.on("data", (d) => {
		for (const line of d.toString().split("\n")) {
			if (!line.trim()) continue;
			let e;
			try { e = JSON.parse(line); } catch { continue; }
			if (waiters.length) waiters.shift()(e);
			else queue.push(e);
		}
	});
	function next() {
		if (queue.length) return Promise.resolve(queue.shift());
		return new Promise((r) => waiters.push(r));
	}

	const id = `smoke-${Date.now()}`;
	proc.stdin.write(JSON.stringify({ type: "prompt", id, message: prompt }) + "\n");

	const expectedSettled = exts.length === 2 ? 3 : 2;
	const deadline = Date.now() + 90_000;
	let settled = 0;
	let response = false;
	let fail = null;
	try {
		while (Date.now() < deadline && (settled < expectedSettled || !response)) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			const e = await Promise.race([
				next(),
				new Promise((r) => setTimeout(() => r({ type: "__timeout__" }), remaining)),
			]);
			if (e.type === "response" && e.id === id) response = true;
			if (e.type === "agent_settled") settled++;
			if (e.type === "error") fail = e;
		}
	} finally {
		proc.kill("SIGTERM");
	}

	const sessionFiles = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter((f) => f.endsWith(".jsonl")) : [];
	if (sessionFiles.length === 0) {
		console.error(`FAIL: no session file written. pi stderr tail:\n${stderr.join("").toString().slice(-2000)}`);
		process.exit(1);
	}
	const sessionFile = path.join(sessDir, sessionFiles.sort().at(-1));
	const t = transcript(sessionFile);

	const errors = [];
	const holders = t.handshake.filter((h) => h.role === "slot-holder");
	const relays = t.handshake.filter((h) => h.role === "relay");
	if (holders.length !== 1) errors.push(`expected 1 slot-holder handshake entry, got ${holders.length}`);
	const expectedRelays = exts.length === 2 ? 1 : 0;
	if (relays.length !== expectedRelays) errors.push(`expected ${expectedRelays} relay handshake entries, got ${relays.length}`);

	const expectedUserCount = exts.length === 2 ? 3 : 2;
	if (t.user.length !== expectedUserCount) {
		errors.push(`expected ${expectedUserCount} user messages, got ${t.user.length}: ${JSON.stringify(t.user.map((u) => u.slice(0, 60)))}`);
	}
	const promptCount = t.user.filter((u) => u === prompt.trim()).length;
	if (promptCount !== 1) errors.push(`expected the prompt exactly once among user messages, got ${promptCount}`);
	if (t.user.length > 0 && t.user[t.user.length - 1] !== prompt.trim()) errors.push("the prompt is not the last user message");
	for (let i = 0; i < t.user.length - 1; i++) {
		if (t.user[i] === prompt.trim()) errors.push(`user message ${i + 1} (a block position) equals the prompt`);
	}
	if (t.assistant.length < t.user.length - 1) {
		errors.push(`expected an assistant reply between each pair of user messages; assistant count ${t.assistant.length} < ${t.user.length - 1}`);
	}
	if (fail) errors.push(`pi reported an error: ${JSON.stringify(fail).slice(0, 300)}`);

	console.log(`session: ${sessionFile}`);
	console.log(`user messages (${t.user.length}):`);
	t.user.forEach((u, i) => console.log(`  ${i + 1}. ${u.slice(0, 80)}`));
	if (errors.length === 0) {
		console.log(exts.length === 2 ? "PASS: slot-holder block, relay block, prompt last, each exactly once" : "PASS: block, prompt last, each exactly once");
		process.exit(0);
	} else {
		for (const e of errors) console.error(`FAIL: ${e}`);
		if (settled < expectedSettled) console.error(`note: only ${settled}/${expectedSettled} agent_settled events observed`);
		process.exit(1);
	}
}

run().catch((err) => {
	console.error(`FAIL: ${String(err)}`);
	process.exit(1);
});
