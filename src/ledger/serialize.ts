import type { Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { redactSecrets } from "../redact.js";

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

function fmtLocal(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTimestamp(v: number | string | undefined): string {
	if (v === undefined) return "????-??-?? ??:??";
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? "????-??-?? ??:??" : fmtLocal(d);
}

export function nowTimestamp(): string {
	return fmtLocal(new Date());
}

/**
 * Cap applied when serializing TOOL-RESULT records into an observer chunk (P0.6).
 *
 * Only tool results are capped: a single oversized result (a 500 KB `read`, a huge
 * `grep`/`ls -R` dump) would otherwise become one un-splittable chunk that the observer model
 * cannot even fit in its own context — the chunk boundary is a budget for *selecting* entries,
 * not a guarantee about entry size. User and assistant text is NEVER truncated: a long user
 * message is a deliberate assertion and must reach the observer verbatim.
 */
export const MAX_RECORD_CONTENT_CHARS = 40_000;

export function truncateRecordContent(content: string): string {
	if (content.length <= MAX_RECORD_CONTENT_CHARS) return content;
	const head = content.slice(0, MAX_RECORD_CONTENT_CHARS);
	const dropped = content.length - MAX_RECORD_CONTENT_CHARS;
	return `${head} … [truncated ${dropped} chars]`;
}

function textAndPlaceholders(content: unknown, options: { includeThinking?: boolean } = {}): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "[non-text content omitted]";

	const parts: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (!block || typeof block !== "object") {
			parts.push("[non-text content omitted]");
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
			continue;
		}
		if (block.type === "thinking") {
			if (options.includeThinking && typeof block.thinking === "string") {
				parts.push(`[thinking: ${block.thinking}]`);
				continue;
			}
			parts.push("[non-text content omitted]");
			continue;
		}
		if (block.type === "toolCall" && typeof block.name === "string") {
			parts.push(`[${block.name}(${JSON.stringify(block.arguments ?? {})})]`);
			continue;
		}
		parts.push("[non-text content omitted]");
	}
	return parts.join("\n");
}

function textOnly(content: unknown): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is TextContent => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

export function serializeConversation(messages: Message[]): string {
	return messages
		.map((msg): string | null => {
			const time = formatTimestamp(msg.timestamp);
			if (msg.role === "user") {
				return `[User @ ${time}]: ${textOnly(msg.content)}`;
			}
			if (msg.role === "assistant") {
				const body = textAndPlaceholders(msg.content, { includeThinking: true })
					.split("\n")
					.filter(Boolean)
					.join("\n");
				if (!body) return null;
				return `[Assistant @ ${time}]: ${body}`;
			}
			// P0.6: cap tool-result records only — see MAX_RECORD_CONTENT_CHARS.
			return `[Tool result for ${(msg as ToolResultMessage).toolName} @ ${time}]: ${truncateRecordContent(textOnly(msg.content))}`;
		})
		.filter((line): line is string => line !== null)
		.join("\n\n");
}

export type RenderableEntry = {
	type: string;
	id?: string;
	timestamp?: string;
	message?: unknown;
	customType?: string;
	content?: unknown;
	summary?: unknown;
};

function renderCustomMessage(entry: RenderableEntry): string {
	const time = formatTimestamp(entry.timestamp);
	const text =
		typeof entry.content === "string"
			? entry.content
			: Array.isArray(entry.content)
				? (entry.content as Array<{ type?: string; text?: string }>)
						.filter((b) => b?.type === "text" && typeof b.text === "string")
						.map((b) => b.text as string)
						.join("\n")
				: "";
	const tag = entry.customType ? `Custom (${entry.customType})` : "Custom";
	return `[${tag} @ ${time}]: ${text}`;
}

export function serializeBranchEntries(entries: RenderableEntry[]): string {
	const blocks: string[] = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message) {
			const part = serializeConversation([entry.message as Message]);
			if (part) blocks.push(part);
			continue;
		}
		if (entry.type === "custom_message") {
			blocks.push(renderCustomMessage(entry));
			continue;
		}
		if (entry.type === "branch_summary" && typeof entry.summary === "string") {
			const time = formatTimestamp(entry.timestamp);
			blocks.push(`[Branch summary @ ${time}]: ${entry.summary}`);
		}
	}
	return blocks.join("\n\n");
}

export type SourceAddressedSerialization = {
	text: string;
	sourceEntryIds: string[];
};

function isSourceRenderableEntry(entry: RenderableEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

/**
 * Serialize a slice of source entries into an observer prompt chunk, each block prefixed
 * with its source entry id. v1 observations carry no `sourceEntryIds`, but the labels keep
 * the chunk readable and let the orchestrator anchor timestamps to bounding source entries.
 */
export function serializeSourceAddressedBranchEntries(entries: RenderableEntry[]): SourceAddressedSerialization {
	const blocks: string[] = [];
	const sourceEntryIds: string[] = [];
	for (const entry of entries) {
		if (!entry.id || !isSourceRenderableEntry(entry)) continue;
		const rendered = serializeBranchEntries([entry]);
		if (!rendered.trim()) continue;
		sourceEntryIds.push(entry.id);
		blocks.push(`[Source entry id: ${entry.id}]\n${rendered}`);
	}
	// P0.10 egress point #1: chunk text leaves the master for a subprocess (and is recorded
	// in that worker's session), so secrets are stripped here — before the worker ever sees them.
	return { text: redactSecrets(blocks.join("\n\n")), sourceEntryIds };
}
