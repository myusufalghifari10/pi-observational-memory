/**
 * P0.10 — secret redaction at the two points where conversational text LEAVES the master.
 *
 * Observations persist verbatim into `.memory/*.md` and the session ledger, and worker chunk
 * text is handed to a subprocess and recorded in its global session. Before v4 nothing
 * sanitized either, so an API key pasted into a session (or spat out by a tool) was durable
 * and re-rendered at every compaction.
 *
 * Pure and model-free: a fixed set of regular expressions, applied at exactly two egress
 * points (see §2.7 of the reconstruction plan):
 *   1. `serializeSourceAddressedBranchEntries` output — chunk text sent to workers;
 *   2. `assignObservationTimestamps` output content — before `pi.appendEntry`.
 *
 * Each match becomes `[REDACTED:<label>]` so the reader still knows a secret was there.
 * Longest/most specific patterns run first to avoid a generic rule eating a better match.
 */

type Redaction = { label: string; re: RegExp };

const KEY_LENGTH = 12; // minimum surviving chars of a matched value (after the literal prefix)

/**
 * Assignment matcher that keeps the name readable and hides only the value.
 * Group 1 = name, group 2 = separator, group 3 = value (replaced).
 * Separator accepts an optional closing quote on the KEY so JSON form
 * (`"password": "…"`) matches as well as env-var form (`password=…`).
 * The value carries a negative lookahead so an existing `[REDACTED:…]`
 * placeholder from a more specific pattern is never re-eaten (idempotency).
 */
function assignment(label: string, name: string): Redaction {
	return {
		label,
		re: new RegExp(
			`(\\b(?:${name})\\b)(\\s*"?\\s*[:=]\\s*["']?)((?!\\[REDACTED:)[^\\s"']{${KEY_LENGTH},})`,
			"i",
		),
	};
}

const REDACTIONS: readonly Redaction[] = [
	// Private key blocks (whole block, including headers/footers).
	{
		label: "PRIVATE_KEY",
		re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	},
	// AWS access key id.
	{ label: "AWS_ACCESS_KEY", re: /\bAKIA[0-9A-Z]{16}\b/g },
	// Google API key.
	{ label: "GOOGLE_API_KEY", re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
	// GitHub: ghp_ / gho_ / ghu_ / ghs_ / ghr_ classic, and fine-grained personal tokens.
	{ label: "GITHUB_TOKEN", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
	// Slack tokens.
	{ label: "SLACK_TOKEN", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	// OpenAI/Anthropic/OpenRouter-style bearer-ish API keys (sk-… with a long tail).
	{ label: "API_KEY", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
	// Authorization header bearer value.
	{ label: "BEARER_TOKEN", re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g },
	// Common env-var style assignments; value side only.
	assignment("PASSWORD", "password"),
	assignment("API_KEY", "api[_-]?key"),
	assignment("SECRET", "(?:client[_-]?secret|secret[_-]?key|_?secret)"),
	assignment("ACCESS_TOKEN", "access[_-]?token"),
	assignment("AUTH_TOKEN", "(?:auth|private[_-]?token)"),
	// Generic bare `token=` assignment — plus suffix forms (`my_token=`, `auth_token=`)
	// that no prefix pattern covers. LAST so the specific *_token labels above win
	// (the placeholder guard then stops any re-redaction of their output).
	assignment("TOKEN", "(?:[A-Za-z0-9]+[_-])*token"),
];

/**
 * Replace every recognised secret pattern in `text` with `[REDACTED:<label>]`.
 * Deterministic and order-stable; returns the input unchanged when nothing matches.
 * Never throws — a malformed pattern must not be able to break persistence.
 */
export function redactSecrets(text: string): string {
	if (!text) return text;
	let out = text;
	for (const { label, re } of REDACTIONS) {
		// Fresh regex per call: the `g` flag persists `lastIndex` on a shared instance.
		const re2 = new RegExp(re.source, re.flags);
		out = out.replace(re2, (...args) => {
			const match = args[0] as string;
			// Assignments carry (name, separator, value): keep name + separator, hide the value.
			if (args.length >= 4) {
				const [, name, separator] = args as unknown as [string, string, string];
				return `${name}${separator}[REDACTED:${label}]`;
			}
			// Bare patterns replace the whole match (private-key block, AKIA…, Bearer …).
			void match;
			return `[REDACTED:${label}]`;
		});
	}
	return out;
}

/** Labels exposed for tests and documentation. */
export const REDACTION_LABELS: readonly string[] = [
	"PRIVATE_KEY",
	"AWS_ACCESS_KEY",
	"GOOGLE_API_KEY",
	"GITHUB_TOKEN",
	"SLACK_TOKEN",
	"API_KEY",
	"BEARER_TOKEN",
	"PASSWORD",
	"API_KEY",
	"SECRET",
	"ACCESS_TOKEN",
	"AUTH_TOKEN",
	"TOKEN",
];
