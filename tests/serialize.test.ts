/**
 * P0.6 — tool-result truncation inside observer chunks.
 *
 * A single oversized tool result must never blow up an observer chunk (the chunk budget
 * selects entries but cannot split one), while user/assistant text is never truncated —
 * a long user message is a deliberate assertion.
 */
import { describe, expect, it } from "vitest";

import {
	MAX_RECORD_CONTENT_CHARS,
	MAX_TOOL_CALL_ARGS_CHARS,
	serializeConversation,
	truncateRecordContent,
	truncateToolCallArgs,
} from "../src/ledger/serialize.js";
import type { Message } from "@earendil-works/pi-ai";

function toolResult(text: string): Message {
	return {
		role: "tool_result",
		toolName: "read",
		timestamp: "2026-09-25T10:00:00.000Z",
		content: [{ type: "text", text }],
	} as unknown as Message;
}

function userMessage(text: string): Message {
	return {
		role: "user",
		timestamp: "2026-09-25T10:00:00.000Z",
		content: [{ type: "text", text }],
	} as unknown as Message;
}

describe("P0.6 tool-result truncation", () => {
	it("cap is 40_000 chars", () => {
		expect(MAX_RECORD_CONTENT_CHARS).toBe(40_000);
	});

	it("truncates an oversized tool result to the cap with a marker", () => {
		const huge = "x".repeat(MAX_RECORD_CONTENT_CHARS + 5_000);
		const out = serializeConversation([toolResult(huge)]);
		expect(out.length).toBeLessThan(huge.length);
		expect(out).toContain("[truncated 5000 chars]");
		expect(out).toContain("[Tool result for read");
		// the serialized record stays bounded near the cap (plus framing + marker)
		expect(out.length).toBeLessThan(MAX_RECORD_CONTENT_CHARS + 200);
	});

	it("leaves a tool result under the cap untouched", () => {
		const small = "short tool output";
		expect(serializeConversation([toolResult(small)])).toContain(small);
		expect(truncateRecordContent(small)).toBe(small);
	});

	it("never truncates a long USER message (assertions reach the observer verbatim)", () => {
		const long = "y".repeat(MAX_RECORD_CONTENT_CHARS + 9_000);
		const out = serializeConversation([userMessage(long)]);
		expect(out).toContain(long); // full text present
		expect(out).not.toContain("[truncated");
	});

	it("truncated marker reports the exact dropped count", () => {
		const content = "z".repeat(45_000);
		const result = truncateRecordContent(content);
		expect(result).toContain("… [truncated 5000 chars]");
	});

	it("omits assistant thinking blocks from serialized conversation by default", () => {
		const assistantWithThinking = {
			role: "assistant",
			timestamp: "2026-09-25T10:00:00.000Z",
			content: [
				{ type: "thinking", thinking: "secret chain of thought" },
				{ type: "text", text: "Visible assistant reply" },
			],
		} as unknown as Message;
		const thinkingOnly = {
			role: "assistant",
			timestamp: "2026-09-25T10:01:00.000Z",
			content: [{ type: "thinking", thinking: "only thinking" }],
		} as unknown as Message;

		const out = serializeConversation([assistantWithThinking, thinkingOnly]);
		expect(out).toContain("Visible assistant reply");
		expect(out).not.toContain("secret chain of thought");
		expect(out).not.toContain("only thinking");
		expect(out).not.toContain("[thinking:");
		expect(out).not.toContain("[non-text content omitted]");
	});

	it("truncates toolCall JSON arguments over MAX_TOOL_CALL_ARGS_CHARS (4000)", () => {
		expect(MAX_TOOL_CALL_ARGS_CHARS).toBe(4_000);
		const hugeArg = "w".repeat(MAX_TOOL_CALL_ARGS_CHARS + 500);
		const assistantToolCall = {
			role: "assistant",
			timestamp: "2026-09-25T10:00:00.000Z",
			content: [{ type: "toolCall", name: "write", arguments: { content: hugeArg } }],
		} as unknown as Message;

		const out = serializeConversation([assistantToolCall]);
		expect(out).toContain("[write(");
		expect(out).toContain("… [truncated");
		expect(out.length).toBeLessThan(MAX_TOOL_CALL_ARGS_CHARS + 200);
		expect(truncateToolCallArgs("short")).toBe("short");
	});
});
