import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '../db/migrations')
const QUARANTINED = '__rfc223_fusion_skill_quarantined__'
const MERGER_ID = '00000000000000000000000001'
const FUSION_WORKFLOW_ID = '00000000000000000000000002'
const homes: string[] = []

function freezeThrough0116(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rfc223-0117-'))
  homes.push(dir)
  cpSync(MIGRATIONS, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 115)
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  return dir
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('migration 0117 RFC-223 fusion provenance', () => {
  test('backfills only committed fusion/version provenance and quarantines name-only history', () => {
    const raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    migrate(drizzle(raw), { migrationsFolder: freezeThrough0116() })

    raw.exec(`
      INSERT INTO users (id, username, display_name, role, created_at, updated_at)
      VALUES ('owner', 'owner', 'Owner', 'user', 1, 1);
      INSERT INTO skills (
        id, name, description, source_kind, managed_path,
        content_version, meta_revision, reservation_state, version_state,
        owner_user_id, visibility, created_at, updated_at
      ) VALUES (
        'skill-trusted', 'same-name', '', 'managed', '/skills/skill-trusted/files',
        1, 0, 'ready', 'snapshot-authoritative',
        'owner', 'private', 1, 1
      ), (
        'skill-conflict', 'other-name', '', 'managed', '/skills/skill-conflict/files',
        1, 0, 'ready', 'snapshot-authoritative',
        'owner', 'private', 1, 1
      );
      INSERT INTO agents (id, name, depends_on)
      VALUES ('ordinary-agent', 'ordinary-agent', 'unrelated malformed json');
      INSERT INTO fusions (
        id, skill_name, base_skill_version, memory_ids_json, intent, status,
        iteration, owner_user_id, created_at
      ) VALUES
        ('fusion-trusted', 'same-name', 0, '["memory-trusted"]', '', 'done', 1, 'owner', 1),
        ('fusion-name-only', 'same-name', 0, '["memory-quarantined"]', '', 'failed', 1, 'owner', 2),
        ('fusion-conflict', 'same-name', 0, '[]', '', 'done', 1, 'owner', 3);
      INSERT INTO skill_versions (
        id, skill_id, version_index, files_path, source, fusion_id, created_at
      ) VALUES
      (
        'version-trusted', 'skill-trusted', 1, '/skills/skill-trusted/versions/v1/files',
        'fusion', 'fusion-trusted', 1
      ), (
        'version-conflict-a', 'skill-trusted', 2, '/skills/skill-trusted/versions/v2/files',
        'fusion', 'fusion-conflict', 2
      ), (
        'version-conflict-b', 'skill-conflict', 1, '/skills/skill-conflict/versions/v1/files',
        'fusion', 'fusion-conflict', 3
      );
      INSERT INTO memories (
        id, scope_type, scope_id, title, body_md, tags, status, source_kind,
        created_at, version, fused_into_skill, fused_into_skill_version,
        fused_at, fused_by_user_id, fused_fusion_id
      ) VALUES
        ('memory-trusted', 'global', NULL, 'trusted', 'body', '[]', 'fused', 'manual',
         1, 1, 'same-name', 1, 1, 'owner', 'fusion-trusted'),
        ('memory-quarantined', 'global', NULL, 'quarantined', 'body', '[]', 'fused', 'manual',
         2, 1, 'same-name', 1, 2, 'owner', 'fusion-name-only');
      INSERT INTO memories (
        id, scope_type, scope_id, title, body_md, tags, status, source_kind,
        supersedes_id, created_at, version
      ) VALUES
        ('memory-parent', 'global', NULL, 'parent', 'body', '[]', 'approved', 'manual',
         NULL, 3, 1),
        ('memory-child', 'global', NULL, 'child', 'body', '[]', 'approved', 'manual',
         'memory-parent', 4, 1);
    `)

    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

    expect(raw.query('SELECT id, skill_id FROM fusions ORDER BY id').all()).toEqual([
      { id: 'fusion-conflict', skill_id: QUARANTINED },
      { id: 'fusion-name-only', skill_id: QUARANTINED },
      { id: 'fusion-trusted', skill_id: 'skill-trusted' },
    ])
    expect(
      raw
        .query('SELECT id, fused_into_skill_id FROM memories WHERE status = ? ORDER BY id')
        .all('fused'),
    ).toEqual([
      { id: 'memory-quarantined', fused_into_skill_id: QUARANTINED },
      { id: 'memory-trusted', fused_into_skill_id: 'skill-trusted' },
    ])
    expect(
      raw
        .query(
          `SELECT "notnull" AS is_not_null
           FROM pragma_table_info('fusions') WHERE name = 'skill_id'`,
        )
        .get(),
    ).toEqual({ is_not_null: 1 })
    expect(raw.query("SELECT name FROM pragma_index_info('idx_fusions_skill')").all()).toEqual([
      { name: 'skill_id' },
    ])
    expect(
      raw.query("SELECT fused_into_skill_id FROM memories WHERE id = 'memory-child'").get(),
    ).toEqual({ fused_into_skill_id: null })
    expect(raw.query("SELECT supersedes_id FROM memories WHERE id = 'memory-child'").get()).toEqual(
      { supersedes_id: 'memory-parent' },
    )
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      raw.query("SELECT DISTINCT `table` FROM pragma_foreign_key_list('memories')").all(),
    ).toEqual([{ table: 'memories' }])
    expect(
      (
        raw.query("SELECT sql FROM sqlite_master WHERE name = 'memories'").get() as {
          sql: string
        }
      ).sql,
    ).not.toContain('__new_memories')
    raw.close()
  })

  test('repairs legacy builtin ids and every executable reference with FK on and off', () => {
    for (const foreignKeys of ['ON', 'OFF'] as const) {
      const raw = new Database(':memory:')
      raw.exec(`PRAGMA foreign_keys = ${foreignKeys}`)
      migrate(drizzle(raw), { migrationsFolder: freezeThrough0116() })

      raw.exec(`
      INSERT INTO users (id, username, display_name, role, created_at, updated_at) VALUES
        ('owner', 'owner', 'Owner', 'admin', 1, 1),
        ('grantee', 'grantee', 'Grantee', 'user', 1, 1);

      INSERT INTO agents (
        id, name, runtime, depends_on, owner_user_id, visibility, builtin
      ) VALUES
        ('legacy-merger', 'aw-skill-merger', 'custom-runtime', '[]', 'owner', 'private', 1),
        ('consumer-agent', 'consumer', NULL,
         '["legacy-merger","${MERGER_ID}","legacy-merger"]', 'owner', 'private', 0);

      INSERT INTO workflows (
        id, name, description, definition, version, owner_user_id, visibility, builtin
      ) VALUES
        ('legacy-fusion-workflow', 'aw-skill-fusion', 'legacy',
         '{"nodes":[{"id":"merger","kind":"agent-single","agentId":"legacy-merger","agentName":"aw-skill-merger"}]}',
         3, 'owner', 'private', 1),
        ('other-workflow', 'other', '',
         '{"nodes":[{"id":"writer","kind":"agent-single","agentId":"legacy-merger"}]}',
         7, 'owner', 'private', 0);

      INSERT INTO resource_grants
        (resource_type, resource_id, user_id, added_by, added_at) VALUES
        ('agent', 'legacy-merger', 'grantee', 'owner', 1),
        ('agent', '${MERGER_ID}', 'grantee', 'owner', 2),
        ('workflow', 'legacy-fusion-workflow', 'grantee', 'owner', 1),
        ('workflow', '${FUSION_WORKFLOW_ID}', 'grantee', 'owner', 2);

      INSERT INTO workgroups (id, name, owner_user_id)
      VALUES ('wg', 'wg', 'owner');
      INSERT INTO workgroup_members (
        id, workgroup_id, member_type, agent_name, agent_id, display_name
      ) VALUES ('member', 'wg', 'agent', 'aw-skill-merger', 'legacy-merger', 'Merger');

      INSERT INTO tasks (
        id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
        base_branch, branch, status, inputs, started_at, source_agent_name,
        source_agent_id, workgroup_id, workgroup_config_json
      ) VALUES (
        'task', 'task', 'legacy-fusion-workflow',
        '{"nodes":[{"id":"writer","kind":"agent-single","agentId":"legacy-merger"}]}',
        '/tmp/repo', '/tmp/worktree', 'main', 'aw/task', 'done', '{}', 1,
        'aw-skill-merger', 'legacy-merger', 'wg',
        '{"members":[{"memberId":"member","agentId":"legacy-merger"}]}'
      );
      INSERT INTO node_runs (
        id, task_id, node_id, iteration, retry_index, status, started_at, agent_override_id
      ) VALUES ('run', 'task', 'writer', 1, 0, 'done', 1, 'legacy-merger');

      INSERT INTO scheduled_tasks (
        id, name, owner_user_id, launch_kind, launch_payload, schedule_spec, enabled
      ) VALUES
        ('schedule-agent', 'agent', 'owner', 'agent',
         '{"agentId":"legacy-merger"}', '{"kind":"interval","every":1,"unit":"hours"}', 0),
        ('schedule-workflow', 'workflow', 'owner', 'workflow',
         '{"workflowId":"legacy-fusion-workflow"}',
         '{"kind":"interval","every":1,"unit":"hours"}', 0);

      INSERT INTO memories (
        id, scope_type, scope_id, title, body_md, tags, status, source_kind,
        created_at, version
      ) VALUES
        ('memory-agent', 'agent', 'legacy-merger', 'a', 'a', '[]', 'approved', 'manual', 1, 1),
        ('memory-workflow', 'workflow', 'legacy-fusion-workflow',
         'w', 'w', '[]', 'approved', 'manual', 1, 1);

      INSERT INTO memory_distill_jobs (
        id, debounce_key, source_kind, source_event_id, scope_resolved_json,
        status, attempts, next_run_at, created_at
      ) VALUES (
        'distill', 'd', 'review', 'e',
        '{"agentIds":["legacy-merger","${MERGER_ID}","legacy-merger"],"workflowId":"legacy-fusion-workflow","repoId":null,"includeGlobal":true}',
        'done', 0, 1, 1
      );
      INSERT INTO workgroup_task_state (
        task_id, gate_status, dw_state_json, updated_at
      ) VALUES (
        'task', 'idle',
        '{"generatedDef":{"nodes":[{"id":"writer","kind":"agent-single","agentId":"legacy-merger"}]}}',
        1
      );
    `)

      expect(
        raw.query("SELECT id FROM users WHERE id IN ('owner','grantee') ORDER BY id").all(),
      ).toEqual([{ id: 'grantee' }, { id: 'owner' }])
      expect(raw.query('SELECT COUNT(*) AS n FROM resource_grants').get()).toEqual({ n: 4 })
      migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

      expect(
        raw
          .query(
            "SELECT id, runtime, owner_user_id, visibility, builtin FROM agents WHERE name = 'aw-skill-merger'",
          )
          .get(),
      ).toEqual({
        id: MERGER_ID,
        runtime: 'custom-runtime',
        owner_user_id: '__system__',
        visibility: 'public',
        builtin: 1,
      })
      expect(
        JSON.parse(
          (
            raw.query("SELECT depends_on FROM agents WHERE id = 'consumer-agent'").get() as {
              depends_on: string
            }
          ).depends_on,
        ),
      ).toEqual([MERGER_ID])
      expect(
        raw
          .query(
            "SELECT id, owner_user_id, visibility, builtin FROM workflows WHERE name = 'aw-skill-fusion'",
          )
          .get(),
      ).toEqual({
        id: FUSION_WORKFLOW_ID,
        owner_user_id: '__system__',
        visibility: 'public',
        builtin: 1,
      })
      expect(raw.query("SELECT version FROM workflows WHERE id = 'other-workflow'").get()).toEqual({
        version: 8,
      })

      const task = raw
        .query(
          `SELECT workflow_id, source_agent_id, workflow_snapshot, workgroup_config_json
         FROM tasks WHERE id = 'task'`,
        )
        .get() as {
        workflow_id: string
        source_agent_id: string
        workflow_snapshot: string
        workgroup_config_json: string
      }
      expect(task.workflow_id).toBe(FUSION_WORKFLOW_ID)
      expect(task.source_agent_id).toBe(MERGER_ID)
      expect(JSON.parse(task.workflow_snapshot).nodes[0].agentId).toBe(MERGER_ID)
      expect(JSON.parse(task.workgroup_config_json).members[0].agentId).toBe(MERGER_ID)
      expect(raw.query("SELECT agent_id FROM workgroup_members WHERE id = 'member'").get()).toEqual(
        { agent_id: MERGER_ID },
      )
      expect(raw.query("SELECT agent_override_id FROM node_runs WHERE id = 'run'").get()).toEqual({
        agent_override_id: MERGER_ID,
      })
      expect(
        raw
          .query(
            'SELECT resource_type, resource_id, user_id FROM resource_grants ORDER BY resource_type',
          )
          .all(),
      ).toEqual([
        { resource_type: 'agent', resource_id: MERGER_ID, user_id: 'grantee' },
        { resource_type: 'workflow', resource_id: FUSION_WORKFLOW_ID, user_id: 'grantee' },
      ])
      expect(raw.query('SELECT id, scope_id FROM memories ORDER BY id').all()).toEqual([
        { id: 'memory-agent', scope_id: MERGER_ID },
        { id: 'memory-workflow', scope_id: FUSION_WORKFLOW_ID },
      ])

      const schedules = raw
        .query('SELECT id, launch_payload FROM scheduled_tasks ORDER BY id')
        .all() as Array<{ id: string; launch_payload: string }>
      expect(JSON.parse(schedules[0]!.launch_payload).agentId).toBe(MERGER_ID)
      expect(JSON.parse(schedules[1]!.launch_payload).workflowId).toBe(FUSION_WORKFLOW_ID)
      const scope = JSON.parse(
        (
          raw
            .query("SELECT scope_resolved_json FROM memory_distill_jobs WHERE id = 'distill'")
            .get() as {
            scope_resolved_json: string
          }
        ).scope_resolved_json,
      )
      expect(scope.agentIds).toEqual([MERGER_ID])
      expect(scope.workflowId).toBe(FUSION_WORKFLOW_ID)
      expect(
        JSON.parse(
          (
            raw
              .query("SELECT dw_state_json FROM workgroup_task_state WHERE task_id = 'task'")
              .get() as {
              dw_state_json: string
            }
          ).dw_state_json,
        ).generatedDef.nodes[0].agentId,
      ).toBe(MERGER_ID)
      expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
      raw.close()
    }
  })

  test('fixed-id wrong-name collision aborts atomically without hijacking the row', () => {
    const raw = new Database(':memory:')
    migrate(drizzle(raw), { migrationsFolder: freezeThrough0116() })
    raw
      .query('INSERT INTO agents (id, name, builtin) VALUES (?, ?, 0)')
      .run(MERGER_ID, 'ordinary-agent')

    expect(() => migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })).toThrow()
    expect(raw.query('SELECT id, name, builtin FROM agents WHERE id = ?').get(MERGER_ID)).toEqual({
      id: MERGER_ID,
      name: 'ordinary-agent',
      builtin: 0,
    })
    expect(
      raw
        .query("SELECT COUNT(*) AS n FROM pragma_table_info('fusions') WHERE name = 'skill_id'")
        .get(),
    ).toEqual({ n: 0 })
    raw.close()
  })
})
