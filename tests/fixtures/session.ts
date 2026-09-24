import type { ObservationKind } from "../../src/ledger/types.js";

export type TestEntry = {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
	fromId?: string;
};

export type TestObservation = {
	timestamp: string;
	content: string;
	tokenCount: number;
	/** P1.1: optional semantic kind (old v1 entries have no kind — C5 backward compat). */
	kind?: ObservationKind;
	/** P1.1: optional provenance anchor (assigned at commit by deriveProvenance, L1). */
	sourceEntryId?: string;
};

export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
/** P1.3: correction pairs — "believed X → now Y" (L4: losing fact preserved). */
export const OM_OBSERVATIONS_SUPERSEDED = "om.observations.superseded";
export const OM_FOLDED = "om.folded";
export const OM_COST = "om.cost";

const DEFAULT_TIMESTAMP = "2026-05-02T10:00:00.000Z";

export function rawMessage(id: string, text: string, overrides: Partial<TestEntry> = {}): TestEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		message: { role: "user", content: [{ type: "text", text }] },
		...overrides,
	};
}

/** An assistant message that issues a tool call — the entry a tool result must stay attached to. */
export function assistantToolCallMessage(
	id: string,
	args: { text?: string; toolName?: string; toolCallId?: string; arguments?: unknown } = {},
	overrides: Partial<TestEntry> = {},
): TestEntry {
	const content: unknown[] = [];
	if (args.text) content.push({ type: "text", text: args.text });
	content.push({
		type: "toolCall",
		id: args.toolCallId ?? `${id}-call`,
		name: args.toolName ?? "bash",
		arguments: args.arguments ?? {},
	});
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		message: { role: "assistant", content },
		...overrides,
	};
}

/** A tool-result message entry — a source entry that is NOT a valid compaction cut point. */
export function toolResultMessage(id: string, text: string, overrides: Partial<TestEntry> = {}): TestEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] },
		...overrides,
	};
}

export function customMessage(id: string, content: unknown, overrides: Partial<TestEntry> = {}): TestEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		content,
		...overrides,
	};
}

export function textCustomMessage(id: string, text: string, overrides: Partial<TestEntry> = {}): TestEntry {
	return customMessage(id, text, overrides);
}

export function branchSummary(id: string, summary: string, overrides: Partial<TestEntry> = {}): TestEntry {
	return {
		type: "branch_summary",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		summary,
		...overrides,
	};
}

export function compactionEntry(
	id: string,
	args: { firstKeptEntryId?: string; details?: unknown; summary?: string } = {},
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		firstKeptEntryId: args.firstKeptEntryId,
		summary: args.summary ?? "compacted memory",
		details: args.details,
		...overrides,
	};
}

export function memoryDetails(args: { observations?: TestObservation[] } = {}): unknown {
	return {
		type: OM_FOLDED,
		version: 1,
		observations: args.observations ?? [],
	};
}

export function observation(timestamp: string, overrides: Partial<TestObservation> = {}): TestObservation {
	return {
		timestamp,
		content: `Observation ${timestamp}`,
		tokenCount: 10,
		...overrides,
	};
}

export function observationsRecordedEntry(
	id: string,
	args: { observations: TestObservation[]; coversUpToId: string },
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType: OM_OBSERVATIONS_RECORDED,
		data: args,
		...overrides,
	};
}

export function observationsDroppedEntry(
	id: string,
	args: { observationTimestamps: string[]; coversUpToId: string },
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType: OM_OBSERVATIONS_DROPPED,
		data: args,
		...overrides,
	};
}

export function observationsSupersededEntry(
	id: string,
	args: {
		pairs: Array<{ oldTimestamp: string; newTimestamp: string; reason: "lexical-supersession" }>;
		coversUpToId: string;
	},
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType: OM_OBSERVATIONS_SUPERSEDED,
		data: args,
		...overrides,
	};
}

export function costEntry(
	id: string,
	costUsd: number,
	role: "observer" | "consolidator" = "observer",
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType: OM_COST,
		data: { costUsd, role, runId: id },
		...overrides,
	};
}

export function unknownCustomEntry(id: string, customType: string, data: unknown = {}): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType,
		data,
	};
}
