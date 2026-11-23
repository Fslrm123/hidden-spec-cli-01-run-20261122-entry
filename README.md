# hidden-spec-cli-01-run-20261122-entry

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Fslrm123/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Fslrm123/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** — one patch tool for every AI edit format. It reads the edits AI models write, in four formats — unified diffs (with wrong line numbers, prose and code fences around them), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — finds the lines they name even when whitespace or indentation has drifted, and applies every edit to a tree of files, or none of them. A failed edit changes nothing, and a patch with any failure writes nothing at all.

Matching works at three tiers: exact lines first, then trailing whitespace ignored, then leading and trailing whitespace ignored (with the new lines re-indented to the file's own indentation). CRLF files keep their line breaks, files without a final line break keep it missing, and ambiguous or unsafe edits are refused with a precise error instead of a guess.

## Run it

```sh
node main.ts [--format=unified|search-replace|v4a|json|auto] [--check] [--strict] [PATCH]
```

`PATCH` is a file, or standard input when it is absent or `-`. Exit 0 means every edit applied (or would, with `--check`); exit 1 lists each failed edit; exit 2 is a usage, format or parse error. Node 22 or later, standard library only.

---

<sub>Entered on [make.fun](https://make.fun/?ref=3v2j7j85&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
