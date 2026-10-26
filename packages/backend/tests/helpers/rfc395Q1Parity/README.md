# RFC-395 Q-1 DTO parity (T18)

This T18 harness starts the pinned old binary on an empty home so its real
installer creates the epoch-1 SQLite database and boot seeds. After stopping it,
the fixture verifies every migration receipt against the baseline commit's frozen
journal and SQL hashes, then inserts synthetic rows. It restarts the old binary,
captures ten nonempty HTTP surfaces, stops it, invokes the new
binary's supported plan/run/verify/complete workflow, then captures the same URLs
from the target. All storage is under a new `/tmp/rfc395-q1-parity-*` home. No
branch, worktree, checkout, temporary clone, or live instance is used.

`RFC395_Q1_OLD_COMMIT` selects the old commit. If omitted, the harness resolves
`origin/main` in `RFC395_Q1_REPOSITORY` once, before creating the fixture or checking
the binary artifact. Pin the full baseline SHA **before** publishing activation;
after publication `origin/main` may already be epoch 2. Both the old binary and
all fixture SQL must come from that same commit. The fixture records every SQL
hash and the journal hash; the runner checks the artifact commit and binary hash.
The small provenance unit fixture uses the Drizzle migrator directly. Neither
path hand-recreates `__drizzle_migrations`: the old daemon fingerprints its exact
CREATE SQL, including whitespace.

T18 builds the old binary from a plain `git archive` source export. The export is
only a build input in scratch, without a Git checkout, clone, branch or worktree.
Do not develop or run gates there. From the primary checkout (commands are for
T18 only and have not been run in AF-2):

```sh
export PATH=/private/tmp/aw-rfc370-toolchain-1.4.3/bun-darwin-aarch64:$PATH
export RFC395_Q1_REPOSITORY=/Users/wangbinquan/dev/proj/agent-workflow
export RFC395_Q1_OLD_COMMIT="$(git -C "$RFC395_Q1_REPOSITORY" rev-parse origin/main)"
q1_build_dir="$(mktemp -d /private/tmp/rfc395-q1-old-build-XXXXXX)"
mkdir "$q1_build_dir/source"
git -C "$RFC395_Q1_REPOSITORY" archive --format=tar --output="$q1_build_dir/source.tar" "$RFC395_Q1_OLD_COMMIT"
tar -xf "$q1_build_dir/source.tar" -C "$q1_build_dir/source"
cd "$q1_build_dir/source"
bun install --frozen-lockfile
bun run build:binary
```

Use the exported commit's build script and its documented platform/output options
if its interface differs. Preserve its build log with the export SHA. Set
`RFC395_Q1_OLD_BINARY` to the binary actually produced, then produce its artifact
from that build (not a manually relabelled existing binary):

```sh
q1_platform="$(bun -e 'process.stdout.write(`${process.platform === "darwin" ? "macos" : process.platform}-${process.arch === "x64" ? "x86_64" : process.arch}`)')"
export RFC395_Q1_OLD_BINARY="$q1_build_dir/source/dist/agent-workflow-$q1_platform"
export RFC395_Q1_OLD_ARTIFACT="$q1_build_dir/artifact.json"
bun -e 'const path = process.env.RFC395_Q1_OLD_BINARY; const bytes = await Bun.file(path).arrayBuffer(); await Bun.write(process.env.RFC395_Q1_OLD_ARTIFACT, JSON.stringify({ commit: process.env.RFC395_Q1_OLD_COMMIT, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") }, null, 2))'
cd "$RFC395_Q1_REPOSITORY"
```

The artifact has shape `{"commit":"<full baseline SHA>","sha256":"<binary sha256>"}`.
The build provenance comes from this export/build sequence; a label alone is not
evidence that an arbitrary binary was built from the commit.

From the primary checkout, T18 runs (Q-1 must not run this):

```sh
export PATH=/private/tmp/aw-rfc370-toolchain-1.4.3/bun-darwin-aarch64:$PATH
export RFC395_Q1_REPOSITORY=/Users/wangbinquan/dev/proj/agent-workflow
export RFC395_Q1_OLD_BINARY=/absolute/path/to/baseline/agent-workflow
export RFC395_Q1_OLD_ARTIFACT=/absolute/path/to/baseline/artifact.json
export RFC395_Q1_OLD_COMMIT='replace-with-full-baseline-SHA'
export RFC395_Q1_NEW_BINARY=/absolute/path/to/activated/agent-workflow
export RFC395_Q1_T18=1
export RFC395_Q1_TARGET=sqlite
cd packages/backend
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u AW_TEST_POSTGRESQL_URL AW_TEST_PROVIDERS=sqlite perl -e 'alarm 1800; exec @ARGV' bun test --isolate --timeout 30000 tests/rfc395-q1-dto-parity.test.ts
```

Repeat with `RFC395_Q1_TARGET=postgresql` and
`RFC395_Q1_TARGET_URL_ENV=Q1_DISPOSABLE_TARGET_URL`, where that environment variable
contains the URL of a disposable PostgreSQL target reserved for this conversion.
The source remains the pinned epoch-1 SQLite fixture; the second run exercises
cross-provider conversion and all ten native PostgreSQL projections. Existing
`describeEachProvider` Q-1 tests cover native storage reads in both engines.

An equivalent standalone entry is
`bun tests/helpers/rfc395Q1Parity/run.ts`; it does not require `RFC395_Q1_T18`.
Both entry points retain source provenance, binary digests, command logs, HTTP
bytes and final result in the printed temporary home. A blocked conversion stops
before approval; no blanket acknowledgements are issued. Failure artifacts remain
in that directory. Each capture stores status, raw bytes, request window and
validation errors. Once conversion succeeds, all target surfaces are captured
even when one fails validation. `q1-result.json` then records `passed` or `failed`,
all per-surface oracle errors, and every JSON value/missing-field/key-order
difference with its JSON path and old/new values. Missing values have
`present: false`; they are never conflated with null. Raw serialization differences
are retained too. Diagnostic allowances label seq backfill and valid observation
request clocks; the original byte oracle independently determines pass/fail.

The surfaces are task detail, task summaries, task list items (`include_owner=true`),
node runs, task catalog, reviews, clarify detail, Agent detail, session view and
observation task detail. Agent relations include repeated and dangling managed
skill IDs, a project skill name, and ordered dependency/MCP/plugin references.
Session events and observation calls include the removed-node history run so
evidence-backed session identity and attempt projection are observable. Empty
list/session/observation captures and missing/reordered Agent relations fail.

Only a missing/null NodeRun `seq` becoming an integer is allowed in stored data.
The observation response also contains top-level `asOf = Date.now()` (the request
clock, not a persisted timestamp). BF-D25 records each request's start/end window,
requires `asOf` to be an integer inside that window, then compares every other
byte. Both raw responses and the clock windows are retained. Persisted timestamps,
array order, null/empty, identity, recordMode, fields and whitespace remain exact.
Target responses satisfy the shared zod schemas; observation, whose shared
response contract is TypeScript-only, has a harness schema checked against that
contract. The BF-D26 baseline tests create two tiny commits in their own temporary
repository and need no parent commit or remote in the CI checkout.
The default unit run exercises the byte oracle and explicitly skips the T18 binary
lane; that skip is not a parity acceptance result.
