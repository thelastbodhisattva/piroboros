# Development

[Back to the README](../README.md)

This page applies to a source checkout. `src/tune` is not in the npm package.

```
npm run typecheck
npm run build
```

`npm run build` writes `dist/`, the step `npm pack` runs before packing. The launcher never runs a `dist/` found in a checkout. The repository has no test suite.

Versions follow semver. See `CHANGELOG.md`.

## Compactor prompt tuning

`npm run tune:compactor` runs the real compaction prompts over 12 made-up coding chats (8 dev, 4 held-out, in `src/tune/corpus`) and scores each produced line against fixed probes: exact tokens that must survive, and corrected values that must replace the old one. A candidate in `src/tune/candidates` is kept only if its held-out mean beats the baseline by `--margin` (default 0.02), its dev mean does not drop, and no probe type drops on the held-out chats. The script prints a verdict and never edits `src`; apply a winning candidate to `src/chat/prompt.ts` yourself, then delete its file. A candidate is a JSON file `{ "name", "messageTaskSuffix"?, "mergeTaskSuffix"? }`. The first one, the "was X, now Y (replaced)" rule for merges, won over three repeats (held-out 0.671 to 0.814, corrections kept 4% to 58%) and is now part of the merge task.

```
npm run tune:compactor -- --dry-run
npm run tune:compactor -- --yes
```

It uses the compactor model from your `settings.json` (or `--model provider/id`) with your stored login. Other options: `--repeats N` (default 1) and `--out file.json`, which also holds a `meta` block with the date, model, thinking level, repeats, margin and each candidate's name and text. A real run needs `--yes` because it sends hundreds of requests to that provider and costs money: `--dry-run` prints the minimum call count first, and replies over 512 bytes add retries. The chats are invented and the corpus is not scrubbed or sent anywhere else.
