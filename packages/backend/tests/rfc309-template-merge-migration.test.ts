// RFC-309 T3 — the migration, verified on real rows.
//
// This is the only irreversible step in the RFC, and the one thing it must not
// do is quietly repoint a matrix cell at somebody else's configuration. The
// design avoids that rather than checking for it — a merged template KEEPS ITS
// BINDING'S id, so `repo_capability_config.template_id` is renamed and never
// rewritten. These cases prove the design actually holds, because "it cannot
// happen" is a claim that needs evidence.
//
// The rows are inserted through raw SQL against the PRE-migration schema and
// then migrated, rather than through the post-merge helpers: a test that builds
// its fixtures with the new code cannot detect a migration that drops data the
// old code was writing.

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const CUTOVER = '0174_rfc309_capability_templates'

/** Apply migrations in journal order, optionally stopping before one. */
function migrateUpTo(db: Database, stopBefore: string | null): void {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf-8')) as {
    entries: { tag: string }[]
  }
  for (const entry of journal.entries) {
    if (stopBefore !== null && entry.tag === stopBefore) return
    const file = readdirSync(MIGRATIONS).find((f) => f === `${entry.tag}.sql`)
    if (file === undefined) continue
    const sql = readFileSync(join(MIGRATIONS, file), 'utf-8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed === '') continue
      db.exec(trimmed)
    }
  }
}

function seedPreMerge(db: Database): void {
  const now = 1_700_000_000_000
  // One framework, TWO bindings — the sharing relation the merge dissolves.
  db.exec(`INSERT INTO capability_frameworks
    (id, name, description, capability, scripts_json, hooks_json, param_schema_json,
     param_defaults_json, stage_contract_ver, owner_user_id, visibility, acl_revision,
     builtin, created_at, updated_at)
    VALUES ('fw-1', 'dept', 'shared scripts', 'mr-review',
      '{"collect":{"language":"bash","script":"echo hi"}}', '[]', '[]', '{}',
      4, 'dept-user', 'public', 0, 0, ${now}, ${now})`)
  for (const [id, owner] of [
    ['bind-a', 'team-a'],
    ['bind-b', 'team-b'],
  ]) {
    db.exec(`INSERT INTO capability_bindings
      (id, name, description, framework_id, agent_by_slot_json, prompt_by_slot_json,
       params_json, owner_user_id, visibility, acl_revision, builtin, created_at, updated_at)
      VALUES ('${id}', '${id} name', null, 'fw-1', '{"reviewer":"agent-${id}"}',
        '{}', '{}', '${owner}', 'private', 0, 0, ${now}, ${now})`)
  }
  // A framework nobody bound — its scripts are still somebody's work.
  db.exec(`INSERT INTO capability_frameworks
    (id, name, description, capability, scripts_json, hooks_json, param_schema_json,
     param_defaults_json, stage_contract_ver, owner_user_id, visibility, acl_revision,
     builtin, created_at, updated_at)
    VALUES ('fw-orphan', 'unbound', null, 'ci-fix',
      '{"select":{"language":"bash","script":"echo pick"}}', '[]', '[]', '{}',
      1, 'dept-user', 'private', 0, 0, ${now}, ${now})`)

  // Two matrix cells, one per binding.
  for (const [id, repo, binding] of [
    ['cell-a', 'repo/a', 'bind-a'],
    ['cell-b', 'repo/b', 'bind-b'],
  ]) {
    db.exec(`INSERT INTO repo_capability_config
      (id, repo_id, capability, binding_id, enabled, trigger_config_json, readiness,
       readiness_issues_json, dependency_revision, last_validated_at, created_at, updated_at)
      VALUES ('${id}', '${repo}', 'mr-review', '${binding}', 1, '{}', 'ready', '[]', 1, ${now}, ${now}, ${now})`)
  }

  // The grants table has a foreign key to `users`, so the account has to exist
  // for the fixture to be a real pre-migration state rather than a shortcut.
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, role, status, created_at, updated_at)
    VALUES ('u1', 'holder', 'Holder', 'x', 'user', 'active', ${now}, ${now})`)
  db.exec(`INSERT INTO user_permission_grants (user_id, permission, granted_by_user_id, granted_at)
    VALUES ('u1', 'capability-bindings:update', null, ${now})`)
  db.exec(`INSERT INTO user_permission_grants (user_id, permission, granted_by_user_id, granted_at)
    VALUES ('u1', 'agents:update', null, ${now})`)
}

function migratedDb(): Database {
  const db = new Database(':memory:')
  migrateUpTo(db, CUTOVER)
  seedPreMerge(db)
  const sql = readFileSync(join(MIGRATIONS, `${CUTOVER}.sql`), 'utf-8')
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed !== '') db.exec(trimmed)
  }
  return db
}

describe('RFC-309 migration', () => {
  test('each binding becomes a template that inherits its framework’s scripts', () => {
    const db = migratedDb()
    const rows = db
      .query(
        `SELECT id, capability, scripts_json, agent_by_slot_json, owner_user_id
              FROM capability_templates WHERE id IN ('bind-a','bind-b') ORDER BY id`,
      )
      .all() as {
      id: string
      capability: string
      scripts_json: string
      agent_by_slot_json: string
      owner_user_id: string
    }[]

    expect(rows.map((r) => r.id)).toEqual(['bind-a', 'bind-b'])
    for (const row of rows) {
      // The department half came along…
      expect(row.capability).toBe('mr-review')
      expect(row.scripts_json).toContain('echo hi')
      // …and the group half is still each team's own.
      expect(row.agent_by_slot_json).toContain(`agent-${row.id}`)
    }
    // Ownership follows the binding: it is the row the team already owned.
    expect(rows.map((r) => r.owner_user_id)).toEqual(['team-a', 'team-b'])
    db.close()
  })

  test('THE MATRIX POINTER IS UNCHANGED — the failure this migration is designed around', () => {
    // Not "points at something valid" but "points at the same bytes". Template
    // ids ARE binding ids, so this is close to a tautology — which is the whole
    // reason the design chose it over rewriting the column.
    const db = migratedDb()
    const cells = db
      .query(`SELECT id, template_id FROM repo_capability_config ORDER BY id`)
      .all() as { id: string; template_id: string }[]
    expect(cells).toEqual([
      { id: 'cell-a', template_id: 'bind-a' },
      { id: 'cell-b', template_id: 'bind-b' },
    ])
    // And each still resolves to a template carrying that team's agent.
    for (const cell of cells) {
      const [tpl] = db
        .query(`SELECT agent_by_slot_json FROM capability_templates WHERE id = ?`)
        .all(cell.template_id) as { agent_by_slot_json: string }[]
      expect(tpl?.agent_by_slot_json).toContain(`agent-${cell.template_id}`)
    }
    db.close()
  })

  test('the shared framework survives as an UPSTREAM link on every copy', () => {
    // This is what replaces "one framework, many bindings": the relation is
    // still recorded, but applying an upstream change becomes a choice.
    const db = migratedDb()
    const rows = db
      .query(
        `SELECT id, upstream_id, base_digest FROM capability_templates
              WHERE id IN ('bind-a','bind-b') ORDER BY id`,
      )
      .all() as { id: string; upstream_id: string; base_digest: string }[]
    expect(rows.map((r) => r.upstream_id)).toEqual(['fw-1', 'fw-1'])
    // A digest of the department half, so a later upstream edit is a three-way
    // merge rather than a guess.
    for (const row of rows) expect(row.base_digest).toContain('echo hi')
    db.close()
  })

  test('a framework nobody bound is KEPT, with no agents filled in', () => {
    // Q-A's default. Somebody wrote those scripts; dropping them because no
    // team had bound one yet would delete real work.
    const db = migratedDb()
    const [row] = db
      .query(
        `SELECT capability, scripts_json, agent_by_slot_json FROM capability_templates WHERE id = 'fw-orphan'`,
      )
      .all() as { capability: string; scripts_json: string; agent_by_slot_json: string }[]
    expect(row?.capability).toBe('ci-fix')
    expect(row?.scripts_json).toContain('echo pick')
    expect(row?.agent_by_slot_json).toBe('{}')
    db.close()
  })

  test('THE REBUILDS LOSE NO COLUMNS — the trap this migration fell into once', () => {
    // `anchor_kind` is a CHECK constraint, and SQLite cannot alter one, so both
    // tables are rebuilt. The first version wrote the new `code_findings` from
    // the CREATE in 0164 and silently dropped the four columns 0165 added
    // afterwards; the failure surfaced far away, as `no column named
    // resolved_at` from the metrics query, long after the migration reported
    // success.
    //
    // Asserted against the columns the CURRENT schema declares, so the next
    // person who adds a column and later rebuilds a table gets told here.
    const db = migratedDb()
    const columns = (table: string) =>
      (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map((c) => c.name)
        .sort()

    expect(columns('code_findings')).toEqual(
      [
        'id',
        'code_host_endpoint_id',
        'stable_project_id',
        'anchor_kind',
        'anchor_id',
        'capability',
        'fingerprint',
        'generation',
        'lifecycle',
        'severity',
        'title',
        'file_path',
        'anchor_line',
        'external_id',
        'published_round_id',
        'disappeared_round_id',
        'resolved_at',
        'code_changed_at',
        'resolved_round_id',
        'code_changed_round_id',
        'created_at',
        'last_seen_at',
        'closed_at',
      ].sort(),
    )
    expect(columns('code_work_items')).toEqual(
      [
        'id',
        'code_host_endpoint_id',
        'stable_project_id',
        'capability',
        'anchor_kind',
        'anchor_id',
        'status',
        'epoch',
        'current_round_id',
        'pending_generation',
        'handed_off_fingerprint',
        'anchor_meta',
        'initiator_user_id',
        'created_at',
        'updated_at',
        'closed_at',
        'publishing_epoch',
        'pending_revision',
      ].sort(),
    )
    db.close()
  })

  test('the old tables are gone, not left empty', () => {
    // An empty table reads as "still in use, just no rows" to the next person.
    const db = migratedDb()
    const names = db
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'capability_%'`)
      .all() as { name: string }[]
    expect(names.map((n) => n.name).sort()).toEqual(['capability_templates'])
    db.close()
  })

  test('grants naming the removed points are deleted; others are untouched', () => {
    // The user's ruling (「过去的权限还没人用」). Asserted rather than assumed,
    // because silently dropping authorization rows must be a decision somebody
    // can find later — and because deleting MORE than intended would be worse.
    const db = migratedDb()
    const perms = db
      .query(`SELECT permission FROM user_permission_grants ORDER BY permission`)
      .all() as { permission: string }[]
    expect(perms.map((p) => p.permission)).toEqual(['agents:update'])
    db.close()
  })

  test('anchor_kind now accepts platform, and still refuses nonsense', () => {
    const db = migratedDb()
    const insert = (kind: string) =>
      db.exec(`INSERT INTO code_work_items
        (id, code_host_endpoint_id, stable_project_id, capability, anchor_kind, anchor_id,
         status, epoch, created_at, updated_at)
        VALUES ('wi-${kind}', 'ep', 'proj', 'requirement', '${kind}', 'a1', 'idle', 1, 1, 1)`)
    expect(() => insert('platform')).not.toThrow()
    expect(() => insert('telepathy')).toThrow()
    db.close()
  })
})
