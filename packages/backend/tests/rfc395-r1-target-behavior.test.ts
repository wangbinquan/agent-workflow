// RFC-395 II-b R1: real SQLite/PostgreSQL engines enforce target rules, delete actions, NULL keys and byte-preserving content.
import { expect, test } from 'bun:test'
import { persistenceSchema, rowRuleCodes } from '@/bootstrap/persistenceSchema'
import { compileSqlitePlan } from '@/platform/persistence/schema/sqlitePlan'
import { compilePostgresqlPlan } from '@/platform/persistence/schema/postgresqlPlan'
import {
  compileInstallSeeds,
  renderInstallSeedStatements,
} from '@/platform/persistence/schema/seeds'
import {
  mapSchemaRowRuleError,
  createSchemaRowRuleErrorTranslator,
  SchemaRowRuleError,
} from '@/platform/persistence/schema/rowRules'
import {
  column as c,
  defineContribution,
  retention,
  index,
} from '@/platform/persistence/schema/dsl'
import { createSchemaRegistry } from '@/platform/persistence/schema/registry'
import {
  quoteSchemaIdentifier as quote,
  renderSchemaExpression,
} from '@/platform/persistence/schema/expressions'
import {
  NO_PRODUCER_SHARD_SLOT,
  producerShardSlot,
} from '@/modules/task-execution/domain/runInputShard'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { describeEachProvider } from './helpers/eachProvider'
import { withR2TargetHarness, type R2TargetHarness } from './helpers/rfc395R2Harness'

type Cell = string | number | boolean | null | Buffer
interface Engine {
  readonly provider: DatabaseProvider
  exec(sql: string): Promise<void>
  rows(sql: string): Promise<Record<string, unknown>[]>
}
function targetEngine(harness: R2TargetHarness): Engine {
  const translate = createSchemaRowRuleErrorTranslator(rowRuleCodes)
  return {
    provider: harness.provider,
    async exec(sql) {
      try {
        await harness.native.execute(sql)
      } catch (error) {
        throw translate(error)
      }
    },
    rows: async (sql) => [...(await harness.native.execute(sql))],
  }
}
function literal(engine: Engine, value: Cell): string {
  if (Buffer.isBuffer(value))
    return engine.provider === 'sqlite'
      ? `X'${value.toString('hex')}'`
      : `decode('${value.toString('hex')}', 'hex')`
  return renderSchemaExpression({ kind: 'literal', value }, engine.provider)
}
async function insert(engine: Engine, table: string, values: Record<string, Cell>): Promise<void> {
  await engine.exec(
    `INSERT INTO ${quote(table)} (${Object.keys(values).map(quote).join(', ')}) VALUES (${Object.values(
      values,
    )
      .map((value) => literal(engine, value))
      .join(', ')})`,
  )
}
const task = (id: string, values: Record<string, Cell> = {}) => ({
  id,
  name: id,
  status: 'pending',
  started_at: 1,
  ...values,
})
const user = (id: string, values: Record<string, Cell> = {}) => ({
  id,
  username: id,
  display_name: id,
  created_at: 1,
  updated_at: 1,
  ...values,
})
const run = (id: string, values: Record<string, Cell> = {}) => ({
  id,
  task_id: 'owner-task',
  node_id: id,
  status: 'pending',
  seq: 1,
  role: 'node-attempt',
  scope_path: '',
  slot_key: `slot-v1:${id}`,
  generation_seq: 0,
  attempt_index: 0,
  record_mode: 'executable',
  provenance_quality: 'recorded',
  envelope_nonce: id,
  ...values,
})
async function rejected(engine: Engine, statement: string, code?: string): Promise<void> {
  let caught: unknown
  try {
    await engine.exec(statement)
  } catch (error) {
    caught = error
  }
  expect(caught, statement).toBeDefined()
  if (code) {
    expect(caught).toBeInstanceOf(SchemaRowRuleError)
    expect(mapSchemaRowRuleError(rowRuleCodes, caught)?.code).toBe(code)
    expect(
      mapSchemaRowRuleError(rowRuleCodes, new Error('query failed', { cause: caught }))?.code,
    ).toBe(code)
  }
}
async function rowRules(engine: Engine): Promise<void> {
  await insert(engine, 'tasks', task('gate-task'))
  const operation = {
    id: 'sealed',
    task_id: 'gate-task',
    gate_kind: 'review',
    operation_kind: 'open',
    gate_ref: 'gate',
    idempotency_key: 'sealed',
    request_hash: 'hash',
    expected_task_revision: 0,
    expected_gate_revision: 0,
    state: 'preparing',
    created_at: 1,
    updated_at: 1,
  }
  await insert(engine, 'collaboration_gate_operations', operation)
  await engine.exec(
    `UPDATE collaboration_gate_operations SET result_gate_revision = 1, receipt_json = '{ "order": [2,1] }', committed_at = 1, state = 'committed' WHERE id = 'sealed'`,
  )
  for (const change of ['result_gate_revision = NULL', "receipt_json = '{}'", 'committed_at = 2'])
    await rejected(
      engine,
      `UPDATE collaboration_gate_operations SET ${change} WHERE id = 'sealed'`,
      'human-gate-committed-receipt-immutable',
    )
  await engine.exec(
    "UPDATE collaboration_gate_operations SET receipt_json = receipt_json, state = 'completed', completed_at = 2 WHERE id = 'sealed'",
  )
  expect(
    (
      await engine.rows(
        "SELECT receipt_json FROM collaboration_gate_operations WHERE id = 'sealed'",
      )
    )[0]?.receipt_json,
  ).toBe('{ "order": [2,1] }')
  await insert(engine, 'collaboration_gate_operations', {
    ...operation,
    id: 'unsealed',
    idempotency_key: 'unsealed',
  })
  await engine.exec(
    "UPDATE collaboration_gate_operations SET receipt_json = '{}' WHERE id = 'unsealed'",
  )
  await engine.exec("DELETE FROM collaboration_gate_operations WHERE id = 'unsealed'")
  // Legacy immutableOnceSet protects UPDATE only; sealed rows can be deleted directly.
  await engine.exec("DELETE FROM collaboration_gate_operations WHERE id = 'sealed'")
  expect(
    await engine.rows("SELECT id FROM collaboration_gate_operations WHERE id = 'sealed'"),
  ).toEqual([])
  await insert(engine, 'collaboration_gate_operations', {
    ...operation,
    id: 'cascade',
    idempotency_key: 'cascade',
    result_gate_revision: 1,
    receipt_json: '{}',
    committed_at: 1,
  })
  // Task deletion still cascades sealed receipts.
  await engine.exec("DELETE FROM tasks WHERE id = 'gate-task'")
  expect(
    await engine.rows("SELECT id FROM collaboration_gate_operations WHERE task_id = 'gate-task'"),
  ).toEqual([])
  const audit = {
    id: 'audit',
    target_user_id: '__system__',
    actor_kind: 'system',
    operation_id: 'op',
    before_role: 'guest',
    after_role: 'user',
    added_permissions_json: '[]',
    removed_permissions_json: '[]',
    access_revision: 1,
    created_at: 1,
  }
  await insert(engine, 'user_access_audit', audit)
  await rejected(
    engine,
    "UPDATE user_access_audit SET after_role = 'admin' WHERE id = 'audit'",
    'user_access_audit_append_only',
  )
  await rejected(
    engine,
    "UPDATE user_access_audit SET id = id WHERE id = 'audit'",
    'user_access_audit_append_only',
  )
  await rejected(
    engine,
    "DELETE FROM user_access_audit WHERE id = 'audit'",
    'user_access_audit_append_only',
  )
  await insert(engine, 'user_access_audit', { ...audit, id: 'audit-2', access_revision: 2 })
  expect(await engine.rows('SELECT id FROM user_access_audit ORDER BY id')).toEqual([
    { id: 'audit' },
    { id: 'audit-2' },
  ])
}
async function deleteActions(engine: Engine): Promise<void> {
  await insert(engine, 'users', user('creator'))
  await insert(engine, 'users', user('created', { created_by: 'creator' }))
  await insert(engine, 'tasks', task('retained-task', { owner_user_id: 'creator' }))
  await engine.exec("DELETE FROM users WHERE id = 'creator'")
  expect(
    (await engine.rows("SELECT created_by FROM users WHERE id = 'created'"))[0]?.created_by,
  ).toBeNull()
  expect(
    (await engine.rows("SELECT owner_user_id FROM tasks WHERE id = 'retained-task'"))[0]
      ?.owner_user_id,
  ).toBeNull()
  const memory = {
    scope_type: 'global',
    title: 'memory',
    body_md: 'body',
    status: 'approved',
    source_kind: 'manual',
    created_at: 1,
  }
  await insert(engine, 'memories', { ...memory, id: 'old' })
  await insert(engine, 'memories', { ...memory, id: 'new', supersedes_id: 'old' })
  await engine.exec("UPDATE memories SET superseded_by_id = 'new' WHERE id = 'old'")
  await engine.exec("DELETE FROM memories WHERE id = 'new'")
  expect(
    (await engine.rows("SELECT superseded_by_id FROM memories WHERE id = 'old'"))[0]
      ?.superseded_by_id,
  ).toBeNull()
  await insert(engine, 'memories', { ...memory, id: 'new', supersedes_id: 'old' })
  await engine.exec("DELETE FROM memories WHERE id = 'old'")
  expect(
    (await engine.rows("SELECT supersedes_id FROM memories WHERE id = 'new'"))[0]?.supersedes_id,
  ).toBeNull()
  await insert(engine, 'users', user('adder'))
  await insert(engine, 'task_collaborators', {
    task_id: 'retained-task',
    user_id: 'created',
    role: 'collaborator',
    added_by: 'adder',
    added_at: 1,
  })
  await rejected(engine, "DELETE FROM users WHERE id = 'adder'")
  await engine.exec("DELETE FROM task_collaborators WHERE task_id = 'retained-task'")
  await engine.exec("DELETE FROM users WHERE id = 'adder'")
  for (const id of ['group-parent', 'group-child'])
    await insert(engine, 'repo_groups', { id, name: id, created_at: 1, updated_at: 1 })
  await insert(engine, 'repo_group_nodes', {
    group_id: 'group-parent',
    path: 'child',
    attachment_kind: 'group',
    child_group_id: 'group-child',
  })
  await rejected(engine, "DELETE FROM repo_groups WHERE id = 'group-child'")
  await engine.exec("DELETE FROM repo_groups WHERE id = 'group-parent'")
  await engine.exec("DELETE FROM repo_groups WHERE id = 'group-child'")
  const mission = {
    status: 'active',
    repository_id: 'repo',
    source_kind: 'text',
    delivery_kind: 'none',
    created_at: 1,
    updated_at: 1,
  }
  await insert(engine, 'development_missions', { ...mission, id: 'previous' })
  await insert(engine, 'development_missions', {
    ...mission,
    id: 'reopened',
    reopened_from_mission_id: 'previous',
  })
  await rejected(engine, "DELETE FROM development_missions WHERE id = 'previous'")
  await engine.exec("DELETE FROM development_missions WHERE id = 'reopened'")
  await engine.exec("DELETE FROM development_missions WHERE id = 'previous'")
}
async function taskChildren(engine: Engine): Promise<void> {
  await insert(engine, 'tasks', task('owner-task'))
  await insert(engine, 'tasks', task('child-task', { parent_task_id: 'owner-task' }))
  await insert(engine, 'task_execution_generations', {
    task_id: 'owner-task',
    generation_seq: 0,
    cause: 'legacy',
    created_at: 1,
  })
  await insert(engine, 'task_definitions', {
    task_id: 'owner-task',
    subject_kind: 'workflow',
    definition_origin: 'authored',
    engine_kind: 'workflow',
    workflow_snapshot: '{}',
    inputs: '{}',
  })
  await insert(engine, 'task_launch_contexts', {
    task_id: 'owner-task',
    execution_lineage_id: 'lineage',
    lineage_slot_path_json: '[]',
  })
  await insert(engine, 'task_workspaces', {
    task_id: 'owner-task',
    requested_source: '{"version":1,"kind":"scratch"}',
    task_branch: 'task',
  })
  await insert(engine, 'task_repository_mounts', {
    task_id: 'owner-task',
    repo_key: 'repo',
    ordinal: 0,
    repo_path: '/repo',
    base_branch: 'main',
    branch: 'task',
    mount_path: '',
    branch_state: 'branch',
  })
  await insert(engine, 'node_runs', run('container', { role: 'container' }))
  await insert(engine, 'node_runs', run('attempt', { seq: 2, container_run_id: 'container' }))
  await rejected(engine, "DELETE FROM node_runs WHERE id = 'container'")
  await insert(
    engine,
    'node_runs',
    run('history', {
      seq: 3,
      role: null,
      scope_path: null,
      slot_key: null,
      attempt_index: null,
      record_mode: 'history-only',
      provenance_quality: 'unknown',
      envelope_nonce: null,
    }),
  )
  await insert(
    engine,
    'node_runs',
    run('task-synthetic', {
      seq: 4,
      role: 'synthetic',
      synthetic_owner: 'task:owner-task',
      container_run_id: null,
    }),
  )
  await rejected(engine, "UPDATE node_runs SET synthetic_owner = NULL WHERE id = 'task-synthetic'")
  await rejected(engine, "UPDATE node_runs SET seq = NULL WHERE id = 'attempt'")
  await rejected(engine, "UPDATE node_runs SET envelope_nonce = NULL WHERE id = 'attempt'")
  await rejected(engine, "UPDATE node_runs SET role = NULL WHERE id = 'attempt'")
  await insert(engine, 'node_run_selections', {
    task_id: 'owner-task',
    slot_key: 'slot-v1:attempt',
    selected_run_id: 'attempt',
    revision: 1,
    generation_seq: 0,
    cause: 'initial',
    selected_at: 1,
  })
  await rejected(
    engine,
    "UPDATE node_run_selections SET selected_run_id = 'container' WHERE task_id = 'owner-task'",
  )
  await insert(engine, 'node_run_inputs', {
    task_id: 'owner-task',
    consumer_run_id: 'attempt',
    ordinal: 0,
    producer_run_id: 'container',
    producer_run_ref: 'container',
    input_kind: 'frame-input',
    producer_node_id: 'container',
    producer_shard_slot: NO_PRODUCER_SHARD_SLOT,
  })
  expect(producerShardSlot(null)).toBe(NO_PRODUCER_SHARD_SLOT)
  expect(producerShardSlot('')).not.toBe(NO_PRODUCER_SHARD_SLOT)
  expect(producerShardSlot('none')).not.toBe(NO_PRODUCER_SHARD_SLOT)
  await insert(engine, 'node_run_inputs', {
    task_id: 'owner-task',
    consumer_run_id: 'attempt',
    ordinal: 1,
    producer_run_id: 'removed-producer',
    producer_run_ref: null,
    provenance_quality: 'legacy-derived',
    evidence_ref_json: '{"source":"consumed_upstream_runs_json","id":"removed-producer"}',
    input_kind: 'frame-input',
    producer_node_id: 'removed',
    producer_shard_slot: NO_PRODUCER_SHARD_SLOT,
  })
  await rejected(
    engine,
    "UPDATE node_run_inputs SET provenance_quality = 'recorded' WHERE ordinal = 1",
  )
  await rejected(engine, 'UPDATE node_run_inputs SET evidence_ref_json = NULL WHERE ordinal = 1')
  await rejected(
    engine,
    "UPDATE node_run_inputs SET producer_run_ref = 'removed-producer' WHERE ordinal = 1",
  )
  await rejected(
    engine,
    "UPDATE node_run_inputs SET producer_run_ref = 'attempt' WHERE ordinal = 0",
  )
  const defaults = run('defaults', { seq: 5 }) as Record<string, Cell>
  delete defaults.scope_path
  delete defaults.attempt_index
  await insert(engine, 'node_runs', defaults)
  const defaultRow = (
    await engine.rows(
      "SELECT scope_path, attempt_index, inputs_recorded FROM node_runs WHERE id = 'defaults'",
    )
  )[0]!
  expect(defaultRow.scope_path).toBe('')
  expect(Number(defaultRow.attempt_index)).toBe(0)
  expect(Boolean(defaultRow.inputs_recorded)).toBe(false)
  await insert(engine, 'execution_legacy_evidence', {
    task_id: 'owner-task',
    record_kind: 'node-run',
    record_id: 'old-run',
    source_contract: 'epoch-1',
    provenance_quality: 'legacy-derived',
    missing_fields_json: '[]',
    content_ref_json: '{"version":1,"kind":"object","objectId":"evidence"}',
  })
  for (const table of ['node_run_configs', 'node_run_runtime_states', 'node_run_results'])
    await insert(engine, table, { node_run_id: 'attempt' })
  await insert(engine, 'node_run_repo_checkpoints', {
    task_id: 'owner-task',
    node_run_id: 'attempt',
    repo_key: 'repo',
    pre_snapshot: '',
  })
  await insert(engine, 'runtime_session_leases', {
    protocol: 'opencode',
    session_id: 'session',
    task_id: 'owner-task',
    node_id: 'attempt',
    created_node_run_id: 'attempt',
  })
  await rejected(
    engine,
    `UPDATE runtime_session_leases SET reset_pending = ${literal(engine, true)} WHERE session_id = 'session'`,
  )
  await engine.exec(
    `UPDATE runtime_session_leases SET lease_node_run_id = 'attempt', lease_nonce_digest = 'digest', leased_at = 1, reset_pending = ${literal(engine, true)} WHERE session_id = 'session'`,
  )
  await engine.exec("DELETE FROM tasks WHERE id = 'owner-task'")
  for (const table of [
    'task_definitions',
    'task_launch_contexts',
    'task_workspaces',
    'task_repository_mounts',
    'task_execution_generations',
    'node_runs',
    'node_run_selections',
    'node_run_inputs',
    'node_run_configs',
    'node_run_runtime_states',
    'node_run_results',
    'node_run_repo_checkpoints',
    'runtime_session_leases',
    'execution_legacy_evidence',
  ])
    expect(await engine.rows(`SELECT * FROM ${quote(table)}`), table).toEqual([])
  expect(await engine.rows("SELECT id FROM tasks WHERE id = 'child-task'")).toEqual([])
}
async function nullKeysAndContent(engine: Engine): Promise<void> {
  const owner = defineContribution('null-fixture')
  const definition = owner.table({
    id: 'null_keys',
    schemaSymbol: 'nullKeys',
    retention: retention.business,
    columns: {
      id: c.id('id', { primary: true }),
      value: c.text('value', { nullable: true }),
      indexed: c.int('indexed', { nullable: true }),
      active: c.bool('active'),
    },
    unique: [{ name: 'null_keys_value', columns: ['value'], nulls: 'not-distinct' }],
    indexes: [
      index('null_keys_active', ['indexed'], {
        unique: true,
        nulls: 'not-distinct',
        where: {
          kind: 'binary',
          op: '=',
          left: { kind: 'column', name: 'active' },
          right: { kind: 'literal', value: true },
        },
      }),
    ],
  })
  const registry = createSchemaRegistry([owner.contribution([definition])], { schemaEpoch: 2 })
  const plan =
    engine.provider === 'sqlite' ? compileSqlitePlan(registry) : compilePostgresqlPlan(registry)
  for (const statement of plan.statements)
    if (statement.kind !== 'bootstrap') await engine.exec(statement.sql)
  await insert(engine, 'null_keys', { id: 'null', value: null, indexed: null, active: true })
  await rejected(
    engine,
    `INSERT INTO null_keys (id,value,indexed,active) VALUES ('duplicate-null',NULL,1,${literal(engine, false)})`,
  )
  await insert(engine, 'null_keys', { id: 'empty', value: '', indexed: 0, active: true })
  await rejected(
    engine,
    `INSERT INTO null_keys (id,value,indexed,active) VALUES ('index-null','other',NULL,${literal(engine, true)})`,
  )
  await insert(engine, 'null_keys', {
    id: 'inactive',
    value: 'other',
    indexed: null,
    active: false,
  })
  // Nullable distinct email is exercised by all inserted users; a non-NULL duplicate still fails.
  await engine.exec("UPDATE users SET email = 'x@example.test' WHERE id = 'created'")
  await rejected(engine, "UPDATE users SET email = 'x@example.test' WHERE id = '__system__'")
  await insert(engine, 'skills', {
    id: 'unbound-skill',
    name: 'unbound-skill',
    reservation_state: 'reserving',
  })
  expect(
    (await engine.rows("SELECT content_ref_json FROM skills WHERE id = 'unbound-skill'"))[0]
      ?.content_ref_json,
  ).toBeNull()
  const bytes = Buffer.from([0, 255, 10, 13, 34, 123, 125])
  const reference = '{ "version": 1, "kind": "inline", "sha256": "digest", "size": 7 }'
  await insert(engine, 'execution_legacy_evidence', {
    record_kind: 'node-run',
    record_id: 'source',
    source_contract: 'epoch-1',
    provenance_quality: 'unknown',
    missing_fields_json: '[]',
    content_ref_json: reference,
    content_inline_bytes: bytes,
  })
  const record = (
    await engine.rows(
      'SELECT content_ref_json, content_inline_bytes FROM execution_legacy_evidence',
    )
  )[0]!
  expect(record.content_ref_json).toBe(reference)
  expect(Buffer.from(record.content_inline_bytes as Uint8Array)).toEqual(bytes)
  await rejected(engine, 'UPDATE execution_legacy_evidence SET content_inline_bytes = NULL')
  await rejected(
    engine,
    `UPDATE execution_legacy_evidence SET content_ref_json = '{"version":2,"kind":"inline"}'`,
  )
  await insert(engine, 'hosted_node_event_archives', {
    id: 'archive',
    task_id: 'archived-task',
    node_run_id: 'archived-run',
    first_id: 1,
    last_id: 1,
    row_count: 1,
    digest: 'digest',
    size: 7,
    state: 'prepared',
    created_at: 1,
  })
  await rejected(
    engine,
    "UPDATE hosted_node_event_archives SET state = 'ready' WHERE id = 'archive'",
  )
  await engine.exec(
    `UPDATE hosted_node_event_archives SET state = 'ready', content_ref_json = '${JSON.stringify({ version: 1, kind: 'object', objectId: 'object' })}' WHERE id = 'archive'`,
  )
}

async function archiveAndBranches(engine: Engine): Promise<void> {
  for (const [path, kind] of [
    ['directory', 'directory'],
    ['empty-file', 'file'],
    ['appended-file', 'file'],
  ])
    await insert(engine, 'hosted_task_archive_entries', {
      path: path!,
      kind: kind!,
      created_at: 1,
      updated_at: 1,
    })
  expect(await engine.rows('SELECT * FROM hosted_task_archive_entry_parts')).toEqual([])
  for (const ordinal of [1, 0, 2])
    await insert(engine, 'hosted_task_archive_entry_parts', {
      path: 'appended-file',
      ordinal,
      part_key: `publication-${ordinal}`,
      content_ref_json: JSON.stringify({ version: 1, kind: 'inline' }),
      content_inline_bytes: Buffer.from(`part-${ordinal}`),
    })
  expect(
    (
      await engine.rows(
        "SELECT part_key FROM hosted_task_archive_entry_parts WHERE path = 'appended-file' ORDER BY ordinal",
      )
    ).map((row) => row.part_key),
  ).toEqual(['publication-0', 'publication-1', 'publication-2'])
  await rejected(engine, 'UPDATE hosted_task_archive_entry_parts SET ordinal = 0 WHERE ordinal = 1')
  await engine.exec("DELETE FROM hosted_task_archive_entries WHERE path = 'appended-file'")
  expect(await engine.rows('SELECT * FROM hosted_task_archive_entry_parts')).toEqual([])
  await insert(engine, 'tasks', task('branch-task'))
  for (const [ordinal, state] of ['branch', 'detached', 'unborn', 'none'].entries()) {
    await insert(engine, 'task_repository_mounts', {
      task_id: 'branch-task',
      repo_key: state,
      ordinal,
      mount_path: state,
      repo_path: '/repo',
      branch_state: state,
      branch: state === 'branch' ? 'topic' : null,
      base_branch: state === 'branch' ? 'main' : null,
      base_commit: state === 'detached' ? 'commit' : null,
    })
  }
  await engine.exec(
    "UPDATE task_repository_mounts SET base_branch = base_commit WHERE branch_state = 'detached'",
  )
  await rejected(
    engine,
    "UPDATE task_repository_mounts SET base_branch = 'different' WHERE branch_state = 'detached'",
  )
  await engine.exec(
    "UPDATE task_repository_mounts SET base_branch = NULL WHERE branch_state = 'detached'",
  )
  for (const statement of [
    "UPDATE task_repository_mounts SET branch = '' WHERE branch_state = 'branch'",
    "UPDATE task_repository_mounts SET branch = NULL WHERE branch_state = 'branch'",
    "UPDATE task_repository_mounts SET branch = 'fake' WHERE branch_state = 'none'",
    "UPDATE task_repository_mounts SET base_commit = NULL WHERE branch_state = 'detached'",
    "UPDATE task_repository_mounts SET base_commit = 'fake' WHERE branch_state = 'unborn'",
    "UPDATE task_repository_mounts SET base_branch = '' WHERE branch_state = 'none'",
    "UPDATE task_repository_mounts SET branch_state = 'invalid' WHERE branch_state = 'none'",
  ])
    await rejected(engine, statement)
  await insert(engine, 'content_objects', {
    content_id: 'unknown-media',
    content_version: 1,
    sha256: 'digest',
    size: 0,
    kind: 'object',
    location_json: '{}',
    created_at: 1,
  })
  expect(
    (
      await engine.rows("SELECT media_type FROM content_objects WHERE content_id = 'unknown-media'")
    )[0]!.media_type,
  ).toBeNull()
  // Non-task evidence remains unowned, while task-owned evidence was checked in taskChildren.
  await engine.exec("DELETE FROM tasks WHERE id = 'branch-task'")
  expect(
    (
      await engine.rows('SELECT record_id FROM execution_legacy_evidence WHERE task_id IS NULL')
    ).map((row) => row.record_id),
  ).toEqual(['source'])
}

async function clarifyAttributionsAndLegacyAnswers(engine: Engine): Promise<void> {
  await insert(engine, 'tasks', task('clarify-task'))
  await insert(engine, 'task_execution_generations', {
    task_id: 'clarify-task',
    generation_seq: 0,
    cause: 'legacy',
    created_at: 1,
  })
  await insert(engine, 'node_runs', run('clarify-run', { task_id: 'clarify-task' }))
  const round = {
    task_id: 'clarify-task',
    kind: 'self',
    asking_node_id: 'n',
    asking_node_run_id: 'clarify-run',
    intermediary_node_id: 'n',
    intermediary_node_run_id: 'clarify-run',
    questions_json: '[]',
    created_at: 1,
  }
  for (const [id, recorded] of [
    ['absent', false],
    ['empty', true],
    ['standalone', true],
  ] as const)
    await insert(engine, 'clarify_rounds', { ...round, id, attributions_recorded: recorded })
  expect(
    (await engine.rows('SELECT id, attributions_recorded FROM clarify_rounds ORDER BY id')).map(
      (row) => [row.id, Boolean(row.attributions_recorded)],
    ),
  ).toEqual([
    ['absent', false],
    ['empty', true],
    ['standalone', true],
  ])
  const values = [' { "userId": "older", "updatedAt": 1 }\n', 'null', '{"userId":"newer"}']
  for (const [ordinal, questionId] of ['10', '2', '10'].entries())
    await insert(engine, 'clarify_answer_attributions', {
      round_id: 'standalone',
      question_id: questionId,
      occurrence: ordinal === 2 ? 1 : 0,
      ordinal,
      value_json: values[ordinal]!,
    })
  const stored = await engine.rows(
    'SELECT question_id, occurrence, ordinal, value_json FROM clarify_answer_attributions ORDER BY ordinal',
  )
  expect(
    stored.map((row) => [
      row.question_id,
      Number(row.occurrence),
      Number(row.ordinal),
      row.value_json,
    ]),
  ).toEqual([
    ['10', 0, 0, values[0]],
    ['2', 0, 1, values[1]],
    ['10', 1, 2, values[2]],
  ])
  for (const table of ['clarify_answers', 'clarify_answer_drafts']) {
    expect(await engine.rows(`SELECT * FROM ${quote(table)}`)).toEqual([])
    await insert(engine, table, {
      round_id: 'standalone',
      question_id: '10',
      occurrence: 0,
      ordinal: 0,
      value_json: '{}',
      questions_revision: 1,
      updated_at: 1,
    })
    await engine.exec(`DELETE FROM ${quote(table)} WHERE round_id = 'standalone'`)
  }
  expect(
    await engine.rows(
      'SELECT question_id, occurrence, ordinal, value_json FROM clarify_answer_attributions ORDER BY ordinal',
    ),
  ).toEqual(stored)
  for (const statement of [
    "UPDATE clarify_answer_attributions SET occurrence = 0 WHERE question_id = '10' AND occurrence = 1",
    'UPDATE clarify_answer_attributions SET ordinal = 0 WHERE ordinal = 1',
    "UPDATE clarify_answer_attributions SET round_id = 'missing'",
    'UPDATE clarify_answer_attributions SET value_json = NULL',
  ])
    await rejected(engine, statement)
  const legacy = ['{}', '"legacy"', '0', 'null', ' { "值": 1 }\n']
  for (const [ordinal, text] of legacy.entries())
    await insert(engine, 'clarify_rounds', {
      ...round,
      id: `legacy-${ordinal}`,
      legacy_answers_json: text,
    })
  expect(
    (
      await engine.rows(
        "SELECT legacy_answers_json, answers_recorded FROM clarify_rounds WHERE id LIKE 'legacy-%' ORDER BY id",
      )
    ).map((row) => [row.legacy_answers_json, Boolean(row.answers_recorded)]),
  ).toEqual(legacy.map((text) => [text, false]))
  await insert(engine, 'clarify_rounds', { ...round, id: 'array', answers_recorded: true })
  expect(
    (
      await engine.rows(
        "SELECT legacy_answers_json FROM clarify_rounds WHERE id IN ('absent', 'array')",
      )
    ).map((row) => row.legacy_answers_json),
  ).toEqual([null, null])
  await engine.exec("DELETE FROM clarify_rounds WHERE id = 'standalone'")
  expect(await engine.rows('SELECT * FROM clarify_answer_attributions')).toEqual([])
  await insert(engine, 'clarify_answer_attributions', {
    round_id: 'empty',
    question_id: 'q',
    occurrence: 0,
    ordinal: 0,
    value_json: '{}',
  })
  await engine.exec("DELETE FROM tasks WHERE id = 'clarify-task'")
  expect(await engine.rows('SELECT * FROM clarify_rounds')).toEqual([])
  expect(await engine.rows('SELECT * FROM clarify_answer_attributions')).toEqual([])
}

describeEachProvider('RFC-395 II-b R1 dormant native target baseline', (harness) => {
  withR2TargetHarness(harness, (target) => {
    test('seeds, row rules, FK actions, task cascades, explicit NULL uniqueness and content bytes', async () => {
      const engine = targetEngine(target)
      const plan =
        engine.provider === 'sqlite'
          ? compileSqlitePlan(persistenceSchema)
          : compilePostgresqlPlan(persistenceSchema)
      for (const statement of plan.statements) await engine.exec(statement.sql)
      const seeds = compileInstallSeeds(persistenceSchema, {
        path: 'test-baseline',
        installedAt: 1800000000123,
      })
      for (const statement of renderInstallSeedStatements(seeds.rows, engine.provider))
        await engine.exec(statement)
      expect(
        (await engine.rows('SELECT producer,family,epoch FROM committed_event_family_cutovers'))
          .length,
      ).toBe(4)
      expect(await engine.rows("SELECT id FROM users WHERE id = '__system__'")).toEqual([
        { id: '__system__' },
      ])
      await rowRules(engine)
      await deleteActions(engine)
      await taskChildren(engine)
      await nullKeysAndContent(engine)
      await archiveAndBranches(engine)
      await clarifyAttributionsAndLegacyAnswers(engine)
    }, 180_000)
  })
})
