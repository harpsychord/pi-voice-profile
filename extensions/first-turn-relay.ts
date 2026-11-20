/**
 * first-turn-relay.ts
 *
 * First-turn slot protocol for pi extensions. The extension whose input
 * handler takes the first user message of a new session becomes the
 * slot-holder and delivers its block first; the others announce as
 * relays and deliver their blocks; the user's original message lands
 * last, exactly once.
 *
 * Coordination is through custom session entries only — extensions do
 * not import each other or share memory:
 *   slot-holder: { customType: "relay-handshake", data: { role: "slot-holder", sid, userMsg } }
 *   relay:       { customType: "relay-handshake", data: { role: "relay", sid } }
 *
 * See README.md for the full protocol, timing, and adoption guide.
 *
 * License: GPL-3.0.
 */

import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";

export const HANDSHAKE_TYPE = "relay-handshake";

export type HandshakeRole = "slot-holder" | "relay";

export interface HandshakeData {
	role: HandshakeRole;
	sid: string;
	/** Slot-holder entries only: the user's original message text, trimmed. */
	userMsg?: string;
}

/** Timing knobs, all small relative to a model turn. */
export const TIMING = {
	/** Relay: attempts x ms of polling to see whether its own proxy took the slot. */
	relayPollAttempts: 7,
	relayPollMs: 50,
	/** Slot-holder: attempts x ms of waiting for a relay to announce. */
	proxyRelayWaitAttempts: 9,
	proxyRelayWaitMs: 50,
	/** Slot-holder: settle delay once a relay has announced. */
	proxyRelaySettleMs: 150,
} as const;

export interface FirstTurnRelayConfig {
	/** Short label for UI notifications, e.g. "Vera guidance". */
	label: string;
	/** Prefix identifying this extension's own block text, for dedupe. */
	directivePrefix: string;
	/** Returns the block text to inject on the first turn. */
	block: () => string;
	/** When false, the relay path stays off for this session. Default: true. */
	blockReady?: () => boolean;
	/** Called from the module's session_start handler, before the relay path arms. */
	onSessionStart?: (ctx: ExtensionContext) => void;
	/** Called from the module's agent_settled handler, after the backstop. */
	onSettled?: (ctx: ExtensionContext) => void;
	/** Log protocol decisions to stderr. Default: false. */
	verbose?: boolean;
}

export interface FirstTurnRelayHandle {
	/** True once this extension claimed the first-turn slot. */
	proxyActive: () => boolean;
	/** True once this extension queued its block as the relay for sid. */
	relayed: (sid: string) => boolean;
}

interface ImagePart {
	type: "image";
	data: string;
	mimeType: string;
}

interface Entry {
	customType?: string;
	data?: HandshakeData;
	type?: string;
	message?: { role?: string; content?: unknown };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, attempts: number, ms: number): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		await sleep(ms);
		if (pred()) return true;
	}
	return false;
}

export function createFirstTurnRelay(
	pi: ExtensionAPI,
	config: FirstTurnRelayConfig,
): FirstTurnRelayHandle {
	const log = config.verbose
		? (...args: unknown[]) => console.error(`[first-turn-relay:${config.label}]`, ...args)
		: () => {};

	function notify(ctx: ExtensionContext, kind: "info" | "warning" | "error", message: string) {
		if (ctx.hasUI) ctx.ui.notify(message, kind);
	}

	const claimed = new Set<string>(); // sessions whose first message this extension took
	const observed = new Set<string>(); // sessions whose relay path has started
	const relayed = new Set<string>(); // sessions whose relay block was queued
	let pending: { text: string; images?: ImagePart[]; sid: string; queued: boolean } | null = null;
	let awaitingUserMsg = false;
	let blockDelivered = false;
	let proxyActive = false;
	let slotHolderUserMsg = "";

	function readEntries(ctx: ExtensionContext): Entry[] {
		try {
			return ctx.sessionManager.getEntries() as Entry[];
		} catch {
			return [];
		}
	}

	const isHandshake = (e: Entry) => !!e && e.customType === HANDSHAKE_TYPE && !!e.data;
	function slotHolderEntry(ctx: ExtensionContext): Entry | undefined {
		return readEntries(ctx).find((e) => isHandshake(e) && e.data!.role === "slot-holder");
	}
	function hasRelay(ctx: ExtensionContext): boolean {
		return readEntries(ctx).some((e) => isHandshake(e) && e.data!.role === "relay");
	}
	function userEntryTexts(ctx: ExtensionContext): string[] {
		const out: string[] = [];
		for (const e of readEntries(ctx)) {
			if (!e || e.type !== "message" || !e.message || e.message.role !== "user") continue;
			const c = e.message.content;
			if (typeof c === "string") {
				out.push(c);
			} else if (Array.isArray(c)) {
				const parts = (c as Array<{ type?: string; text?: string }>)
					.filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
					.map((p) => p.text);
				out.push(parts.join(" "));
			}
		}
		return out;
	}

	function announce(ctx: ExtensionContext, data: HandshakeData) {
		try {
			pi.appendEntry(HANDSHAKE_TYPE, data);
			log("announced", JSON.stringify(data));
		} catch (e) {
			log("announce FAILED:", String(e));
		}
	}

	// Send text (plus optional images), optionally as a follow-up.
	async function deliver(text: string, images: ImagePart[] | undefined, deliverAs?: "followUp") {
		const opts = deliverAs ? { deliverAs } : undefined;
		if (images && images.length > 0) {
			await pi.sendUserMessage([{ type: "text", text }, ...images] as never, opts);
		} else {
			await pi.sendUserMessage(text, opts);
		}
	}

	// Queue this extension's block as a follow-up. True if it went in.
	async function queueRelayBlock(sid: string): Promise<boolean> {
		try {
			await deliver(config.block(), undefined, "followUp");
			relayed.add(sid);
			return true;
		} catch (err) {
			log("relay block queue failed:", String(err));
			return false;
		}
	}

	// Slot-holder path: claim the first user message of a new session.
	// Only the extension whose input handler runs first in registration
	// order reaches the claim; 'handled' short-circuits dispatch.
	async function claimSlot(event: InputEvent, ctx: ExtensionContext): Promise<"handled" | "continue"> {
		if (event.streamingBehavior !== undefined) return "continue";
		if (!event.text || !event.text.trim()) return "continue";
		const sid = ctx.sessionManager.getSessionId();
		if (claimed.has(sid) || userEntryTexts(ctx).length > 0) return "continue";
		claimed.add(sid);
		proxyActive = true;
		log("proxy engaged, sid =", sid);
		notify(ctx, "info", `${config.label}: proxying the first turn`);
		announce(ctx, { role: "slot-holder", sid, userMsg: event.text.trim() });
		pending = { text: event.text, images: event.images as ImagePart[] | undefined, sid, queued: false };
		try {
			await deliver(config.block(), undefined, "followUp");
			// A relay announces at session_start + ~350ms and queues its
			// block right after, so a short settle puts the user message
			// behind the relay's block in the follow-up queue.
			const relayAnnounced = await waitUntil(() => hasRelay(ctx), TIMING.proxyRelayWaitAttempts, TIMING.proxyRelayWaitMs);
			if (relayAnnounced) await sleep(TIMING.proxyRelaySettleMs);
			log("queueing user message, relayAnnounced =", relayAnnounced);
			await deliver(event.text, event.images as ImagePart[] | undefined, "followUp");
			pending.queued = true;
		} catch (err) {
			log("follow-up queue failed:", String(err));
			notify(ctx, "warning", `${config.label}: follow-up queue failed (${String(err)}); backstop delivery after the block run`);
		}
		return "handled";
	}

	// Relay path: if this extension's proxy did not take the slot,
	// announce and queue the block. The dedupe below then re-queues the
	// slot-holder's delivery of the user's message behind it.
	function relayPath(ctx: ExtensionContext) {
		// A session that already has user messages is a resume or a
		// reload, not a new session; its first turn is in the transcript.
		if (userEntryTexts(ctx).length > 0) {
			log("relay path off: session already has user entries");
			return;
		}
		void (async () => {
			// Wait for the first user message instead of betting on a
			// timer: /new and a slow first reply must not get blocks
			// injected into an empty session. No deadline; the wait
			// dies with the instance on reload or session end.
			while (!proxyActive && userEntryTexts(ctx).length === 0) {
				await sleep(TIMING.relayPollMs);
			}
			if (proxyActive) return;
			// A non-protocol slot-holder took the turn; the maybeRelay
			// fallback picks this up at the first settlement.
			if (!slotHolderEntry(ctx)) return;
			const sid = ctx.sessionManager.getSessionId();
			observed.add(sid);
			awaitingUserMsg = true;
			const holder = slotHolderEntry(ctx);
			slotHolderUserMsg = holder && typeof holder.data.userMsg === "string" ? holder.data.userMsg : "";
			announce(ctx, { role: "relay", sid });
			if (!await queueRelayBlock(sid)) {
				observed.delete(sid);
				awaitingUserMsg = false;
				notify(ctx, "error", `${config.label}: early queue failed`);
			} else {
				log("relay block queued, sid =", sid);
			}
		})();
	}

	// Dedupe path: follow-ups loop back through the input pipeline as
	// extension-source inputs. Re-queue exactly the slot-holder's
	// announced user message so it lands behind this extension's block;
	// the relay's own block passes once (while the user message is still
	// pending) and is suppressed on duplicates; anything else passes
	// through untouched.
	async function dedupe(event: InputEvent, ctx: ExtensionContext): Promise<"handled" | "continue"> {
		if (proxyActive) return "continue";
		const t = (event.text ?? "").trim();
		if (!t || !awaitingUserMsg) return "continue";
		if (t.startsWith(config.directivePrefix)) {
			if (blockDelivered) {
				notify(ctx, "info", `${config.label}: suppressing duplicate block`);
				return "handled";
			}
			blockDelivered = true;
			return "continue";
		}
		if (slotHolderUserMsg && t !== slotHolderUserMsg) return "continue";
		awaitingUserMsg = false;
		notify(ctx, "info", `${config.label}: relaying first user message after block`);
		try {
			await deliver(event.text ?? "", event.images as ImagePart[] | undefined, "followUp");
		} catch (err) {
			log("dedupe re-queue failed:", String(err));
		}
		return "handled";
	}

	// Fallback for slot-holders that do not implement the protocol: on
	// the first settlement of a session whose first turn went elsewhere,
	// queue this extension's block after that run.
	function maybeRelay(ctx: ExtensionContext) {
		const sid = ctx.sessionManager.getSessionId();
		if (observed.has(sid) || relayed.has(sid) || proxyActive) return;
		const texts = userEntryTexts(ctx);
		if (texts.some((t) => t.trimStart().startsWith(config.directivePrefix))) return;
		// A settled session with no user entries yet is quiet, not stolen.
		if (texts.length === 0) return;
		observed.add(sid);
		awaitingUserMsg = true;
		notify(ctx, "info", `${config.label}: first turn taken by another extension; relaying after its block`);
		void (async () => {
			// On failure the observed mark is cleared so the fallback can
			// retry on a later settlement; awaitingUserMsg is left as-is.
			if (!await queueRelayBlock(sid)) {
				observed.delete(sid);
				notify(ctx, "error", `${config.label}: relay failed`);
			}
		})();
	}

	pi.on("input", async (event: InputEvent, ctx: ExtensionContext) => {
		const action = event.source === "extension" ? await dedupe(event, ctx) : await claimSlot(event, ctx);
		return action === "handled" ? { action: "handled" } : { action: "continue" };
	});

	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		config.onSessionStart?.(ctx);
		if (config.blockReady && !config.blockReady()) {
			log("relay path off: block not ready");
			return;
		}
		log("relay path entering, proxyActive =", proxyActive);
		relayPath(ctx);
	});

	pi.on("agent_settled", async (_event: unknown, ctx: ExtensionContext) => {
		const sid = ctx.sessionManager.getSessionId();
		if (pending && pending.sid === sid) {
			if (hasRelay(ctx)) {
				// The relay re-queues the user message after its block.
				pending = null;
				log("backstop stand down: relay announced");
			} else if (!pending.queued) {
				const m = pending;
				pending = null;
				try {
					await deliver(m.text, m.images);
				} catch (err) {
					log("backstop delivery failed:", String(err));
				}
			} else {
				pending = null;
			}
		}
		config.onSettled?.(ctx);
		maybeRelay(ctx);
	});

	return {
		proxyActive: () => proxyActive,
		relayed: (sid: string) => relayed.has(sid),
	};
}
