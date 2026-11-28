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

An automatic upgrade does not stop because of the data it finds (RFC-626). Where the
manual workflow would block or ask for an acknowledgement, it decides by fixed rules and
goes on: an unfinished task whose old records cannot be continued by the new version is
ended (canceled, with the reason "ended by upgrade"; its waiting review and human steps
and unanswered clarifications are closed with it); a row that is invalid by itself is
set aside into the archive of the new database; content that is not on disk is recorded
as missing; a skill whose directory is absent is kept and marked unavailable until the
directory is back; items of retired features are acknowledged. The upgrade logs a
one-line summary (`Decisions made by the upgrade: …`) followed by WARN lines: every
ended task, and the first 50 entries of each other kind (rows the conversion set aside
and references resolved while finalizing are listed as two kinds, 50 each; content
recorded as missing names the task it belongs to). The receipt holds the lists
(up to 1000 entries per kind); `db migration status <op> --json` shows the totals and
the counts per decision code under `resolutions`; the complete list is in the migration
records of the new database. History restrictions are accepted and recorded as before.
To keep a task from being ended, finish or cancel it in the old version before
upgrading.

Only problems of the environment refuse an automatic upgrade, and they do so within
seconds, before anything is recorded: not enough free disk space (estimated from the
data in use, not from the file size), a SQLite database whose structure no released
version writes, a `config.json` that cannot be read, and a PostgreSQL role that may not
create databases when no empty database was provided. Such a refusal exits with code 3,
names the numbers, objects or statements involved, and leaves no session record,
operation directory, allocation file or new database behind; correct the cause and
start again. A disk with no free space at all, on which not even the old database can
be opened, is reported as a lack of space with the bytes available. These checks are
made when an upgrade is about to begin: an installation that is already upgraded and
a session that resumes are not judged again (they still need a `config.json` that
loads).

The structure of a PostgreSQL database cannot be judged that early: comparing it needs
a scratch database, and the early checks create none. A PostgreSQL database holding
objects no released version writes is therefore refused later, when the upgrade
freezes it — after the session has been recorded and the target and scratch databases
have been created — with the objects named and exit code 1. Restore the structure with
the previous version and start again; the session continues with the databases it has.

Source databases and pre-switch backups remain available. After the daemon's first
business write, returning to the old version requires the pre-switch backup and old
binary, losing subsequent writes.

Installations from releases before v0.5.0 have no `secret.key`. When such a home
holds repository URLs, the upgrade creates `secret.key` in the app home the way the
daemon's first v0.5.0+ boot would, seals the URLs with it, and logs a WARN line
(`created secret.key for legacy repository URLs`). Include it in app-home backups
from then on. A home whose URLs are already sealed but whose key is missing is no
longer refused: the upgrade keeps the repository row, lists it among its decisions,
and the new version shows that repository's address as unavailable and does not
refresh it. Restoring the original `secret.key` before upgrading avoids this.

A failed acceptance check commits the session to rollback before its first business
write. Restart finishes that rollback and refuses another automatic attempt. After
repairing the cause, run `agent-workflow db migration auto --retry`; this creates a
new session and new PostgreSQL allocations. The durable receipt is stored beside
the numbered decisions under
`database-migrations/auto-upgrade/sessions/<operationId>/receipt.json`.
`db migration complete` remains a separate retention registration step after
operational acceptance.
