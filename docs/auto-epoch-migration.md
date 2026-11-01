# Automatic database epoch upgrades

For the complete operator procedure, including pre-upgrade backups, DBA commands,
v0.18.18/v0.18.19 PostgreSQL bridging, returning to an old binary, and the release
gate, see the [release, upgrade and rollback runbook](./release-upgrade-rollback.md).
This behavior requires a binary containing RFC-398; v0.19.3 predates it.

Standalone installations default to `"autoEpochMigration": true` in `config.json`.
After replacing the binary, `agent-workflow start` upgrades an epoch-1 database,
verifies it, writes an upgrade receipt, and starts the daemon. `agent-workflow migrate`
performs the same upgrade in process before applying native schema history.
Set `"autoEpochMigration": false` to retain the manual plan and approval workflow.
CrewStation installations continue to use their platform migration Job.

`agent-workflow db migration auto [--json] [--retry]` resumes an unfinished automatic
session. It prints a JSON conclusion: exit 0 means completed or no work, 3 means
refused or verification failed, 1 means an operational error, and 2 means invalid
arguments. `db migration status` identifies automatic operations with `mode: auto`.
`doctor` describes old installations and the next upgrade action without requiring
an epoch-2 generation pointer.

PostgreSQL upgrades allocate a target and retained scratch database on the source
server. The receipt lists their actual names. Update external backup and monitoring
jobs that select a database by name. When CREATE DATABASE permission is missing,
run the reported statements as a DBA, then start again. Scratch databases remain
available for migration trace replay. `databaseName` is inferred from the generation
pointer and is not a manual connection setting.

The initial names are `<source>_epoch2` and `<source>_epoch2_scratch`; later runs
and retries allocate fresh names. If a derived database already exists and is not
empty, start refuses; either empty or rename it, or set
`AGENT_WORKFLOW_EPOCH_TARGET_URL` (or `AGENT_WORKFLOW_EPOCH_SCRATCH_URL`) to a new empty
database and start again. The explicit variable takes over only while the refused
allocation has not been provisioned, and it must stay set after the switch.
`doctor`, startup logs and `db migration status <op> --json` (`retainedDatabases`:
name, size, purpose and run) identify these databases. `/health` exposes only
`database: { provider: "postgresql", databaseName: "<actual connected database>" }`,
never the connection URL or credentials. The legacy `/health` probe returns the
same identity. Retained scratch databases support `db migration trace … --replay`;
removing them after the retention period also removes that replay capability.

Blocked or acknowledgeable plan items require operator action; automatic upgrades
never acknowledge them. History restrictions are accepted, recorded in the receipt,
and logged as individual WARN lines. Source databases and pre-switch backups remain
available. After the daemon's first business write, returning to the old version
requires the pre-switch backup and old binary, losing subsequent writes.

A failed acceptance check commits the session to rollback before its first business
write. Restart finishes that rollback and refuses another automatic attempt. After
repairing the cause, run `agent-workflow db migration auto --retry`; this creates a
new session and new PostgreSQL allocations. The durable receipt is stored beside
the numbered decisions under
`database-migrations/auto-upgrade/sessions/<operationId>/receipt.json`.
`db migration complete` remains a separate retention registration step after
operational acceptance.
