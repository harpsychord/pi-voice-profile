/**
 * pi-voice-profile extension
 *
 * Injects the voice profile document (conversational register
 * rules) into the system prompt so it is present on every model
 * request, and re-establishes it in the conversation at the
 * moments where conversation-level delivery latches best: as a
 * dedicated first turn of a new session, and as a plain user
 * message after context compaction.
 *
 * The document is self-standing: it applies on its own and yields
 * to any higher-priority instructions loaded alongside it.
 *
 * Mechanics:
 *   - Reads references/voice-profile.md from this extension's own
 *     directory, resolved relative to this file, so the extension
 *     works from any install location.
 *   - The block is a one-sentence shared directive followed by the
 *     document, identical on every delivery path (system prompt,
 *     first turn, re-injection), so the block is the same document
 *     at every moment of the conversation.
 *   - session_start (all reasons): read fresh, build the block,
 *     notify.
 *   - before_agent_start: set
 *     systemPromptOptions.sections["pi-voice-profile"] (in-place
 *     mutation; Pi diffs sections and patches only changes, so a
 *     stable block costs nothing after the first patch).
 *   - input: on the first user message of a new session (a session
 *     with no prior user entry), hold it, send the block as a
 *     dedicated turn 1, and deliver the held message as the next
 *     turn when that run settles (agent_settled).
 *   - session_compact: wait without blocking the handler's emit for
 *     the session to go idle, then send the block as a plain user
 *     message. Deduped per compaction entry. A stand-down guard
 *     keeps a compaction that lands before the re-injection reply
 *     from re-injecting again; the wait dies with the extension
 *     instance on /reload or session end.
 *   - Missing or unreadable document: loud gap marker in the
 *     prompt instead of a silent fallback.
 *
 * License: GPL-3.0 (see LICENSE).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REF_DIR = path.join(HERE, "references");

const FILE = "voice-profile.md";

// Shared directive: one sentence, identical on every delivery path
// (system prompt, first turn, re-injection), so the reply to a
// delivered block is an answer about the profile as a whole.
const DIRECTIVE =
	"Apply this voice profile to the conversation from the first reply and confirm it is active:\n\n";

const DIRECTIVE_PREFIX = "Apply this voice profile to the conversation";

interface Block {
	block: string;
	bytes: number;
	missing: boolean;
}

type ImagePart = { type: "image"; data: string; mimeType: string };

interface HeldMessage {
	text: string;
	images?: Array<ImagePart>;
	sid: string;
}

function buildBlock(): Block {
	const p = path.join(REF_DIR, FILE);
	const content = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	if (content === null) {
		return {
			block:
				`WARNING: the voice-profile document is missing (${FILE}). ` +
				`Do not pretend it is loaded. Fall back to default reply style ` +
				`and flag the gap to the user if they ask about it.\n`,
			bytes: 0,
			missing: true,
		};
	}
	const block = DIRECTIVE + content.trim() + "\n";
	return { block, bytes: Buffer.byteLength(block, "utf8"), missing: false };
}

export default function (pi: ExtensionAPI) {
	let cached: Block | null = null;
	const firstTurnDelivered = new Set<string>();
	let held: HeldMessage | null = null;
	let heldQueued = false;
	const observedSessions = new Set<string>();
	const relayedSessions = new Set<string>();
	let relayUserMsgPending = false;
	let blockDelivered = false;
	let proxyActive = false;
	const reinjectedCompactions = new Set<string>();
	let reinjectAwaitingReply = false;

	function load(fresh: boolean): Block {
		if (!cached || fresh) {
			try {
				cached = buildBlock();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				cached = {
					block:
						`WARNING: the voice-profile extension could not read its ` +
						`document (${msg}). Do not pretend it is loaded. Fall back to ` +
						`default reply style and flag the gap if it matters.\n`,
					bytes: 0,
					missing: true,
				};
			}
		}
		return cached;
	}

	pi.on("session_start", (_event, ctx) => {
		const c = load(true);
		if (!ctx.hasUI) return;
		if (!c.missing) {
			ctx.ui.notify(`Voice profile loaded: ${(c.bytes / 1024).toFixed(1)} KB (system prompt)`, "info");
		} else {
			ctx.ui.notify("Voice profile MISSING: references/voice-profile.md not found", "error");
		}
		// Relay path: only engage when the profile's own input handler did
		// NOT take the slot (proxyActive is false at session_start, before
		// any input event). Queue the profile block as a follow-up now,
		// before any input handler or agent_settled handler runs, so the
		// slot-holder's user-message delivery lands behind it in the queue.
		// Arm the relay dedupe synchronously so it catches the slot-holder's
		// delivery. If the profile's own input handler takes the slot later,
		// proxyActive becomes true and the dedupe's block-duplicate rule
		// suppresses this queued block, falling back to the proxy's own
		// delivery.
		if (c.missing) return;
		void (async () => {
			await new Promise((r) => setTimeout(r, 50));
			// If the proxy engaged in the meantime, the proxy path is fully
			// self-contained: no relay, no dedupe, no second block send.
			if (proxyActive) return;
			// Arm the relay only now, after confirming the proxy did not
			// take the slot, so the two paths never share state.
			const sid = ctx.sessionManager.getSessionId();
			relayUserMsgPending = true;
			observedSessions.add(sid);
			try {
				await pi.sendUserMessage(c.block, { deliverAs: "followUp" });
				relayedSessions.add(sid);
			} catch (err) {
				observedSessions.delete(sid);
				relayUserMsgPending = false;
				if (ctx.hasUI) ctx.ui.notify(`Voice profile: early queue failed — ${String(err)}`, "error");
			}
		})();
	});

	pi.on("before_agent_start", (event) => {
		const c = load(false);
		event.systemPromptOptions.sections["pi-voice-profile"] = c.block;
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (event.streamingBehavior !== undefined) return { action: "continue" };
		if (!event.text || !event.text.trim()) return { action: "continue" };
		const sid = ctx.sessionManager.getSessionId();
		if (firstTurnDelivered.has(sid)) return { action: "continue" };
		const hasPriorUser = (ctx.sessionManager.getEntries() as Array<{ type?: string; message?: { role?: string } }>).some(
			(e) => e && e.type === "message" && e.message && e.message.role === "user",
		);
		if (hasPriorUser) return { action: "continue" };
		firstTurnDelivered.add(sid);
		proxyActive = true;
		if (ctx.hasUI) ctx.ui.notify("Voice profile: proxying the first turn", "info");
		// Greedy proxy: this extension controls turn 1's sequence. Send the
		// profile block as the dedicated first run, then queue the user's
		// message as a follow-up so it runs right behind it. The message is
		// also held in private memory as a backstop: if the follow-up route
		// does not take (busy session, queue rejection), agent_settled
		// delivers it after the block run instead. heldQueued distinguishes
		// "queued" from "delivered" so the backstop never double-sends.
		held = { text: event.text, images: event.images as Array<ImagePart> | undefined, sid };
		// Queue the profile block first, then the user's message, both as
		// follow-ups. Queue order: block, user message. The block runs as
		// the first run, the user's message right behind it. The message
		// is also held in private memory as a backstop: if the follow-up
		// route does not take (busy session, queue rejection), agent_settled
		// delivers it after the block run instead. heldQueued distinguishes
		// "queued" from "delivered" so the backstop never double-sends.
		try {
			await pi.sendUserMessage(load(false).block, { deliverAs: "followUp" });
			if (event.images && event.images.length > 0) {
				await pi.sendUserMessage([{ type: "text", text: event.text }, ...event.images], { deliverAs: "followUp" });
			} else {
				await pi.sendUserMessage(event.text, { deliverAs: "followUp" });
			}
			heldQueued = true;
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`Voice profile: follow-up queue failed (${String(err)}); backstop delivery after the block run`, "warning");
		}
		return { action: "handled" };
	});

	function userEntries(ctx: any): Array<{ text: string; images?: Array<ImagePart> }> {
		const out: Array<{ text: string; images?: Array<ImagePart> }> = [];
		for (const e of ctx.sessionManager.getEntries() as Array<{
			type?: string;
			message?: { role?: string; content?: unknown };
		}>) {
			if (!e || e.type !== "message" || !e.message || e.message.role !== "user") continue;
			const c = e.message.content;
			if (typeof c === "string") {
				out.push({ text: c });
			} else if (Array.isArray(c)) {
				let text = "";
				const images: Array<ImagePart> = [];
				for (const p of c as Array<{ type?: string; text?: string; data?: string; mimeType?: string }>) {
					if (!p || typeof p !== "object") continue;
					if (p.type === "text" && typeof p.text === "string") text += (text ? " " : "") + p.text;
					else if (p.type === "image" && p.data && p.mimeType) images.push({ type: "image", data: p.data, mimeType: p.mimeType });
				}
				out.push({ text, images: images.length > 0 ? images : undefined });
			}
		}
		return out;
	}

	function userTexts(ctx: any): string[] {
		return userEntries(ctx).map((m) => m.text);
	}

	// Relay fallback: the input event is consumed by the first extension that
	// handles it, so when another extension proxies the first turn this
	// extension's input handler never runs and the user's message is held in
	// the slot-holder's private memory, to be delivered on the first
	// settlement. Session-level events reach every extension, so watch the
	// first settlement instead: if no user entry begins with the profile's
	// own directive prefix, the profile was never delivered, so queue the
	// profile block as a follow-up now, and take over the user's message
	// delivery via the dedupe handler below: when the slot-holder's copy of
	// the user's message arrives, suppress it and re-queue it as a fresh
	// follow-up so it lands after the profile block's run. Queue order:
	// profile block, then user message. Self-observation only; no
	// coordination with any other extension. One-shot per session; the
	// entry check also guards against re-firing after a /reload mid-session.
	function maybeRelay(ctx: any) {
		const sid = ctx.sessionManager.getSessionId();
		if (observedSessions.has(sid) || relayedSessions.has(sid)) return;
		const entries = userEntries(ctx);
		if (entries.some((m) => m.text.trimStart().startsWith(DIRECTIVE_PREFIX))) return;
		// The session must have reached its first run; a settled session with
		// no user entries yet is not a stolen slot, just a quiet one.
		if (entries.length === 0) return;
		observedSessions.add(sid);
		// Arm the dedupe synchronously, before the async send, so the
		// slot-holder's delivery is caught even if it arrives before the
		// profile block's send completes.
		relayUserMsgPending = true;
		if (ctx.hasUI)
			ctx.ui.notify(
				"Voice profile: first turn taken by another extension; relaying user message after profile block",
				"info",
			);
		void (async () => {
			try {
				await pi.sendUserMessage(load(false).block, { deliverAs: "followUp" });
				relayedSessions.add(sid);
			} catch (err) {
				observedSessions.delete(sid);
				if (ctx.hasUI) ctx.ui.notify(`Voice profile: relay failed — ${String(err)}`, "error");
			}
		})();
	}
	// Settle-time relay for the user's message: the slot-holder delivers
	// the user's message from the first settlement. That delivery arrives
	// as a source:"extension" input event carrying text that is not the
	// profile block. Catch it by elimination: after the relay arms
	// (relayUserMsgPending), the first extension-sourced input that is not
	// the profile block is the slot-holder's delivery of the user's
	// original message. Suppress it and re-queue it as a fresh follow-up;
	// the profile block is already ahead of it in the queue, so the
	// user's message lands last, exactly once.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") return { action: "continue" };
		if (proxyActive) return { action: "continue" };
		const t = (event.text ?? "").trim();
		if (!t) return { action: "continue" };
		if (!relayUserMsgPending) return { action: "continue" };
		// The profile block itself, if it loops back through the input
		// pipeline, is not the user's message.
		if (t.trimStart().startsWith(DIRECTIVE_PREFIX)) {
			// The profile block: allow the first delivery, suppress duplicates are
			// suppressed here.
			if (blockDelivered) {
				if (ctx.hasUI) ctx.ui.notify("Voice profile: suppressing duplicate profile block", "info");
				return { action: "handled" };
			}
			blockDelivered = true;
			return { action: "continue" };
		}
		relayUserMsgPending = false;
		if (ctx.hasUI) ctx.ui.notify("Voice profile: relaying first user message after profile block", "info");
		if (event.images && event.images.length > 0) {
			await pi.sendUserMessage([{ type: "text", text: event.text }, ...event.images], { deliverAs: "followUp" });
		} else {
			await pi.sendUserMessage(event.text, { deliverAs: "followUp" });
		}
		return { action: "handled" };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (held && held.sid === ctx.sessionManager.getSessionId() && !heldQueued) {
			const m = held;
			held = null;
			if (m.images && m.images.length > 0) {
				await pi.sendUserMessage([{ type: "text", text: m.text }, ...m.images]);
			} else {
				await pi.sendUserMessage(m.text);
			}
		}
		if (reinjectAwaitingReply) reinjectAwaitingReply = false;
		maybeRelay(ctx);
	});

	pi.on("session_compact", async (event, ctx) => {
		const c = load(false);
		if (c.missing) return;
		if (reinjectAwaitingReply) {
			if (ctx.hasUI)
				ctx.ui.notify(
				"Voice profile: compaction before re-injection reply — standing down for this cycle",
				"warning",
			);
			return;
		}
		const entry = (event as { compactionEntry?: { id?: string; timestamp?: string } }).compactionEntry;
		const entryId = entry?.id ?? entry?.timestamp ?? `anon-${Date.now()}`;
		if (reinjectedCompactions.has(entryId)) return;
		reinjectedCompactions.add(entryId);
		reinjectAwaitingReply = true;
		if (ctx.hasUI) ctx.ui.notify("Voice profile: context compacted — profile re-injection pending", "info");
		void (async () => {
			while (!ctx.isIdle?.()) {
				await new Promise((r) => setTimeout(r, 50));
			}
			try {
				await pi.sendUserMessage(c.block);
			} catch (err) {
				reinjectedCompactions.delete(entryId);
				reinjectAwaitingReply = false;
				if (ctx.hasUI) ctx.ui.notify(`Voice profile: re-injection failed — ${String(err)}`, "error");
			}
		})();
	});
}
