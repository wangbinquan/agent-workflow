# RFC-398 release upgrade tools

Use Bun 1.4.3 (`~/.bun/bin/bun`). These tools own no product startup or migration
policy. They obtain old executables, build isolated recording homes through their
public HTTP APIs, stop them, and retain evidence for the later L1 builder, seed
ledger, and candidate verifier. No command modifies GitHub releases, tags or runs.

## Registry

```sh
~/.bun/bin/bun scripts/release-upgrade/registry.ts --write
~/.bun/bin/bun scripts/release-upgrade/registry.ts --check
```

Both commands require complete local `v*` tags and authenticated `gh` read access.
They read Git objects without a checkout, worktree or index mutation. `--check`
regenerates in memory and compares the checked-in bytes, including referenced SQL
and historical PostgreSQL journals. It does not run tests. The offline registry
test reads the committed fixture and frozen chain and requires neither Git nor `gh`.

- SQLite receipts contain each journal entry's original `when` as `created_at` and
  SHA-256 of the complete UTF-8 SQL, before splitting statement breakpoints. They
  are not hashes of statements, normalized SQL, or current replacement bytes.
- `releasedSql` stores original bytes by digest. In the initial inventory this
  includes SQLite 0095 and 0111, and the two original PostgreSQL baselines.
- `epoch1.postgresql` describes baseline-plus-upgrade history. A fresh database
  installs the release's head plan directly and writes one baseline receipt;
  `postgresqlFresh` records that distinct valid shape. T9's sequential L1 builder
  uses the former; the L2 recorder captures whichever shape the binary writes.
- v0.18.18/v0.18.19 point to independent T3b production bundles. The original tag
  journals are retained here so this slice can be checked without T3b being done.
- Epoch-2 releases have `epoch1: null` and their native history identity in
  `epoch2`. The frozen epoch-1 files shipped inside v0.19.3 are not receipts of a
  new v0.19.3 installation.
- `buildKey` hashes schema/receipt identities and released SQL digests, excluding
  provenance fields such as tag, download source or runtime protocol. `l1Builds`
  is the explicit deduplicated execution plan; `nightlyShards` includes every
  Linux x86_64 binary, including entries currently blocked as unsupported.

The initial gate selection covers v0.1.0, v0.10.0, v0.16.3, v0.18.10, v0.18.18,
v0.18.19, v0.19.2 and v0.19.3. The latest registered version is always selected.
These are planned mappings, not evidence that T9/T11 has executed them.

## Acquisition and daemon API

`lib/binaries.ts` exports `resolveBinary(release, options)`. Published assets have
evidence level 1, retained v0.19.3 assets level 2, and a tag build level 4. Every
asset and every cache hit is verified against the registry SHA-256. A checksum
mismatch is terminal. Missing/unavailable assets can fall back to `git archive
<tag>` plus `bun install --frozen-lockfile` and `bun run build:binary`, using the
tag's exact `packageManager` Bun version. No repository clone, Git worktree, or
branch is created. Set `allowTagBuild: false` for a strict release-evidence run.

The fallback measures and records its own binary digest; it does not claim that
the rebuilt bytes match the published executable. Supply `bunExecutable` to use
an already installed exact version; otherwise `gh` downloads that version of Bun
into the OS-temp cache. The cache defaults to
`<os.tmpdir()>/agent-workflow-release-upgrade`.

`lib/daemon.ts` exports `startOldDaemon`, `oldCli`, and `daemonEnvironment`. Each
home is isolated with `AGENT_WORKFLOW_HOME`. Its preseeded config points at a small
compiled transport adapter which delegates to
`dist/stub-opencode-<platform>[.exe]`. The adapter reports the version required by
that tag's source, adds/removes an envelope nonce for pre-RFC-200 releases, and
selects the existing clarify stub for the question scenario. Business output is
produced by the repository's compiled `business-workflows` stub. Cancellation has
an explicit held invocation; the failure task deliberately omits a required
business prompt condition. No real model provider is called.

The driver captures stdout and stderr together, waits for HTTP readiness, and
requires a graceful stop before recording/removing sidecars. Source-based runtime
capabilities are saved per release, so consumers need no Git access at runtime.

## Seed a home

```sh
~/.bun/bin/bun scripts/release-upgrade/scenario.ts --tag v0.19.2 --variant sqlite
~/.bun/bin/bun scripts/release-upgrade/scenario.ts --tag v0.19.2 --variant sqlite-no-sidecar
~/.bun/bin/bun scripts/release-upgrade/scenario.ts --tag v0.19.2 --variant postgresql --postgresql-url-env AW_UPGRADE_SOURCE_URL
~/.bun/bin/bun scripts/release-upgrade/scenario.ts --tag v0.18.19 --variant postgresql-restricted-role --postgresql-url-env AW_UPGRADE_RESTRICTED_URL
~/.bun/bin/bun scripts/release-upgrade/scenario.ts --tag v0.10.0 --variant chain --chain v0.19.2
```

The PostgreSQL URL must point to an empty dedicated database. The restricted
variant requires a role with neither `CREATEDB` nor superuser privileges. The
optional `provisionPostgresqlFixture(adminUrl, restricted)` helper creates a
fresh database/role and returns explicit cleanup; no database is dropped on a
scenario failure. The old binary runs its own one-click migration and then makes
another round of live HTTP writes on PostgreSQL. The RFC-349 operation remains
`accepting-writes`; the tooling does not call status/finalize and accidentally
refresh its first-write marker. Candidate permission refusal, DBA SQL execution,
and restart assertions belong to `verify.ts`.

The client handles daemon-token auth, session auth, first-admin bootstrap, password
login, and the newer mandatory email/Git-name profile. It creates users, agents,
skills, MCPs, workflows, schedules, workgroups and memories where that version has
the feature. Modern releases also import both business YAML samples. The five
task states use a small graph based on the samples' repair agent so early releases
can exercise their existing semantics without pretending they implement later
fanout contracts. A feature absent in an old release is recorded in `unavailable`;
an unexpected API error fails seeding rather than being treated as an exemption.

The task repository is a disposable local repository served over smart HTTP by
the existing `packages/system-mocks/src/git/http.ts` implementation. Very early
releases only accept a local repository path; their capability entry selects that
path. No development checkout is used as a task repository.

Programmatic use by the later candidate verifier:

```ts
const scenario = await prepareScenario({ release, variant: 'sqlite-no-sidecar' })
try {
  // Old daemon has stopped. Git server stays alive for resumed/new candidate work.
  // Start candidate with scenario.manifest.home and scenario.env.
  // Compare against scenario.projections and resume scenario.manifest.seeds tasks.
} finally {
  await scenario.dispose() // stops the Git server; retains the home and evidence
}
```

`release-upgrade-scenario.json` records exact binary evidence, seeded identities,
Git location, PostgreSQL variable name and candidate work still required.
`release-upgrade-api-before.json` captures identities and business state for all
seeded resources, task bodies, node runs/output values, and pending review/question
details. `captureProjections` and `projectRows` are exported for T10's verifier.
The standalone CLI stops its Git server on exit; use the programmatic API for
candidate execution in the same orchestration lifetime.

## Recording

```sh
~/.bun/bin/bun scripts/release-upgrade/record.ts dataset --home /path/to/stopped-home --output /path/to/new-dataset --tag v0.19.2
~/.bun/bin/bun scripts/release-upgrade/record.ts dataset --home /path/to/stopped-home --output /path/to/new-dataset --tag v0.19.2 --provider postgresql --url-env AW_UPGRADE_SOURCE_URL
~/.bun/bin/bun scripts/release-upgrade/record.ts import-finalize --source /path/to/fixtures-rfc349
```

`dataset.json` lists all physical tables, ordered column metadata, canonical JSONL
rows and content-addressed files. Empty tables are retained explicitly. Values
use JSON with `$bigint`, `$bytes` (base64), `$timestamp` (ISO) and `$number` tags for
otherwise lossy values. Rows are sorted independently of database row order.
The recording home's absolute path becomes `<AW_HOME>` in nested values, embedded
JSON strings and UTF-8 content. Content metadata preserves both the raw source
digest and normalized digest. T8 `derive` should consume this format and project
onto the columns that existed at each migration, without treating a recording as
the independent migration oracle.

SQLite recording reads a disposable byte copy of a cleanly stopped database;
nonempty WAL is refused. PostgreSQL recording uses a read-only repeatable-read
transaction. Neither recorder changes the source. Dataset output must be empty
and outside the home. Content defaults to skills, content, artifacts, runs,
snapshots, worktrees and archives, excluding Git internals and node_modules.

`import-finalize` imports the supplied v0.19.2/v0.18.19 equivalence captures. It
keeps raw home bytes and gzip-compresses the dumps, records omitted chunk/backup
files and SHA-256s in each README, and enforces 1,000,000 bytes per version. These
fixtures test finalize equivalence, not a full logical-copy restore. Raw capture
files must not be rewritten or normalized; T4 rebinds a working copy explicitly.

## Deviations and remaining integration

- v0.17.0–v0.17.11 and v0.18.0–v0.18.1 cannot execute this stub through their
  published production runtime: RFC-224 admits only official OpenCode bytes and
  uses a direct-API launcher. This is recorded as `l2.unsupported` with source
  evidence. **User approval is still required for those 14 exclusions.** They
  remain in the nightly mapping and `prepareScenario` fails clearly if selected;
  no approved waiver or successful L2 execution is implied.
- Releases predating users, MCPs, schedules, workgroups, memory, or clarify record
  the feature's absence. They still have L1 and L2 mappings. Early workflow graphs
  use the business repair node plus the then-supported review/clarify protocol.
- Only the supplied before/after finalize states are imported. The separate
  pre-first-live-write state described in design §4 is left for later recording.
- CI artifacts are not needed for this inventory: all v0.19.3 artifacts already
  exist as retained assets. The resolver supports the available release and
  retained sources plus tag-build; no expiring artifact path is introduced.
- T8 owns seed derivation, all-table seed coverage, and the independent mapping
  oracle. T9 owns execution of `l1Builds`. The rest of T10 owns candidate checks,
  pending-gate continuation and the withdrawn-version negative control. T11 owns
  CI wiring and actual shard/gate execution. This slice adds no workflow files.
- No behavioral suite or old-daemon scenario is executed during this development
  handoff. Fixture generation and scoped static checks are separate evidence.
