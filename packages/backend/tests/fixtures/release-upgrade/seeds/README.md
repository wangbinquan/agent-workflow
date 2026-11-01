# RFC-398 release seed ledger

This ledger is data for RFC-398 T8. `seed-ledger check` reconstructs SQLite
installations from release receipts and these seeds. It does **not** run epoch
conversion, auto-upgrade, a candidate daemon, HTTP acceptance, or tests.

**Append-only rule:** after a seed for an already released migration/history point
is committed, never rewrite, remove, reorder, or replace its rows, values, content,
or expectations. Add a file at the next legitimate migration/history point.
Review immutable historical seed bytes against the base revision during later
changes. Updating a snapshot to make a failed upgrade pass is not an acceptable
fixture repair. These initial, uncommitted T8 files were curated together before
their first publication.

## Inventory and source authority

- `epoch1/<NNNN_tag>.json`: 262 ledger entries, one for every migration in the
  frozen SQLite journal, including migrations whose entry is deliberately empty.
  Rows are inserted **immediately after** that migration. Every historical table
  creation has data, either explicit seed rows or the migration's own backfill.
  SQL-created built-ins and singleton rows are not inserted twice.
- `epoch2/0000.json`: native v0.19.3 history-0000 data, covering all 232 business
  tables. `metadata-0000.json` freezes the 21 metadata declarations separately
  from the business plan. Its source catalog bytes are hash-checked.
- `../mapping-oracle.json`: independent RFC-395 dispositions, keys and value
  projections. It covers 222 current business tables, 108 retired physical tables
  at `pre-upgrade`, and 20 provider metadata/phase entries. The RFC's correction
  adding the five RFC-396 tables and the NodeRun allocator destination is included.
- `../coverage.json`: the complete table inventory and row counts for 57 distinct
  builds representing all 80 releases. Each table names its seed/backfill source.
  SQLite `sqlite_sequence` is counted, as is the release journal/epoch sentinel.
  `sqlite_schema` is the engine's virtual catalog, not a stored table returned by
  its own table inventory. It is described as metadata in the mapping oracle.
- `../exemptions-draft.md`: 18 proposed exemptions, limited to empty epoch-2
  migration metadata. Approval is pending. No business table or epoch-1 table
  exemption is proposed.
- `check-summary.md`: per-build preparation results, candidate fingerprints and
  the complete list of oracle entries sourced from rule declarations.

The authority for historical rows is the released SQL, including the original
`0095`/`0111` bytes selected by `releases.json`, and the declared product shapes.
The ledger is **curated**, not a claim that old binaries recorded these rows.
No production converter was executed, imported, or used to produce this oracle.
The authoring preparation applied only historical SQL and the immutable epoch-2
plan to disposable SQLite databases.

The latest epoch-1 release, v0.19.2, ends at `0258`; `0259`–`0262` are frozen-tail
ledger entries rather than extra receipts attributed to that release. During a
future L1 upgrade from an older release, apply the missing SQL migrations without
inserting seeds from later release points. Those seeds belong to independently
built later installations. This distinction is essential for S1 counts.

## Seed format, version 1

```json
{
  "formatVersion": 1,
  "epoch": 1,
  "after": "NNNN_tag",
  "provenance": {
    "kind": "curated",
    "sources": ["packages/backend/db/migrations/NNNN_tag.sql"],
    "note": "Why this era could contain these records."
  },
  "rows": [
    {
      "table": "tasks",
      "values": { "id": "fixture-id", "status": "done" },
      "expect": {
        "api": [
          {
            "path": "/api/tasks/fixture-id",
            "at": "",
            "equals": { "/id": "fixture-id", "/status": "done" }
          }
        ]
      }
    }
  ],
  "content": [
    {
      "path": "runs/example/report.md",
      "utf8": "Report\n",
      "sha256": "hex-sha256"
    }
  ]
}
```

The example abbreviates required SQL columns; real entries contain the necessary
creation-time fields. `after` is the full epoch-1 tag, or the full epoch-2 history
slug (`0000_rfc395_target_baseline`), even though the epoch-2 filename is `0000.json`.
Rows are ordered; dependencies may be cyclic. Offline reconstruction disables FK
enforcement while inserting the complete snapshot, then requires
`PRAGMA foreign_key_check` and `PRAGMA quick_check` to succeed. It never uses
`INSERT OR IGNORE` or silently drops unknown columns.

Values use the recording tool's canonical logical representation:

| JSON value                                     | SQLite preparation                       |
| ---------------------------------------------- | ---------------------------------------- |
| `null`, string, safe integer/finite number     | Bind directly                            |
| boolean                                        | Bind `0` or `1`                          |
| `{ "$bigint": "9223372036854775807" }`         | Bind the exact integer                   |
| `{ "$bytes": "AAE=" }`                         | Bind canonical base64-decoded BLOB bytes |
| `{ "$timestamp": "2026-05-11T00:00:00.000Z" }` | Bind epoch milliseconds                  |
| `{ "$number": "Infinity" }` / `"-Infinity"`    | Bind the corresponding real value        |

JSON database columns contain **raw JSON text strings**, not nested JSON objects.
Do not parse and reserialize historical payloads, hashes, receipts or snapshots.
Omitted columns use the SQL default; explicit `null` stays null. `<AW_HOME>` inside
strings is substituted with the disposable installation root. No executable SQL
or expressions are accepted as seed values.

Content paths are relative to that root. Supply exactly one of `utf8` or `base64`
and the SHA-256 of the decoded bytes. Conflicting bytes at an existing path fail;
identical repeated content is allowed. Paths may not escape the fixture root.
An optional `objectId` declares the body of a hosted object, stored under
`fixture-objects/`. The future L1 content/object adapter must resolve that exact
opaque ID to these bytes; `check` only materializes and verifies the file. This
keeps all hosted artifact bodies local and small without requiring an external
object service during preparation.

`provenance.kind` is `curated`, `scenario`, or `derived-draft`. Drafts are never
accepted by `check`; review the era's required values and semantics before marking
a draft curated. Merely projecting a current row cannot establish that an older
product could have written it.

## Current HTTP API expectations

`expect.api` always describes the **current product after upgrade**, never the
source release API. The A1 consumer performs a GET with a fixture administrator
identity, requires a successful response, follows the RFC 6901 pointer `at`, and
compares only the listed `equals` pointers. Empty `at` means the whole response.
For arrays, `match` selects exactly one object by equality of the named identity
fields; zero or multiple matches fail. `equals` pointers are relative to that
selected object. No list ordering, timestamps, process IDs or full response
snapshots are asserted.

For example, NodeRun expectations select `/runs` from
`GET /api/tasks/:id/node-runs` by `id`, then compare `id`, `taskId`, `nodeId`, and
`status`. Memory expectations select `/memory`. Resource details compare identity
and a few stable fields such as name, role, enabled state or task status. Annotated
rows exist for users, agents, workflows, skills, MCPs, plugins, schedules,
workgroups, memories, tasks, runs, documents and native clarification rounds.

Rows without public HTTP identities are checked by S1–S3/E2, not artificial HTTP
endpoints. The API annotations do not replace content digest or complete mapping
checks. Optional `expect.disposition` plus `reason` can override a row's mapping
disposition; it must have independent source evidence. A future change allowing a
restart-induced state change must enumerate that exact change, not accept any
status. The current epoch-2 waiting task is a persisted human gate, with a separate
draft row; completed clarification rounds have no draft.

After the users migration, the curated administrator is `upgrade_admin`, with
fixture-only password `rfc398-local-fixture-only`; its bcrypt hash is stored in
the ledger. Earlier release points rely on the current product's supported local
bootstrap identity in the later A1 harness. Existing PAT/session rows are revoked
history and are not login credentials for the harness.

## Migration effects and the independent mapping oracle

`migrationEffects` records backfills, altered values, table retirement and
installation seed behavior. `source` points to the original SQL. A `projection`
can explicitly name source tables, output keys, cardinality and column formulas.
Examples include `0034` (one task-repository row for each existing task), `0031`
(the self/cross clarification union), and `0145` (the reset of the short-lived MCP
creation receipt cache, followed by a new session/turn/receipt seed).

These are **SQL effects before conversion**, not observations of conversion.
For S1, compare the built release's pre-upgrade keys first; independently replay
the missing frozen SQL on a disposable copy to determine the current-phase
source, checking the stated projections. Do not derive expectations by reading
the converter's target rows or disposition output.

Oracle entry fields are:

- `table`, `provider` when provider-specific, and `sourcePhase`: source identity.
  A current entry applies only if the frozen chain contains that table; a
  pre-upgrade entry applies only if it exists in the built release.
- `disposition`: expected default `preserved`, `converted`, `archived`, or
  `metadata`; `conditionalDispositions` describes documented host-row removal or
  restricted `history-only` NodeRuns. In-flight ambiguity must block and is not
  an allowed successful seed outcome.
- `sourceKey`: ordered logical source columns. For historical metadata shape
  differences, the fingerprint-declared migration key is authoritative, as stated
  in `keyAuthority`; journal receipt order must not use nullable `SERIAL` IDs.
- `destinations[].key`: independent equality selectors (`sourceColumn`, `literal`,
  `context`, or named `projection`). `targetKeyColumns` documents the physical PK;
  selectors such as `(task_id, ordinal)` may resolve a separately minted `repo_key`.
- `preserveColumns`: explicit same-name value comparisons after provider codec
  normalization. `projections` covers splits, renames, ordered references, JSON
  decomposition and content bytes; raw text must not be normalized away.
- `archive` or `metadata`: the evidence destination, original keys/bytes and digest
  obligations for rows without a live business destination. Retired-table archive
  rules declare no business target tables. Metadata is not a business destination.
- `source`/`references`: RFC citations, or `rule-declaration` plus a file and line
  for the 108 retired tables absent from the RFC's frozen 222-table roster. That
  declaration is `conversion/generic/archive.ts:17` (`produces: []`); no converter
  implementation or output supplies the expected values.

`code_*` history packages use `archived`, including the seven tables whose RFC
label is “historicalize”; `history-only` is the restriction on uncertain executable
history. A consumer must check the corresponding plan restrictions, not collapse
the two concepts. The oracle includes explicit retained JSON/idempotency semantics
for journals/effects and the correction that NodeRuns also populate the sequence
allocator.

## Authoring and checking

Use Bun 1.4.3 explicitly:

```sh
~/.bun/bin/bun scripts/release-upgrade/seed-ledger.ts derive \
  --dataset /tmp/release-recording \
  --tag v0.19.2 --migration 0034_rfc066_task_repos \
  --table task_repos --output /tmp/task-repos-draft.json

~/.bun/bin/bun scripts/release-upgrade/seed-ledger.ts check \
  --output /tmp/seed-coverage.json

~/.bun/bin/bun scripts/release-upgrade/seed-ledger.ts check --write-coverage

# Approval-sensitive gate: proposed exemptions intentionally make this fail.
~/.bun/bin/bun scripts/release-upgrade/seed-ledger.ts check \
  --require-approved-exemptions
```

`derive` consumes `record.ts`'s `dataset.json` and table JSONL files, checks their
hashes and row counts, reconstructs the requested migration's schema using the
release's actual SQL receipts, and projects rows onto columns that existed then.
By default it selects created or changed tables, retaining at most three rows per
table. `--table` is repeatable. It refuses to overwrite its output. Review foreign
keys, old enum/JSON formats, backfills, live-state plausibility, content files, and
current API expectations manually. Content and API projections are not copied
blindly from a recording.

`check` verifies matrix membership and receipt equivalence, builds each distinct
SQLite build in a disposable home, checks every SQL hash, applies each receipt
and its seed transactionally, verifies the exact ordered journal, checks foreign
keys/integrity, and counts every stored table. It stops that build at the first
insert/migration failure and continues the other builds. Missing data, invalid
receipts and reconstruction failures exit nonzero. `--keep /tmp/new-directory`
retains databases/content for diagnosis; an existing database is never overwritten.
The default deletes only the temporary directory that the tool created.

Coverage distinguishes actual `scenario`/`curated` rows, exact-build `exempt`
entries and `missing` failures. Proposed exemptions remain visibly proposed; an
ordinary preparation check can succeed with them, while the approval-sensitive
flag cannot. No wildcard exemption, empty-table short circuit, or automatic
approval is allowed. `--write-coverage` refuses a partial reconstruction report.

For epoch-2, preparation renders the frozen metadata snapshot and materializes
schema-history/generation/first-write/sentinel receipts from the immutable history
artifacts. The history artifact JSON is assembled at preparation time, avoiding
several megabytes of duplicated contract text in the committed seed. It does not
call `installHistoryHead`, the converter, or `db migration`. A full L1 home still
needs its installed-role v2 pointer and provider adapter, owned by the matrix job.

## Deviations and handoff boundaries

- Curated SQL fixtures were used; recording released binaries was optional and was
  not needed for the table coverage preparation. These rows are not certified
  old-daemon recordings. Old-binary scenario acceptance remains separate.
- The custom employee type descriptor uses the plain descriptor literal from
  v0.18.12's `digitalEmployeeTypePackages.ts`, with fixture names/IDs. No test or
  registration module was imported or executed. Immutable resource revisions,
  closure references and content digests are explicit seed values. The workgroup
  history has an agent leader and a human reviewer, and preserves a host snapshot.
- Empty metadata is documented as 18 **proposed**, exact-build exemptions. This
  job cannot approve them. All business tables have data, including hosted-only
  tables, whose small object bodies are supplied by `objectId` content fixtures.
- The epoch-2 fixture includes explicitly imported historical code/evidence rows
  in addition to native rows so those business tables are exercised. They are
  authored from the public archive format and original SQL values, not generated
  by a conversion run or represented as a fabricated migration operation.
- This job's check covers SQLite data preparation. PostgreSQL installation,
  converter disposition/value checks, HTTP A1, restart/doctor and real-provider
  acceptance belong to later RFC-398 work and have not been run here.
- Tool regression tests are authored under `scripts/release-upgrade/lib/`; they
  are deliberately not executed in this development-only task.

The committed seed payload is intended to stay below 3 MB. Keep future rows small
and meaningful; one referentially closed history is preferable to bulk fillers.
