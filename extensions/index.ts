/**
 * pi-voice-profile extension
 *
 * Injects the voice profile document (conversational register
 * rules) into the system prompt so it is present on every model
 * request and survives context compaction by construction.
 *
 * The document is self-standing: it applies on its own and yields
 * to any higher-priority instructions loaded alongside it.
 *
 * Mechanics:
 *   - Reads references/voice-profile.md from this extension's own
 *     directory, resolved relative to this file, so the extension
 *     works from any install location.
 *   - session_start (all reasons): read fresh, build the block,
 *     notify.
 *   - before_agent_start: set
 *     systemPromptOptions.sections["pi-voice-profile"] (in-place
 *     mutation; Pi diffs sections and patches only changes, so a
 *     stable block costs nothing after the first patch).
 *   - session_compact: notify that the profile is still active.
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
	return { block: content.trim() + "\n", bytes: Buffer.byteLength(content, "utf8"), missing: false };
}

export default function (pi: ExtensionAPI) {
	let cached: Block | null = null;

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

	pi.on("session_compact", (_event, ctx) => {
		if (cached && !cached.missing && ctx.hasUI) {
			ctx.ui.notify("Context compacted — voice profile remains active (system prompt)", "info");
		}
	});
}
