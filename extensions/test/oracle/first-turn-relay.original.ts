/**
 * first-turn-relay.ts
 *
 * A first-turn slot protocol for pi extensions.
 *
 * Problem
 *   Two or more extensions may each want to own the first turn of a new
 *   session: inject a block of instructions (a guidance set, a style
 *   profile, ...), let the model confirm it, and only then deliver the
 *   user's original message. Pi dispatches the `input` event to handlers
 *   in registration order and the first handler to return "handled"
 *   wins — the remaining handlers do not run for that event. Without a
 *   protocol, exactly one extension wins the slot and the other's block
 *   is lost (or duplicated by naive fallbacks).
 *
 * Protocol
 *   The extension whose input handler claims the first user message
 *   (determined by extension load/registration order) becomes the
 *   slot-holder. Extensions whose input handler did not run become
 *   relays.
 *
 *   Slot-holder (this module's input proxy handler):
 *     1. announces itself with a custom session entry
 *            { customType: "relay-handshake",
 *              data: { role: "slot-holder", sid, userMsg } }
 *        where userMsg is the user's original message text, trimmed;
 *     2. queues its block as a follow-up;
 *     3. waits up to ~450ms for a relay to announce itself (relays
 *        announce at session_start + ~350ms); when one appears, waits a
 *        short settle delay so the relay's block is ahead in the
 *        follow-up queue;
 *     4. queues the user's message as a follow-up — behind the relay's
 *        block when a relay is present, right behind its own block
 *        otherwise;
 *     5. keeps a private backstop copy of the user's message; on
 *        agent_settled it delivers that copy only if the follow-up queue
 *        failed and no relay announced itself.
 *
 *   Relay (this module's session_start path + dedupe input handler):
 *     1. after ~350ms (7x50ms) of confirming its own proxy did not take
 *        the slot, announces itself with
 *            { customType: "relay-handshake", data: { role: "relay", sid } }
 *        and reads the slot-holder's entry to learn userMsg;
 *     2. queues its own block as a follow-up (immediately after the
 *        announcement, so the slot-holder's settle delay covers it);
 *     3. a dedupe input handler re-queues exactly the announced userMsg
 *        (the slot-holder's delivery passes through the relay's input
 *        pipeline as source "extension") so the user's message lands
 *        behind the relay's block. Any other text — including the
 *        slot-holder's own block, if it arrives after the relay armed —
 *        passes through untouched. Duplicate deliveries of the relay's
 *        own block are suppressed.
 *
 *   Net order in a two-extension session: slot-holder's block, relay's
 *   block, the user's message (exactly once).
 *
 *   Coordination is through public session entries only. Extensions do
 *   not import each other or share memory. A slot-holder that does not
 * already
 *   implement the protocol (no handshake entry) is handled by
 *   observation: the relay's maybeRelay fallback queues its block after
 *   the first settlement and leaves the user's message with the
 *   slot-holder.
 *
 * Usage
 *   Copy this file into your extension directory (or import it from a
 *   shared location) and call createFirstTurnRelay from your extension's
 *   factory:
 *
 *     import { createFirstTurnRelay } from "./first-turn-relay.ts";
 *
 *     export default function (pi: ExtensionAPI) {
 *       createFirstTurnRelay(pi, {
 *         label: "My extension",        // used in UI notifications
 *         directivePrefix: "Apply this", // prefix unique to your block
 *         block: () => myBlockText(),    // the block to inject
 *       });
 *     }
 *
 *   The module registers four handlers: an input proxy (claims the
 *   slot), a session_start relay path, an agent_settled backstop, and a
 *   second input handler (the dedupe). For your own session_start or
 *   agent_settled behavior, use the onSessionStart / onSettled hooks.
 *   Keep any other extension-specific handlers (before_agent_start,
 *   session_compact, ...) in your own extension file.
 *
 * License: GPL-3.0.
 */

import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";

/** Custom session entry type used for protocol announcements. */
export const HANDSHAKE_TYPE = "relay-handshake";

export type HandshakeRole = "slot-holder" | "relay";

export interface HandshakeData {
	role: HandshakeRole;
	sid: string;
	/** Slot-holder entries only: the user's original message text, trimmed. */
	userMsg?: string;
}

/** Timing knobs. All delays are small relative to model turn duration. */
export const TIMING = {
	/** Relay: attempts x ms of polling for the slot-holder's proxy to engage. */
	relayPollAttempts: 7,
	relayPollMs: 50,
	/** Slot-holder: attempts x ms of waiting for a relay to announce. */
	proxyRelayWaitAttempts: 9,
	proxyRelayWaitMs: 50,
	/** Slot-holder: settle delay after seeing a relay announcement. */
	proxyRelaySettleMs: 150,
} as const;

export interface FirstTurnRelayConfig {
	/** Short label for UI notifications, e.g. "Vera guidance". */
	label: string;
	/**
	 * Prefix that identifies this extension's own block text. The dedupe
	 * uses it to tell the relay's own block (allow first, suppress
	 * duplicates) apart from everything else. Use a prefix that appears
	 * at the start of your block's directive line.
	 */
	directivePrefix: string;
	/** Returns the block text to inject on the first turn. */
	block: () => string;
	/**
	 * When false, the relay path stays off for this session (e.g. the
	 * block's source document is missing and only a gap marker would be
	 * queued). Default: true.
	 */
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

interface PendingMessage {
	text: string;
	images?: Array<ImagePart>;
	sid: string;
}

interface SessionEntry {
	type?: string;
	customType?: string;
	data?: HandshakeData;
	message?: { role?: string; content?: unknown };
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export function createFirstTurnRelay(
	pi: ExtensionAPI,
	config: FirstTurnRelayConfig,
): FirstTurnRelayHandle {
	const log = config.verbose
		? (...args: unknown[]) => console.error(`[first-turn-relay:${config.label}]`, ...args)
		: () => {};

	const firstTurnDelivered = new Set<string>();
	const observedSessions = new Set<string>();
	const relayedSessions = new Set<string>();
	let pendingFirstMessage: PendingMessage | null = null;
	let heldQueued = false;
	let relayUserMsgPending = false;
	let blockDelivered = false;
	let proxyActive = false;
	let slotHolderUserMsg = "";

	function readEntries(ctx: ExtensionContext): SessionEntry[] {
		try {
			return ctx.sessionManager.getEntries() as SessionEntry[];
		} catch {
			return [];
		}
	}

	function findSlotHolderEntry(ctx: ExtensionContext): SessionEntry | undefined {
		return readEntries(ctx).find(
			(e) => e && e.customType === HANDSHAKE_TYPE && e.data && e.data.role === "slot-holder",
		);
	}

	function hasRelayEntry(ctx: ExtensionContext): boolean {
		return readEntries(ctx).some(
			(e) => e && e.customType === HANDSHAKE_TYPE && e.data && e.data.role === "relay",
		);
	}

	function hasPriorUser(ctx: ExtensionContext): boolean {
		return readEntries(ctx).some(
			(e) => e && e.type === "message" && e.message && e.message.role === "user",
		);
	}

	function userEntries(ctx: ExtensionContext): Array<{ text: string; images?: Array<ImagePart> }> {
		const out: Array<{ text: string; images?: Array<ImagePart> }> = [];
		for (const e of readEntries(ctx)) {
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
					else if (p.type === "image" && p.data && p.mimeType)
						images.push({ type: "image", data: p.data, mimeType: p.mimeType });
				}
				out.push({ text, images: images.length > 0 ? images : undefined });
			}
		}
		return out;
	}

	// -------------------------------------------------------------------
	// Slot-holder path: claim the first user message of a new session.
	// Only the extension whose input handler runs first in registration
	// order reaches this code; the others' input handlers are skipped
	// for the claimed event ('handled' short-circuits dispatch).
	// -------------------------------------------------------------------
	pi.on("input", async (event: InputEvent, ctx: ExtensionContext) => {
		if (event.source === "extension") return { action: "continue" };
		if (event.streamingBehavior !== undefined) return { action: "continue" };
		if (!event.text || !event.text.trim()) return { action: "continue" };
		const sid = ctx.sessionManager.getSessionId();
		if (firstTurnDelivered.has(sid)) return { action: "continue" };
		if (hasPriorUser(ctx)) return { action: "continue" };
		firstTurnDelivered.add(sid);
		proxyActive = true;
		log('proxy engaged, sid =', sid);
		if (ctx.hasUI) ctx.ui.notify(`${config.label}: proxying the first turn`, 'info');
		try {
			pi.appendEntry(HANDSHAKE_TYPE, { role: 'slot-holder', sid, userMsg: event.text.trim() });
			log('slot-holder announced, sid =', sid);
		} catch (e) {
			log('slot-holder announce FAILED:', String(e));
		}
		pendingFirstMessage = { text: event.text, images: event.images as Array<ImagePart> | undefined, sid };
		try {
			await pi.sendUserMessage(config.block(), { deliverAs: "followUp" });
			// Wait for a relay to announce itself (it announces at
			// session_start + ~350ms). The relay queues its block
			// immediately after announcing, so when one shows up, a short
			// settle delay puts the user's message behind the relay's
			// block in the follow-up queue. With no relay, queue right
			// away.
			let relayAnnounced = false;
			for (let attempt = 0; attempt < TIMING.proxyRelayWaitAttempts; attempt++) {
				await sleep(TIMING.proxyRelayWaitMs);
				relayAnnounced = hasRelayEntry(ctx);
				if (relayAnnounced) break;
			}
			if (relayAnnounced) await sleep(TIMING.proxyRelaySettleMs);
			log('queueing user message, relayAnnounced =', relayAnnounced);
			if (event.images && event.images.length > 0) {
				await pi.sendUserMessage(
					[{ type: "text", text: event.text }, ...(event.images as unknown[])] as never,
					{ deliverAs: "followUp" },
				);
			} else {
				await pi.sendUserMessage(event.text, { deliverAs: "followUp" });
			}
			heldQueued = true;
		} catch (err) {
			log('follow-up queue failed:', String(err));
			if (ctx.hasUI)
				ctx.ui.notify(
					`${config.label}: follow-up queue failed (${String(err)}); backstop delivery after the block run`,
					'warning',
				);
		}
		return { action: "handled" };
	});

	// -------------------------------------------------------------------
	// Relay path: session_start. If the slot was not taken by this
	// extension's proxy, announce as relay and queue the block.
	// -------------------------------------------------------------------
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		config.onSessionStart?.(ctx);
		if (config.blockReady && !config.blockReady()) {
			log('relay path off: block not ready');
			return;
		}
		log('relay path entering, proxyActive =', proxyActive);
		void (async () => {
			let proxyEngaged = false;
			for (let attempt = 0; attempt < TIMING.relayPollAttempts; attempt++) {
				await sleep(TIMING.relayPollMs);
				if (proxyActive) {
					proxyEngaged = true;
					break;
				}
			}
			log('relay check done, proxyEngaged =', proxyEngaged);
			if (proxyEngaged) return;
			const sid = ctx.sessionManager.getSessionId();
			relayUserMsgPending = true;
			observedSessions.add(sid);
			try {
				const slotHolderEntry = findSlotHolderEntry(ctx);
				slotHolderUserMsg =
					slotHolderEntry && slotHolderEntry.data && typeof slotHolderEntry.data.userMsg === 'string'
						? slotHolderEntry.data.userMsg
						: '';
				pi.appendEntry(HANDSHAKE_TYPE, { role: 'relay', sid });
				log('relay announced, peerSeen =', Boolean(slotHolderEntry), 'userMsgLen =', slotHolderUserMsg.length);
			} catch (e) {
				log('relay announce FAILED:', String(e));
			}
			try {
				await pi.sendUserMessage(config.block(), { deliverAs: "followUp" });
				relayedSessions.add(sid);
				log('relay block queued, sid =', sid);
			} catch (err) {
				observedSessions.delete(sid);
				relayUserMsgPending = false;
				log('early queue failed:', String(err));
				if (ctx.hasUI) ctx.ui.notify(`${config.label}: early queue failed — ${String(err)}`, 'error');
			}
		})();
	});

	// -------------------------------------------------------------------
	// agent_settled: backstop delivery of the held user message (only if
	// the follow-up queue failed and no relay is present), plus the
	// maybeRelay fallback for non-protocol slot-holders.
	// -------------------------------------------------------------------
	function maybeRelay(ctx: ExtensionContext) {
		const sid = ctx.sessionManager.getSessionId();
		if (observedSessions.has(sid) || relayedSessions.has(sid)) return;
		// If the proxy took the slot, the proxy path is self-contained and
		// the relay must not fire.
		if (proxyActive) return;
		const entries = userEntries(ctx);
		if (entries.some((m) => m.text.trimStart().startsWith(config.directivePrefix))) return;
		// The session must have reached its first run; a settled session
		// with no user entries yet is not a stolen slot, just a quiet one.
		if (entries.length === 0) return;
		observedSessions.add(sid);
		relayUserMsgPending = true;
		if (ctx.hasUI)
			ctx.ui.notify(
				`${config.label}: first turn taken by another extension; relaying after its block`,
				'info',
			);
		void (async () => {
			try {
				await pi.sendUserMessage(config.block(), { deliverAs: "followUp" });
				relayedSessions.add(sid);
			} catch (err) {
				observedSessions.delete(sid);
				log('relay failed:', String(err));
				if (ctx.hasUI) ctx.ui.notify(`${config.label}: relay failed — ${String(err)}`, 'error');
			}
		})();
	}

	pi.on("agent_settled", async (_event: unknown, ctx: ExtensionContext) => {
		if (pendingFirstMessage && pendingFirstMessage.sid === ctx.sessionManager.getSessionId()) {
			const relayPresent = hasRelayEntry(ctx);
			if (relayPresent) {
				// The relay re-queues the user's message after its own
				// block; the slot-holder's backstop stands down.
				pendingFirstMessage = null;
				log('backstop stand down: relay announced, user message left to relay');
			} else if (!heldQueued) {
				const m = pendingFirstMessage;
				pendingFirstMessage = null;
				try {
					if (m.images && m.images.length > 0) {
						await pi.sendUserMessage(
							[{ type: "text", text: m.text }, ...(m.images as unknown[])] as never,
						);
					} else {
						await pi.sendUserMessage(m.text);
					}
				} catch (err) {
					log('backstop delivery failed:', String(err));
				}
			} else {
				// Already queued by the proxy path; nothing to deliver.
				pendingFirstMessage = null;
			}
		}
		config.onSettled?.(ctx);
		maybeRelay(ctx);
	});

	// -------------------------------------------------------------------
	// Dedupe path (relay only): the slot-holder's delivery of the user's
	// message arrives as a source "extension" input. Re-queue exactly the
	// announced userMsg so it lands behind the relay's block. Any other
	// text passes through untouched; the relay's own block is allowed
	// once and suppressed on duplicates.
	// -------------------------------------------------------------------
	pi.on("input", async (event: InputEvent, ctx: ExtensionContext) => {
		if (event.source !== "extension") return { action: "continue" };
		if (proxyActive) return { action: "continue" };
		const t = (event.text ?? "").trim();
		if (!t) return { action: "continue" };
		if (!relayUserMsgPending) return { action: "continue" };
		// The relay's own block, if it loops back through the input
		// pipeline: allow the first delivery, suppress duplicates.
		if (t.startsWith(config.directivePrefix)) {
			if (blockDelivered) {
				if (ctx.hasUI) ctx.ui.notify(`${config.label}: suppressing duplicate block`, 'info');
				return { action: "handled" };
			}
			blockDelivered = true;
			return { action: "continue" };
		}
		// Only the slot-holder's announced user message is re-queued.
		// Any other text (e.g. the slot-holder's own block arriving after
		// the relay armed) passes through untouched.
		if (slotHolderUserMsg && t !== slotHolderUserMsg) {
			return { action: "continue" };
		}
		relayUserMsgPending = false;
		if (ctx.hasUI) ctx.ui.notify(`${config.label}: relaying first user message after block`, 'info');
		try {
			if (event.images && event.images.length > 0) {
				await pi.sendUserMessage(
					[{ type: "text", text: event.text }, ...(event.images as unknown[])] as never,
					{ deliverAs: "followUp" },
				);
			} else {
				await pi.sendUserMessage(event.text, { deliverAs: "followUp" });
			}
		} catch (err) {
			log('dedupe re-queue failed:', String(err));
		}
		return { action: "handled" };
	});

	return {
		proxyActive: () => proxyActive,
		relayed: (sid: string) => relayedSessions.has(sid),
	};
}
