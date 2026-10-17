// Ported from mnemosia/qualifiers.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Branch and environment qualifier extraction (design §2, §11, §17 ambiguity 4; Phase 2).
 *
 * Design §2 resolved a spec/reality contradiction by making `branch` and `environment` **claim
 * qualifiers** rather than storage boundaries: neither foundation has a column for either, so they
 * can only ever be read out of the text a claim is made of. Design §17 ambiguity 4 then deferred the
 * whole thing to Phase 2 "behind a measurement gate before it influences ranking", because the
 * precision of a regex over prose was unknown on this corpus and an unmeasured extractor feeding a
 * ranking signal is a signal made of noise.
 *
 * This module is the extractor. `eval/qualifier-eval.ts` is the measurement, and
 * `QUALIFIER_RANKING` below is the gate it decides.
 *
 * **The rules are shape-constrained, not word-list-constrained.** The obvious rule —
 * `/branch\s+(\w+)/` — reads "the branch is ready" as a branch named `is`, and the obvious repair is
 * a stoplist of verbs that grows every time it is wrong. A stoplist tuned against the corpus it is
 * measured on is a fitted pass, which the Phase 2 brief forbids outright. So every rule below keys
 * on a *shape* the corpus cannot produce by accident: a `remote/name` pair, a `kind/name` pair, a
 * quoted span after the word `branch`, a well-known branch name in a directional position, or the
 * literal word `environment`. Each rule carries an id so a false positive can be attributed to the
 * rule that produced it rather than to "the regex".
 *
 * **Scope qualifiers are never a hard filter.** Design §2 is explicit: they are "used for conflict
 * classification, never hard filtering". `filters.ts` does not import this module, and `scopeKey`
 * already folds the qualifier fields in (types.ts:119-121) so that adding them later cannot silently
 * change a `claimId` that was recorded without them.
 */

export const QUALIFIER_KINDS = ["branch", "environment"] as const;
export type QualifierKind = (typeof QUALIFIER_KINDS)[number];

export const QUALIFIER_RULES = [
	"branch_remote_ref",
	"branch_kind_prefix",
	"branch_quoted",
	"branch_directional",
	"branch_named_noun",
	"env_preposition",
	"env_noun",
	"env_node_env",
	"env_platform",
	"env_ci",
] as const;
export type QualifierRuleId = (typeof QUALIFIER_RULES)[number];

export interface QualifierHit {
	kind: QualifierKind;
	/** The normalized qualifier value, lowercased. `origin/main` and `main` both yield `main`. */
	value: string;
	ruleId: QualifierRuleId;
	/** The exact span of the source text the rule matched, so a reviewer can judge it in context. */
	matchedText: string;
	start: number;
	end: number;
}

interface QualifierRule {
	kind: QualifierKind;
	ruleId: QualifierRuleId;
	pattern: RegExp;
	/** Which capture group carries the value. */
	group: number;
	/** Applied to the captured text before it becomes `value`. */
	normalize?: (value: string) => string;
	/**
	 * A second, non-regular test the capture must pass. A rejected capture does **not** claim its
	 * span, so a later rule may still read the same text — the rule declined it, it did not consume
	 * it.
	 *
	 * It exists because one of the two things that separate a branch reference from a repository
	 * path is not expressible as a regular expression over the whole capture: git's ref-name grammar
	 * is a rule about every `/`-separated *component* (each non-empty, none beginning with a dot,
	 * none ending in `.lock`, no `..` anywhere, no trailing `/` or `.`). Writing that as one pattern
	 * would produce something no reviewer could check, and the point of this module is that a false
	 * positive can be attributed to a rule a person can read.
	 */
	accept?: (value: string) => boolean;
	/**
	 * A test on the *surrounding text* rather than on the capture. Like `accept`, a rule that declines
	 * here does not claim its span.
	 *
	 * It exists because the Phase 6 measurement found the same defect twice: a shape can be perfectly
	 * well-formed and still carry no evidence that the thing it names is being *discussed*. Every
	 * `kind/name` token in `../target/release/attack_poc` is a legal Git ref name, so no refinement of
	 * `isBranchRefName` can reach it; what is missing is a neighbouring word that only makes sense if a
	 * branch is in play. `branch_quoted` (2/2 on the fresh sample) and `branch_directional` already had
	 * that discipline built into their patterns; this field is how a rule whose *shape* spans a slash
	 * gets it too.
	 */
	context?: (text: string, start: number, end: number) => boolean;
}

/** `origin/main` and `main` are the same branch; the remote is not part of the branch's identity. */
function stripRemote(value: string): string {
	return value.replace(/^(?:origin|upstream|fork)\//u, "");
}

/**
 * A filename extension: a dot, then an *alphabetic* first character, then a short alphanumeric tail,
 * at the very end of the string.
 *
 * **Not a blacklist of extensions.** A list of `.ts|.md|.js|…` is exactly the fitted repair this
 * module's header forbids — it would grow by one entry every time the corpus produced a new file
 * type, and each entry would have been added after seeing the failure it fixes. This is a statement
 * about *shape*, and it is the positive half of a claim about branch names: a branch is named after
 * a piece of work, and a piece of work does not have a file type.
 *
 * The leading `[A-Za-z]` is load-bearing in the other direction: `release/2.1` and `feature/v1.2`
 * are branch names whose last component ends in a dotted *number*, and a rule that read `.1` as an
 * extension would reject the very shape git-flow's release branches take.
 */
const FILENAME_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,6}$/u;

/**
 * Whether a capture is a legal Git branch-ref name rather than a repository path.
 *
 * The predicate is `git check-ref-format`'s grammar, restricted to the characters a branch name
 * actually uses, plus the extension test above. Stated positively, because the Phase 2 measurement
 * showed that the negative form — "a `kind/name` token, unless it looks like a file" — is a rule
 * with no grammar at all:
 *
 * - every `/`-separated component is non-empty, so `docs/` (a directory, 1 of the 23 Phase 2 errors)
 *   is not a ref name; git refuses a trailing slash for the same reason;
 * - no component begins with `.` and none ends in `.lock` — both are `check-ref-format` rules;
 * - no `..`, no `@{`, and the whole name ends in neither `/` nor `.`;
 * - the characters are `[A-Za-z0-9._-]`, which excludes every byte `check-ref-format` bans
 *   (` ~^:?*[\`, ASCII control) by whitelist rather than by enumeration;
 * - and the final component carries no filename extension.
 *
 * `feature/parser-v2` passes every clause. `test/engine.test.ts` fails the last one, and would fail
 * it even if `test` were still a recognized branch kind — which is what makes this a fix to the
 * grammar rather than a narrowing of a word list.
 */
export function isBranchRefName(value: string): boolean {
	if (value.length === 0 || value.length > 64) return false;
	if (value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
	if (value.includes("//") || value.includes("..") || value.includes("@{")) return false;
	const components = value.split("/");
	for (const component of components) {
		if (component.length === 0) return false;
		if (component.startsWith(".")) return false;
		if (component.endsWith(".lock")) return false;
		if (!/^[A-Za-z0-9._-]+$/u.test(component)) return false;
	}
	return !FILENAME_EXTENSION.test(components[components.length - 1] ?? "");
}

/**
 * The characters that continue an identifier for the purpose of a *left* boundary.
 *
 * `\b` is the wrong boundary for a token that may be part of a longer hyphenated name. It asks
 * whether the previous character is a word character, and `-` is not one — so `\bfork\/` matches
 * inside the GitHub organisation name `repoe-fork`, and `repoe-fork/poe2` reads as remote `fork` plus
 * branch `poe2`. That single mechanism produced **33 of `branch_remote_ref`'s 36 errors** on the
 * Phase 6 fresh sample, and 33 of that sample's 49 errors overall.
 *
 * The repair is to state the boundary the rule actually needs: a remote name must be a *whole token*,
 * so it may not be preceded by an alphanumeric, an underscore or a hyphen. `.` and `/` are
 * deliberately *not* in the class, and both exclusions are load-bearing in the other direction:
 * `## main...origin/main` is `git status -sb`'s ahead/behind line and `refs/remotes/origin/main` is
 * the canonical remote-tracking path, and both are genuine remote refs that a `\W`-style boundary
 * would have thrown away along with the organisation names.
 */
const IDENTIFIER_LEFT_BOUNDARY = /[A-Za-z0-9_-]$/u;

function notInsideIdentifier(text: string, start: number): boolean {
	return start === 0 || !IDENTIFIER_LEFT_BOUNDARY.test(text.slice(start - 1, start));
}

/**
 * A word that only makes sense if a branch or a ref is under discussion, immediately before the
 * match (whitespace only in between) — or the literal word `branch` immediately after it.
 *
 * **Adjacency is the point, not the vocabulary.** A marker anywhere "nearby" would be satisfied by
 * the ambient vocabulary of a repository conversation, and the errors this is aimed at all sit inside
 * paths and prose that such a window would happily admit. Requiring the marker to be the *previous
 * token* is what refuses `../target/release/attack_poc`, `CI/release/documentation fixes` and
 * `threadweaver-skilltree-release/v2` on the same clause — in each the previous token is `target/`,
 * `CI/` or `skilltree-`, not a word about branches.
 *
 * The vocabulary is git's own porcelain — the commands that take a branch argument — plus the noun
 * itself and the directional prepositions `branch_directional` already uses. It is not a stoplist and
 * it does not grow when a new false positive appears; it is the set of words that put a ref in the
 * sentence.
 */
const BRANCH_CONTEXT_BEFORE =
	/(?:^|[^A-Za-z0-9_-])(?:branch(?:es)?|checkout|checked\s+out|switch(?:ed)?|merge[sd]?|merging|rebase[sd]?|rebasing|cherry-pick(?:ed)?|push(?:ed|es)?|pull(?:ed|s)?|fetch(?:ed)?|cut|track(?:s|ed|ing)?|PR|HEAD|on|onto|from|into|to|against)\s+$/iu;
const BRANCH_CONTEXT_AFTER = /^\s+branch(?:es)?\b/iu;

function hasBranchContext(text: string, start: number, end: number): boolean {
	return BRANCH_CONTEXT_BEFORE.test(text.slice(0, start)) || BRANCH_CONTEXT_AFTER.test(text.slice(end));
}

/**
 * The rules, in evaluation order. Earlier rules claim their character span, so a later rule cannot
 * re-attribute the same text — the same span-claiming discipline `task.ts:extractEntities` uses, and
 * for the same reason: without it `origin/release/1.2` would count as one branch and two, and a
 * per-claim qualifier count would be measuring regex overlap rather than subject matter.
 */
const RULES: readonly QualifierRule[] = [
	// `origin/main`, `upstream/release/2.1`. A remote name, a slash, and a ref.
	//
	// **CORRECTED AFTER PHASE 6 — measured 158 correct out of 194, and 33 of the 36 errors are one
	// mechanism.** Two corrections, and as with `branch_kind_prefix` each removes a class of error the
	// other does not:
	//
	// 1. **The remote name must be a whole token** (`notInsideIdentifier`). `\b` let `fork` match
	//    inside the GitHub organisation name `repoe-fork`, so `repoe-fork/poe2` and every
	//    `api.github.com` URL beneath it read as remote `fork` + branch `poe2/…`. That is 33 of the 36.
	// 2. **The capture must parse as a Git ref name**, the same `isBranchRefName` grammar
	//    `branch_kind_prefix` already uses, applied here for the first time rather than invented for
	//    the occasion. It is what refuses `origin/main..HEAD` and `origin/main...HEAD` — revision
	//    *ranges* whose extracted value `main..head` is not the name of anything — and
	//    `upstream/.test(line)`, a JavaScript regex call whose capture begins with a dot.
	//
	// What neither correction reaches, stated rather than patched: `origin/allowlist` and
	// `upstream/human` are prose slash-pairs meaning "origin or allowlist", and they are legal ref
	// names preceded by nothing. A rule keyed on shape cannot see the conjunction.
	{ kind: "branch", ruleId: "branch_remote_ref", pattern: /(?:origin|upstream|fork)\/([A-Za-z0-9._-][A-Za-z0-9._/-]{0,48})/gu, group: 1, accept: isBranchRefName, context: (text, start) => notInsideIdentifier(text, start) },
	// `feature/parser-v2`, `release/2.1`, `hotfix/oncall`.
	//
	// **CORRECTED AFTER PHASE 2 — measured 0 correct out of 23, and the defect was two conflated
	// vocabularies plus a missing grammar.** The rule read `feature|feat|release|hotfix|bugfix|fix|
	// chore|docs|test|refactor` followed by a slash, and every one of its 23 live hits was a
	// repository path (`test/engine.test.ts`, `docs/operations.md`, `docs/`). Two independent
	// corrections, and each removes a class of error the other does not:
	//
	// 1. **The first component must name a kind of *branch*.** `docs`, `test`, `fix`, `chore` and
	//    `refactor` are not branch kinds. `docs` and `test` are the ordinary names of directories —
	//    both exist in this repository and in akashic-forge — and `fix`, `chore` and `refactor` are
	//    Conventional Commits *types*, a vocabulary that names commits, not branches. The set kept is
	//    git-flow's documented branch prefixes (`feature`, `bugfix`, `release`, `hotfix`, `support`)
	//    plus the abbreviation `feat`, which is not a directory name in any common source layout.
	//    Two different conventions were being read as one, and a word both vocabularies use cannot
	//    tell a directory from a branch.
	// 2. **The capture must parse as a Git ref name** (`isBranchRefName`). This is the half that does
	//    not depend on the word list: it is what rejects `feature/notes.md`, `docs/` and
	//    `release/..\hack`, and it would have rejected 22 of the 23 Phase 2 errors on its own.
	// 3. **A branch must be under discussion** (`hasBranchContext`), added after Phase 6 measured the
	//    corrected rule at **0 correct out of 7** on a fresh sample. The Phase 2 failure mode was gone —
	//    not one repository path under `test/` or `docs/` survived — and a *different* one was
	//    underneath it: `release/security audit` and `CI/release/documentation fixes` are slashes
	//    written in prose as conjunctions, `../target/release/attack_poc` is a Rust build path,
	//    `threadweaver-skilltree-release/v2` is a schemaVersion string. **Every one of the seven is a
	//    legal Git ref name**, so the grammar cannot reach them. What they lack is a neighbouring word
	//    that puts a branch in the sentence, and that is the discipline the two rules that measured
	//    well already have: `branch_quoted` (2/2) requires the literal word `branch`,
	//    `branch_directional` requires a preposition. This is the same requirement, stated for a rule
	//    whose shape spans a slash.
	{ kind: "branch", ruleId: "branch_kind_prefix", pattern: /\b((?:feature|feat|release|hotfix|bugfix|support)\/[A-Za-z0-9._-][A-Za-z0-9._/-]{0,48})/gu, group: 1, normalize: stripRemote, accept: isBranchRefName, context: hasBranchContext },
	// `branch \`foo\``, `branch "foo"`. A quoted span immediately after the word is the author
	// naming a branch on purpose; an unquoted word after it is usually a verb.
	{ kind: "branch", ruleId: "branch_quoted", pattern: /\bbranch(?:es)?\s+[`'"]([A-Za-z0-9._/-]{1,48})[`'"]/giu, group: 1, normalize: stripRemote },
	// `deploy from main`, `merged into develop`. A directional preposition plus one of the four
	// branch names this ecosystem actually uses. Restricted to that closed set because
	// `from the release` is a noun phrase and `from main` is not.
	{ kind: "branch", ruleId: "branch_directional", pattern: /\b(?:on|from|onto|into|off|against|to)\s+(main|master|develop)\b/giu, group: 1 },
	// `the release branch`, `the main branch`. The word `branch` as a head noun with a modifier.
	{ kind: "branch", ruleId: "branch_named_noun", pattern: /\b(main|master|develop|release|staging)\s+branch\b/giu, group: 1 },

	// `in production`, `on staging`. The preposition is required: `production code` is an adjective.
	{ kind: "environment", ruleId: "env_preposition", pattern: /\b(?:in|on|to|against|for)\s+(production|prod|staging|stage|sandbox)\b/giu, group: 1 },
	// `the staging environment`, `a test environment`.
	{ kind: "environment", ruleId: "env_noun", pattern: /\b(production|prod|staging|stage|development|dev|test|testing|sandbox|local|ci)\s+environments?\b/giu, group: 1 },
	{ kind: "environment", ruleId: "env_node_env", pattern: /\bNODE_ENV\s*[=:]\s*["']?([A-Za-z_]{2,20})["']?/gu, group: 1 },
	// The platform a statement was observed on. This corpus is a Windows machine talking about
	// cross-platform behaviour, so `on Windows` genuinely qualifies a claim's validity.
	{ kind: "environment", ruleId: "env_platform", pattern: /\b(?:on|under|for)\s+(Windows|Linux|macOS|darwin|win32|WSL)\b/giu, group: 1 },
	{ kind: "environment", ruleId: "env_ci", pattern: /\b(?:in|on|under)\s+(CI)\b/gu, group: 1 },
];

/** Values that are never a real qualifier however the shape matched. Kept minimal and structural. */
const REJECTED_VALUES: ReadonlySet<string> = new Set(["", "-", "_", "."]);

/**
 * Every branch and environment qualifier the rules find in one text, in span order.
 *
 * Overlapping matches are resolved by span claiming, earliest rule first. Duplicates of the same
 * `(kind, value)` collapse to their first occurrence: a claim that says `main` three times is one
 * claim about `main`, and counting it three times would make repetition look like corroboration.
 */
export function extractQualifiers(text: string): QualifierHit[] {
	const claimed: Array<[number, number]> = [];
	const hits: QualifierHit[] = [];
	const seen = new Set<string>();

	for (const rule of RULES) {
		rule.pattern.lastIndex = 0;
		for (const match of text.matchAll(rule.pattern)) {
			const raw = match[rule.group];
			if (raw === undefined) continue;
			const start = match.index ?? 0;
			const end = start + match[0].length;
			if (claimed.some(([from, to]) => start < to && end > from)) continue;
			// Checked before the capture is even normalized, and like `accept` it does not claim the
			// span: a rule that says "the text around this is not about a branch" has declined, and a
			// declined span must stay visible to every later rule.
			if (rule.context !== undefined && !rule.context(text, start, end)) continue;
			const normalized = (rule.normalize === undefined ? raw : rule.normalize(raw)).toLowerCase().replace(/[.,;:)\]]+$/u, "");
			if (REJECTED_VALUES.has(normalized)) continue;
			// A rule that declines a capture does not claim its span: declining is "this is not mine",
			// not "this is mine and empty", and consuming the text would hide it from every later rule.
			if (rule.accept !== undefined && !rule.accept(normalized)) continue;
			claimed.push([start, end]);
			const key = `${rule.kind}:${normalized}`;
			if (seen.has(key)) continue;
			seen.add(key);
			hits.push({ kind: rule.kind, value: normalized, ruleId: rule.ruleId, matchedText: match[0], start, end });
		}
	}

	hits.sort((a, b) => a.start - b.start);
	return hits;
}

/** The distinct qualifier values of one kind, sorted, for comparison between two claims. */
export function qualifierValues(hits: readonly QualifierHit[], kind: QualifierKind): string[] {
	return [...new Set(hits.filter((hit) => hit.kind === kind).map((hit) => hit.value))].sort();
}

/**
 * Whether two claims' qualifiers of one kind are in genuine disagreement.
 *
 * Both sides must carry at least one qualifier and the sets must be disjoint. A claim with no
 * qualifier is *unqualified*, not *qualified differently* — the overwhelmingly common case on this
 * corpus — and treating absence as a difference would report a `BRANCH_DIFFERENCE` between a
 * statement about `main` and a statement about nothing in particular, which is the false positive
 * this whole extractor is gated on avoiding.
 */
export function qualifiersDiverge(a: readonly QualifierHit[], b: readonly QualifierHit[], kind: QualifierKind): { diverges: boolean; left: string[]; right: string[] } {
	const left = qualifierValues(a, kind);
	const right = qualifierValues(b, kind);
	if (left.length === 0 || right.length === 0) return { diverges: false, left, right };
	const overlap = left.some((value) => right.includes(value));
	return { diverges: !overlap, left, right };
}

/* ------------------------------------------------------------------------------------------------
 * The measurement gate (design §17 ambiguity 4)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether extracted qualifiers may influence **ranking**.
 *
 * Design §17 ambiguity 4: "deferred to Phase 2 behind a measurement gate before it influences
 * ranking". Design §16's Phase 2 addition pre-registers the bar at **precision ≥ 0.80 over a
 * labelled sample of at least 20 hits drawn from the live corpus**, matching the conflict-precision
 * bar already written there.
 *
 * ## MEASURED IN PHASE 2 — 0.281 over 32 labelled hits. The gate FAILED and the answer was no.
 *
 * `eval/qualifier-eval.ts` ran the extractor over 802 claims — every claim the nineteen labelled
 * gold retrieval tasks accept, every claim from all fourteen live compaction summaries, and all ten
 * curated memories — and produced 32 distinct hits, labelled one by one in
 * `eval/qualifier-labels.json`:
 *
 * ```
 * branch_remote_ref     9 hits    9 correct    1.000
 * branch_kind_prefix   23 hits    0 correct    0.000
 * every other rule      0 hits         —           —
 * ```
 *
 * Phase 2 **left the failing rule in place**, because deleting it and re-measuring the same 32 hits
 * gives 1.000 over the surviving nine, and a precision obtained by removing the rule that generated
 * the errors *after seeing which errors it generated* is a fitted pass. It pre-registered the
 * correction instead: fix the rule, then measure on a sample drawn **after** the change.
 *
 * ## RE-MEASURED AFTER THE CORRECTION — 0.784 over 227 fresh hits. The gate STILL FAILS.
 *
 * `branch_kind_prefix` is corrected above (two independent changes: a branch-kind vocabulary, and
 * `isBranchRefName`'s positive Git ref grammar). The fresh sample is **every one of the 11,182 live
 * conversation events**, extracted through the genuine pipeline into 11,903 claims, yielding 227 hits
 * whose keys are disjoint from the 32 — labelled by hand in `eval/qualifier-labels-fresh.json`
 * before the number was computed.
 *
 * ```
 *                    fresh sample            diagnostic set (the Phase 2 population, for comparison)
 * branch_remote_ref  194 hits  158 correct  0.814      9 hits   9 correct  1.000
 * branch_kind_prefix   7 hits    0 correct  0.000      0 hits          —       —   (23 errors removed)
 * branch_quoted        2 hits    2 correct  1.000
 * branch_directional   4 hits    2 correct  0.500
 * env_platform        12 hits   12 correct  1.000
 * env_ci               2 hits    2 correct  1.000
 * env_preposition      6 hits    2 correct  0.333
 * overall            227 hits  178 correct  0.784      9 hits   9 correct  1.000
 * ```
 *
 * **The correction worked and the gate still fails, and those are two separate findings.** All 23
 * Phase 2 errors are gone and not one repository path under `test/` or `docs/` survives. What the
 * fresh draw exposes is that the *dominant* rule, not the corrected one, is where the volume of
 * error now is: `branch_remote_ref`'s `\b(?:origin|upstream|fork)\/` matches inside the GitHub
 * organisation name `repoe-fork`, so `repoe-fork/poe2` and every `api.github.com` URL beneath it
 * reads as remote `fork` + branch `poe2/…` — 33 of its 36 errors, and 33 of the sample's 49. That
 * failure mode does not exist in the Phase 2 population at all, which is precisely why the sample
 * had to be drawn again rather than re-scored.
 *
 * **`branch_kind_prefix` is 0 for 7 on the fresh sample, and is again left in place.** Its new
 * errors are a different class from its old ones — `release/security audit` and
 * `CI/release/documentation fixes` are slashes written in prose as conjunctions, and
 * `../target/release/attack_poc` is a build output path — and every one of the seven is a *legal*
 * Git ref name, so no refinement of the ref grammar reaches them. The residual defect is that the
 * `kind/name` shape carries no evidence that a branch is being *discussed*; the repair would be to
 * require a contextual marker, as `branch_quoted` (2/2) and `branch_directional` do. That is
 * recorded as the next thing to measure, on a sample drawn after *that* change.
 *
 * ## RE-MEASURED AFTER THE SECOND ROUND OF CORRECTIONS — 0.837 over 620 third-sample hits. **PASS.**
 *
 * Both defects above are corrected (`branch_remote_ref`'s left boundary and ref grammar;
 * `branch_kind_prefix`'s contextual marker), and the gate was measured a third time on a sample drawn
 * **after** those changes.
 *
 * **The third population had to be a different part of the corpus, and the reason is arithmetic.**
 * Both corrections are *narrowings*, so re-running the head-excerpt sweep can only produce a subset of
 * the 227 already labelled — measured, **196 hits of which 0 are unlabelled**. The corpus has not
 * grown (11,182 events) and the ten curated memories are in the diagnostic set. What was left is the corpus itself: `claims.ts:excerptFor` hands a
 * briefing a 481-character window, the head-excerpt sweep read offset 0 of every event and nothing
 * else — **5.4 MB of 44.4 MB** — and a lexical search anchors that window anywhere. The third sample
 * is every remaining window, tiled from offset 481, all 86,594 of them, hand-labelled in
 * `eval/qualifier-labels-third.json` before the number was computed.
 *
 * ```
 *                     third sample (THE GATE)      diagnostic 1 (Phase 2)   diagnostic 2 (Phase 6)
 * branch_remote_ref   320 hits  299 correct  0.934   9 hits  9  1.000       163 hits  158  0.969
 * branch_kind_prefix    0 hits    —              —   0 hits  —      —         0 hits    —      —
 * branch_quoted        39 hits   36 correct  0.923                            2 hits    2  1.000
 * branch_directional   13 hits    3 correct  0.231                            4 hits    2  0.500
 * branch_named_noun    19 hits   19 correct  1.000
 * env_preposition      94 hits   27 correct  0.287                            6 hits    2  0.333
 * env_noun              2 hits    2 correct  1.000
 * env_node_env          1 hit     1 correct  1.000
 * env_platform         84 hits   84 correct  1.000                           12 hits   12  1.000
 * env_ci               48 hits   48 correct  1.000                            2 hits    2  1.000
 * OVERALL             620 hits  519 correct  0.837   9 hits  9  1.000       189 hits  178  0.942
 * ```
 *
 * **Both prior samples are diagnostics and neither is the gate.** Each correction was written after
 * reading the errors in them, so 1.000 and 0.942 report how much known error the fixes removed and
 * nothing about text the rules have not seen.
 *
 * **The aggregate hides a spread, and the spread is why the wiring below is what it is.** 0.837 is a
 * mixture of five rules at 0.923–1.000 and two at **0.231** (`branch_directional`) and **0.287**
 * (`env_preposition`). `branch_directional` is convicted by the third sample: `off main thread`,
 * `into main context`, `from main-tree allocation`, `to main site`, `on main-hand` — a directional
 * preposition proves direction, not that a branch is being named, and `main` is an ordinary English
 * adjective. `env_preposition`'s 67 errors are 57 hits of `sandbox` naming a tool's execution or
 * storage location. Both are recorded as the next thing to correct, and neither was corrected in this
 * pass, because they were found *in the sample that decides the gate* and repairing them now would be
 * repairing the system toward the evidence.
 *
 * **`branch_kind_prefix` now fires zero times on the whole corpus**, and that is disclosed rather
 * than presented as a win. The contextual-marker requirement is the repair design §23 pre-registered,
 * its contract is exercised by unit tests, and this corpus simply contains no git-flow-prefixed branch
 * reference. Its contribution to the gate is nil, so the gate does not test it.
 *
 * ## Consequence: `enabled = true`, and what that does and does not turn on
 *
 * **What it turns on** is the one place a qualifier can reach a *score*: a `QUALIFIES` edge suppresses
 * the `CONTRADICTS` test for that pair (`provenance.ts`), and `contradictions` is a term in
 * `evidence_strength` (design §9). Two statements about two different branches disagree about
 * nothing, so the `−0.15` should not be charged — but charging or not charging it on the strength of a
 * 0.281-precise extractor was exactly the silent damage §17 ambiguity 4 gated. That suppression is now
 * *conditional on this flag*, which is the mechanical meaning the flag previously lacked.
 *
 * **What it does not turn on is a weight, and that is not this code's decision to make.** The obvious
 * next step — a relevance bonus when a claim's qualifiers match the qualifiers the *task* names —
 * would add a field to `RankingPolicy.relevanceBonus`, and `policy.ts` is what design §19 item 3
 * reserves for a human, with a §22 change packet. Every prior change to that table was declared as an
 * approval item and a version bump. It is pre-registered here, not applied, and the per-rule spread
 * above is the evidence a reviewer needs: an aggregate 0.837 multiplied into a score would carry
 * `branch_directional`'s 0.231 in with it.
 *
 * Conflict **classification** reads the qualifiers either way, as it always has: design §2 assigned
 * them that job, and a `BRANCH_DIFFERENCE` record is a disclosure the reader can check rather than a
 * number multiplied into a score they cannot see.
 */
export const QUALIFIER_RANKING: { enabled: boolean; measuredPrecision: number | null; sampleSize: number; gate: number; decidedBy: string } = Object.freeze({
	enabled: true,
	measuredPrecision: 0.837,
	sampleSize: 620,
	gate: 0.8,
	decidedBy:
		"eval/qualifier-eval.ts, third sample — every 481-character claim window of the live corpus the head-excerpt sweep never read, labelled in eval/qualifier-labels-third.json before the number was computed and disjoint by assertion from both prior label sets (0 of 620 keys collide). The two prior measurements are retained as diagnostics: 0.281 over 32 in eval/qualifier-labels.json and 0.784 over 227 in eval/qualifier-labels-fresh.json, each over a population whose errors motivated a later correction — see PHASE0-DESIGN.md §17 ambiguity 4",
});
