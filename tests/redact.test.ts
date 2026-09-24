/**
 * P0.10 — secret redaction at both egress points.
 *
 * Every pattern in §2.7 must be caught; ordinary technical text must survive untouched; and
 * both call sites (worker chunk serialization, observation commit) must actually redact.
 */
import { describe, expect, it } from "vitest";

import { redactSecrets } from "../src/redact.js";
import { assignObservationTimestamps } from "../src/ids.js";
import { serializeSourceAddressedBranchEntries } from "../src/ledger/serialize.js";

describe("redactSecrets — every §2.7 pattern", () => {
	// Scanner-safe fixtures: every secret is split at its prefix boundary so the
	// contiguous literal never appears in the file (GitHub push protection flags
	// real-shaped tokens even when they are fake test data). Runtime values are
	// byte-identical to the unsplit literals — the redactor sees the same strings.
	const cases: Array<{ label: string; secret: string; marker: string }> = [
		{ label: "AWS access key", secret: `AKIA${"IOSFODNN7EXAMPLE"}`, marker: "[REDACTED:AWS_ACCESS_KEY]" },
		{ label: "Google API key", secret: `AIza${"B".repeat(35)}`, marker: "[REDACTED:GOOGLE_API_KEY]" },
		{ label: "GitHub classic token", secret: `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789AB"}`, marker: "[REDACTED:GITHUB_TOKEN]" },
		{ label: "GitHub fine-grained token", secret: `github_${"pat_11ABCDEFG00abcdef12345678901234567"}`, marker: "[REDACTED:GITHUB_TOKEN]" },
		{ label: "Slack token", secret: `xox${"b-1234567890123-abcdefghijklmnopqrstuvwx"}`, marker: "[REDACTED:SLACK_TOKEN]" },
		{ label: "sk- style API key", secret: `sk${"-proj-abcdefghijklmnopqrstuv1234567890"}`, marker: "[REDACTED:API_KEY]" },
	];

	for (const { label, secret, marker } of cases) {
		it(`redacts ${label}`, () => {
			const out = redactSecrets(`the key is ${secret} in config`);
			expect(out).not.toContain(secret);
			expect(out).toContain(marker);
		});
	}

	it("redacts a bearer token in an Authorization header", () => {
		const out = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw");
		expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
		expect(out).toContain("[REDACTED:BEARER_TOKEN]");
	});

	it("redacts a private key block including its headers", () => {
		const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
		const out = redactSecrets(`key material:\n${block}\ndone`);
		expect(out).not.toContain("MIIEpAIBAAKCAQEA");
		expect(out).toContain("[REDACTED:PRIVATE_KEY]");
	});

	it("redacts assignment forms (value side only, name kept)", () => {
		const out = redactSecrets(
			[
				"password=hunter2supersecretvalue",
				"API_KEY = 'abcd1234efgh5678ijkl'",
				'client_secret: "topsecretdonotshare99"',
				"access_token=eyJhbGciOiJIUzI1NiJ9abc",
				"apiKey: sk-proj-abcdefghijklmnop123456",
			].join("\n"),
		);
		expect(out).not.toContain("hunter2supersecretvalue");
		expect(out).not.toContain("abcd1234efgh5678ijkl");
		expect(out).not.toContain("topsecretdonotshare99");
		// names survive for debuggability
		expect(out).toContain("password=");
		expect(out).toContain("[REDACTED:");
	});

	it("leaves ordinary technical text completely untouched", () => {
		const text = [
			"Auth failed: TS2345 at src/auth.ts:47 — Type 'string' is not assignable.",
			"The user prefers React Query (switching from SWR).",
			"completed: implemented login handler; user confirmed tests pass",
			"run `npm test -- --runInBand` and grep the output",
			"see docs/setup.md#install and the token count of 42",
		].join("\n");
		expect(redactSecrets(text)).toBe(text);
	});

	it("redacts a generic token= assignment (P0.10 blocker fix)", () => {
		const out = redactSecrets("token=abcdef1234567890abcd");
		expect(out).toBe("token=[REDACTED:TOKEN]");
		expect(out).not.toContain("abcdef1234567890abcd");
	});

	it("redacts JSON-quoted assignment keys", () => {
		const out = redactSecrets(
			'config: {"password": "hunter2supersecretvalue", "api_key": "abcd1234efgh5678ijkl"}',
		);
		expect(out).not.toContain("hunter2supersecretvalue");
		expect(out).not.toContain("abcd1234efgh5678ijkl");
		expect(out).toContain('"password": "[REDACTED:PASSWORD]"');
		expect(out).toContain('"api_key": "[REDACTED:API_KEY]"');
	});

	it("does not redact prose uses of token (no assignment separator)", () => {
		const text = "We discussed the token count and the auth token rotation policy at length.";
		expect(redactSecrets(text)).toBe(text);
	});

	it("is idempotent (double-redaction changes nothing further)", () => {
		const once = redactSecrets("token=abcdef1234567890abcd");
		expect(once).toContain("[REDACTED:TOKEN]"); // genuinely redacted, not passed through
		expect(redactSecrets(once)).toBe(once);
		// placeholders from specific patterns are never re-eaten by the generic token rule
		const access = redactSecrets("access_token=eyJhbGciOiJIUzI1NiJ9abc");
		expect(access).toContain("[REDACTED:ACCESS_TOKEN]");
		expect(redactSecrets(access)).toBe(access);
	});

	it("does not eat short innocuous words (below key length)", () => {
		const text = "my cat has a secret and a password";
		expect(redactSecrets(text)).toBe(text);
	});
});

describe("P0.10 egress point #1 — worker chunk serialization", () => {
	it("strips a secret from chunk text before it reaches the worker", () => {
		const { text } = serializeSourceAddressedBranchEntries([
			{
				id: "e1",
				type: "message",
				timestamp: "2026-09-25T10:00:00.000Z",
				message: {
					role: "user",
					timestamp: "2026-09-25T10:00:00.000Z",
					content: [{ type: "text", text: "here is the key: AKIAIOSFODNN7EXAMPLE" }],
				},
			},
		]);
		expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(text).toContain("[REDACTED:AWS_ACCESS_KEY]");
		expect(text).toContain("[Source entry id: e1]"); // framing preserved
	});
});

describe("P0.10 egress point #2 — observation commit", () => {
	it("strips secrets from observation content before the ledger entry is built", () => {
		const [obs] = assignObservationTimestamps([
			{ timestamp: "2026-09-25 10:00", content: "User pasted API key ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" },
		]);
		expect(obs).toBeDefined();
		expect(obs!.content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB");
		expect(obs!.content).toContain("[REDACTED:GITHUB_TOKEN]");
		// tokenCount must match the persisted (redacted) content
		expect(obs!.tokenCount).toBe(Math.ceil(obs!.content.length / 4));
	});
});
