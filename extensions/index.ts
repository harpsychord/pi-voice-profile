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

interface Block {
	block: string;
	bytes: number;
	missing: boolean;
}

type ImagePart = { type: "image"; data: string; mimeType: string };

interface PendingFirstMessage {
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
	let pendingFirstMessage: PendingFirstMessage | null = null;
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
		if (ctx.hasUI) ctx.ui.notify("Voice profile: turn 1 reserved for profile delivery", "info");
		pendingFirstMessage = { text: event.text, images: event.images as Array<ImagePart> | undefined, sid };
		await pi.sendUserMessage(load(false).block);
		return { action: "handled" };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (pendingFirstMessage && pendingFirstMessage.sid === ctx.sessionManager.getSessionId()) {
			const m = pendingFirstMessage;
			pendingFirstMessage = null;
			if (m.images && m.images.length > 0) {
				await pi.sendUserMessage([{ type: "text", text: m.text }, ...m.images]);
			} else {
				await pi.sendUserMessage(m.text);
			}
		}
		if (reinjectAwaitingReply) reinjectAwaitingReply = false;
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
