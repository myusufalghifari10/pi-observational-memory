import { describe, expect, it } from "vitest";

import { buildCompactionProjection, renderSummary } from "../src/ledger/index.js";
import { canSkipObserverWait, snapCutoff, snapFirstKeptEntryId } from "../src/hooks/compaction-hook.js";
import {
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	rawMessage,
	toolResultMessage,
} from "./fixtures/session.js";

// 40 chars ⇒ 10 estimated tokens per source message.
const body = "x".repeat(40);

describe("snapFirstKeptEntryId", () => {
	it("snaps to the chunk boundary whose tail is closest to tailTokens", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-4" }),
			rawMessage("raw-5", body),
			rawMessage("raw-6", body),
		];

		// Boundaries: raw-2 (tail 40), raw-4 (tail 20). tailTokens 25 → raw-4 boundary → keep raw-5.
		expect(snapFirstKeptEntryId(branch, "raw-6", 25)).toBe("raw-5");
		// Larger tailTokens favors the earlier boundary.
		expect(snapFirstKeptEntryId(branch, "raw-6", 40)).toBe("raw-3");
	});

	it("skips a boundary whose next entry is not a valid cut point (tool result)", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			toolResultMessage("tr-1", body), // would-be firstKept after raw-2 → invalid
			rawMessage("raw-3", body),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-3" }),
			rawMessage("raw-4", body),
		];

		// raw-2 boundary disqualified (next entry tr-1 is a tool result); raw-3 boundary keeps raw-4.
		expect(snapFirstKeptEntryId(branch, "raw-4", 5)).toBe("raw-4");
	});

	it("falls back to pi's proposed firstKeptEntryId when no boundary qualifies", () => {
		const branch = [rawMessage("raw-1", body), rawMessage("raw-2", body)];
		expect(snapFirstKeptEntryId(branch, "raw-2", 5)).toBe("raw-2");
	});
});

describe("canSkipObserverWait (R5 fast path)", () => {
	// Two committed chunks; cutoff snaps to raw-4 boundary (keep raw-5). Tail after raw-4 = 10.
	const branch = [
		rawMessage("raw-1", body),
		rawMessage("raw-2", body),
		observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
		rawMessage("raw-3", body),
		rawMessage("raw-4", body),
		observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-4" }),
		rawMessage("raw-5", body),
		rawMessage("raw-6", body),
	];
	const snap = snapCutoff(branch, "raw-6", 20); // firstKeptId raw-5, tail 20 (raw-5 + raw-6)

	it("skips when there are no in-flight observers and the tail is at/under target", () => {
		expect(snap.firstKeptId).toBe("raw-5");
		expect(snap.tail).toBe(20);
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [])).toBe(true);
	});

	it("skips when every in-flight observer covers a chunk in the verbatim tail", () => {
		// Observer working raw-6 (after the raw-5 cutoff) → excluded from the projection anyway.
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [{ coversUpToId: "raw-6" }])).toBe(true);
	});

	it("waits when an in-flight observer covers a chunk at/before the cutoff", () => {
		// A slow observer still on raw-2 (before the raw-5 cutoff) would enter the projection.
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [{ coversUpToId: "raw-2" }])).toBe(false);
	});

	it("waits when the in-flight observer's coversUpToId does not resolve in the branch", () => {
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [{ coversUpToId: "ghost" }])).toBe(false);
	});

	it("waits when the snapped tail exceeds tailTokens (snap could still move)", () => {
		// tailTokens 5 < actual tail 10 → a just-committed tail boundary could become a better snap.
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 5, [])).toBe(false);
	});

	it("waits when snap fell back to pi's proposal (no qualifying boundary)", () => {
		const bare = [rawMessage("raw-1", body), rawMessage("raw-2", body)];
		const fallback = snapCutoff(bare, "raw-2", 5);
		expect(fallback.tail).toBeUndefined();
		expect(canSkipObserverWait(bare, fallback.firstKeptId, fallback.tail, 5, [])).toBe(false);
	});
});

describe("cutoff ↔ projection integration (no double representation)", () => {
	it("renders exactly the observations whose source precedes the snapped cutoff", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01", { content: "early" })], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00", { content: "late" })], coversUpToId: "raw-4" }),
			rawMessage("raw-5", body),
		];

		const snapped = snapFirstKeptEntryId(branch, "raw-5", 10); // tail after raw-4 = 10 → keep raw-5
		expect(snapped).toBe("raw-5");

		const projection = buildCompactionProjection(branch, snapped);
		// Both chunks precede the cutoff (raw-5); both render, nothing in the verbatim tail.
		expect(projection.observations.map((o) => o.content)).toEqual(["early", "late"]);

		const summary = renderSummary(undefined, undefined, projection.observations);
		expect(summary).toContain("2026-05-02T10:00:01  early");
		expect(summary).toContain("2026-05-02T10:05:00  late");
	});
});

// ── P3.2 flush-ack gate (§2.4) ────────────────────────────────────────────────
// Local builders: fixtures/session.ts is out of scope for this task's authority.
function gapEntry(
	id: string,
	data: Record<string, unknown>,
): { type: string; id: string; customType: string; data: unknown; parentId: null; timestamp: string } {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-09-25T10:00:00",
		customType: "om.observations.gap",
		data,
	};
}

describe("P3.2 flush-ack gate (§2.4)", () => {
	it("(a) refuses a boundary whose chunk has no flush ack (dropped coverage only)", () => {
		// Coverage candidates: dropped(covers raw-2) is the consolidator's tip-at-consolidation
		// watermark — NOT flush evidence — so the raw-2 boundary must be REFUSED. The recorded
		// raw-4 boundary is the only eligible one.
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsDroppedEntry("drop-1", { observationTimestamps: ["2026-05-02T10:00:01"], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-4" }),
			rawMessage("raw-5", body),
		];

		// tailTokens 30 exactly matches the tail after raw-2 — without the gate the snapper
		// would pick the REFUSED boundary (firstKept raw-3). With the gate only raw-4 qualifies.
		expect(snapFirstKeptEntryId(branch, "raw-5", 30)).toBe("raw-5");
		// Explicit refusal assertion: the refused boundary's firstKept is never returned.
		expect(snapFirstKeptEntryId(branch, "raw-5", 30)).not.toBe("raw-3");
	});

	it("(b) accepts a gap-acked boundary (attempts:2 give-up chunk) — gap variant", () => {
		// The chunk ending at raw-2 was ACKNOWLEDGED by an om.observations.gap entry:
		// it is a legal stop even though no om.observations.recorded covers it.
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			gapEntry("gap-1", { afterEntryId: "raw-1", coversUpToId: "raw-2", attempts: 2, lastError: "observer exited 1" }),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
		];

		// Pre-gate: boundaries come from recorded entries only → none → pi's proposal raw-4.
		// Post-gate: the gap boundary at raw-2 is accepted → firstKept raw-3.
		expect(snapFirstKeptEntryId(branch, "raw-4", 5)).toBe("raw-3");
	});

	it("(b) accepts a recorded-acked boundary — recorded variant", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
		];
		expect(snapFirstKeptEntryId(branch, "raw-3", 5)).toBe("raw-3");
	});

	it("(c) falls back to pi's proposal when NO acked boundary qualifies", () => {
		// A dropped-only branch: coverage exists, boundaries exist, but the gate refuses
		// every one of them → zero eligible boundaries → conservative fallback to pi's proposal.
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsDroppedEntry("drop-1", { observationTimestamps: ["2026-05-02T10:00:01"], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
		];

		// Pre-gate: the dropped boundary at raw-2 would win (firstKept raw-3), overriding
		// pi's proposal raw-2. Post-gate: refused → pi's proposal raw-2 stands.
		expect(snapFirstKeptEntryId(branch, "raw-2", 5)).toBe("raw-2");
	});

	it("(d) determinism: identical branch + args ⇒ identical snap (C3)", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsDroppedEntry("drop-1", { observationTimestamps: ["2026-05-02T10:00:01"], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			gapEntry("gap-1", { afterEntryId: "raw-2", coversUpToId: "raw-3", attempts: 2, lastError: "x" }),
			rawMessage("raw-4", body),
		];
		const a = snapCutoff(branch, "raw-4", 10);
		const b = snapCutoff(branch, "raw-4", 10);
		expect(a).toEqual(b);
		// gap boundary accepted; dropped-refusal here is incidental (delta 0 either
		// way) — the real filter guards are (a) and (c).
		expect(a.firstKeptId).toBe("raw-4");
	});
});
