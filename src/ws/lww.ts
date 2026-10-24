// The .lww rule file: gitignore-style rules that name the paths where the side modified later wins a merge.
// Ported from the LayerFS decision model (model.js lwwRules and lwwMatch, MIT; see NOTICE and merge.ts).

export const INCLUDE_MAX = 16;

export interface LwwRule {
	pattern: string;
	neg: boolean;
	re: RegExp;
}

/**
 * Rules from the text of a .lww file, in order. `# comment` and blank lines are skipped; `!` negates; a `/` inside a
 * pattern anchors it to the root; `*` and `?` stay inside one name, `**` crosses folders. `%include <file>` splices the
 * rules of another file, read through `readInclude` (undefined when absent); a file already read is skipped, and at
 * most INCLUDE_MAX files are included, the rest ignored. A path nothing matches stays a conflict, so a dropped include is safe.
 */
export function lwwRules(text: string, readInclude: (file: string) => string | undefined): LwwRule[] {
	const seen = new Set<string>();
	const parse = (body: string): LwwRule[] => {
		const rules: LwwRule[] = [];
		for (let line of body.split("\n")) {
			line = line.trim();
			if (!line || line.startsWith("#")) continue;
			const inc = /^%include\s+(\S+)$/u.exec(line);
			if (inc) {
				const file = inc[1]!.replace(/^\/+/u, "");
				if (seen.has(file) || seen.size >= INCLUDE_MAX) continue;
				seen.add(file);
				const included = readInclude(file);
				if (included !== undefined) rules.push(...parse(included));
				continue;
			}
			const neg = line.startsWith("!");
			let pat = (neg ? line.slice(1) : line).replace(/\/$/u, "");
			const anchored = pat.includes("/");
			pat = pat.replace(/^\//u, "");
			const rx = pat.split("**").map((s) => s.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]")).join(".*");
			rules.push({ pattern: line, neg, re: new RegExp(`${anchored ? "^" : "(^|/)"}${rx}($|/)`) });
		}
		return rules;
	};
	return parse(text);
}

/** The rule that decides `path`: the last matching rule, or null when it is a `!` rule or none matches. */
export function lwwMatch(rules: LwwRule[], path: string): LwwRule | null {
	let hit: LwwRule | null = null;
	const p = path.replace(/^\//u, "");
	for (const r of rules) if (r.re.test(p)) hit = r.neg ? null : r;
	return hit;
}
