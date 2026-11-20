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
 * The first-turn slot protocol (slot-holder proxy, session-start
 * relay, backstop, dedupe, the "relay-handshake" session entries)
 * lives in first-turn-relay.ts, a self-contained module other
 * extensions can adopt. This file keeps only the profile-specific
 * parts: block building, system-prompt residency, and
 * post-compaction re-injection.
 *
 * Mechanics:
 *   - Reads references/voice-profile.md from this extension's own
 *     directory, resolved relative to this file, so the extension
 *     works from any install location.
 *   - The block is a one-sentence shared directive followed by the
 *     document, identical on every delivery path (system prompt,
 *     first turn, re-injection), so the block is the same document
 *     at every moment of the conversation.
 *   - session_start: read fresh, build the block, notify; the relay
 *     path (first-turn-relay.ts) arms when this extension's proxy
 *     did not take the slot.
 *   - before_agent_start: set
 *     systemPromptOptions.sections["pi-voice-profile"] (in-place
 *     mutation; Pi diffs sections and patches only changes, so a
 *     stable block costs nothing after the first patch).
 *   - First turn: see first-turn-relay.ts (createFirstTurnRelay). This extension holds the
 *     slot when its input handler wins the registration-order race;
 *     otherwise it relays its block and the user's message lands last.
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
import { createFirstTurnRelay } from "./first-turn-relay.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REF_DIR = path.join(HERE, "references");

const FILE = "voice-profile.md";

// Shared directive: one sentence, identical on every delivery path
// (system prompt, first turn, re-injection), so the reply to a
// delivered block is an answer about the profile as a whole.
const DIRECTIVE =
	"Apply this voice profile to the conversation from the first reply and confirm it is active:\n\n";

// Shared directive prefix for self-recognition in the relay dedupe.
const DIRECTIVE_PREFIX = "Apply this voice profile to the conversation";

interface Block {
	block: string;
	bytes: number;
	missing: boolean;
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

	// First-turn slot protocol: slot-holder proxy, session-start relay,
	// agent_settled backstop, and the dedupe re-queue. See
	// first-turn-relay.ts. The hooks keep this extension's own
	// session_start notification and agent_settled flag handling.
	createFirstTurnRelay(pi, {
		label: "Voice profile",
		directivePrefix: DIRECTIVE_PREFIX,
		block: () => load(false).block,
		blockReady: () => !load(false).missing,
		onSessionStart: (ctx) => {
			const c = load(true);
			if (!ctx.hasUI) return;
			if (!c.missing) {
				ctx.ui.notify(`Voice profile loaded: ${(c.bytes / 1024).toFixed(1)} KB (system prompt)`, "info");
			} else {
				ctx.ui.notify("Voice profile MISSING: references/voice-profile.md not found", "error");
			}
		},
		onSettled: () => {
			if (reinjectAwaitingReply) reinjectAwaitingReply = false;
		},
	});

	pi.on("before_agent_start", (event) => {
		const c = load(false);
		event.systemPromptOptions.sections["pi-voice-profile"] = c.block;
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
