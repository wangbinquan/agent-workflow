# RFC-398 released PostgreSQL roots

`0000_rfc349_baseline.sql` and `meta/_journal.json` are byte-for-byte `git show
<tag>:packages/backend/db/postgresql-migrations/<path>` exports. Do not format them.
Neither tag stored the logical contract, plan, or physical catalog as separate files.

Regenerate the missing artifacts with Bun 1.4.3:

    bun scripts/release-upgrade/freeze-postgresql-baselines.ts

The generator resolves each release's schema, provider projection, contract builder,
and plan builder directly from Git blobs in an in-memory module namespace. The two
schema enum constants come from that tag's `taskOperations.ts`. It checks the
regenerated contract/plan against the original journal and compares rendered SQL
with the complete original SQL bytes. No checkout or worktree is created.

`sqlite-receipts.json` contains the tag's 223 actual SQLite receipts. `catalog.json`
is the SQLite physical catalog produced from those exact migration bytes. It is
the equality oracle for bridge loading, including trigger DDL. PostgreSQL physical
catalog spelling depends on server major; the supported-source compiler executes
each original plan on its empty reference connection (15–18), just as for frozen
history roots, and rolls the reference transaction back. These roots remain
independent registrations and never become linear history neighbours.

`provenance.json` pins the source commit and original byte digests. Generated JSON
is ordinary formatted data; original SQL and journal bytes remain untouched.
