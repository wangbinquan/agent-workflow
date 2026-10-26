import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

/** Resolve once before the delivery; fixture, binary and provenance use this full commit. */
export function resolveQ1BaselineCommit(
  repository: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const ref = env.RFC395_Q1_OLD_COMMIT?.trim() || 'origin/main'
  return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: repository,
    encoding: 'utf8',
  }).trim()
}
export const Q1_TASK = 'q1-parity-task'
export const Q1_CLARIFY_RUN = 'q1-clarify-run'
export const Q1_AGENT = 'q1-agent'
// Deliberately non-lexical, repeated and dangling references: ordinal replay is
// observable even though these terminal tasks will never execute the agent.
export const Q1_AGENT_RELATIONS = {
  skills: [
    { kind: 'managed', skillId: 'q1-skill-z' },
    { kind: 'project', name: 'repository-local-skill' },
    { kind: 'managed', skillId: 'deleted-skill-a' },
    { kind: 'managed', skillId: 'q1-skill-z' },
  ],
  dependsOn: ['q1-dependency-z', 'q1-dependency-a', 'q1-dependency-z'],
  mcp: ['q1-mcp-z', 'deleted-mcp-a', 'q1-mcp-z'],
  plugins: ['q1-plugin-z', 'deleted-plugin-a', 'q1-plugin-z'],
} as const
export function frozenFile(repository: string, path: string, commit: string): Buffer {
  return execFileSync('git', ['show', `${commit}:${path}`], {
    cwd: repository,
    maxBuffer: 32 * 1024 * 1024,
  })
}

export async function createQ1Epoch1Fixture(
  repository: string,
  home: string,
  sourceCommit = resolveQ1BaselineCommit(repository),
  sourceInstalled = false,
) {
  await mkdir(home, { recursive: true })
  const prefix = 'packages/backend/db/migrations'
  const journalBytes = frozenFile(repository, `${prefix}/meta/_journal.json`, sourceCommit)
  const journal = JSON.parse(journalBytes.toString('utf8')) as {
    entries: { tag: string; when: number; breakpoints: boolean }[]
  }
  const migrations = journal.entries.map((entry) => {
    const bytes = frozenFile(repository, `${prefix}/${entry.tag}.sql`, sourceCommit)
    return {
      sql: bytes.toString('utf8').split('--> statement-breakpoint'),
      hash: createHash('sha256').update(bytes).digest('hex'),
      folderMillis: entry.when,
      bps: entry.breakpoints,
    }
  })
  // The binary lane installs through the old daemon first. The small provenance
  // unit fixture uses Drizzle itself, including its exact sqlite_schema bytes.
  if (!sourceInstalled) {
    const folder = join(home, 'q1-frozen-migrations')
    await mkdir(join(folder, 'meta'), { recursive: true })
    await writeFile(join(folder, 'meta/_journal.json'), journalBytes)
    for (const entry of journal.entries)
      await writeFile(
        join(folder, `${entry.tag}.sql`),
        frozenFile(repository, `${prefix}/${entry.tag}.sql`, sourceCommit),
      )
  }
  const db = new Database(join(home, 'db.sqlite'), { readwrite: true, create: !sourceInstalled })
  const token = `aws_s_${randomBytes(32).toString('hex')}`
  const now = Date.now() - 1000
  const definition = JSON.stringify({
    $schema_version: 6,
    inputs: [],
    nodes: [
      { id: 'agent', kind: 'agent-single', agentId: 'q1-agent' },
      { id: 'review', kind: 'review', title: 'Original review' },
      { id: 'clarify', kind: 'clarify', title: 'Original clarify' },
    ],
    edges: [],
  })
  try {
    if (!sourceInstalled)
      migrate(drizzle(db), { migrationsFolder: join(home, 'q1-frozen-migrations') })
    const receipts = db
      .query<
        { hash: string; created_at: number },
        []
      >('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')
      .all()
    if (
      JSON.stringify(receipts) !==
      JSON.stringify(migrations.map((m) => ({ hash: m.hash, created_at: m.folderMillis })))
    )
      throw new Error('q1-installed-source-journal-mismatch')
    const insert = (table: string, values: Record<string, SQLQueryBindings>) => {
      const keys = Object.keys(values)
      db.query(
        `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      ).run(...keys.map((k) => values[k]!))
    }
    insert('users', {
      id: 'q1-user',
      username: 'q1-user',
      display_name: 'Q1 fixture',
      role: 'admin',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    insert('user_sessions', {
      id: 'q1-session',
      user_id: 'q1-user',
      token_hash: createHash('sha256').update(token).digest('hex'),
      created_at: now,
      last_used_at: now,
      expires_at: now + 86400000,
    })
    for (const id of ['q1-dependency-z', 'q1-dependency-a'])
      insert('agents', { id, name: id, created_at: now, updated_at: now })
    insert('agents', {
      id: Q1_AGENT,
      name: Q1_AGENT,
      created_at: now,
      updated_at: now,
      skills: JSON.stringify(Q1_AGENT_RELATIONS.skills),
      depends_on: JSON.stringify(Q1_AGENT_RELATIONS.dependsOn),
      mcp: JSON.stringify(Q1_AGENT_RELATIONS.mcp),
      plugins: JSON.stringify(Q1_AGENT_RELATIONS.plugins),
    })
    insert('workflows', {
      id: 'q1-workflow',
      name: 'Q1 source workflow',
      definition,
      created_at: now,
      updated_at: now,
    })
    insert('tasks', {
      id: Q1_TASK,
      name: 'Q1 parity fixture',
      workflow_id: 'q1-workflow',
      workflow_version: 1,
      workflow_snapshot: definition,
      repo_path: '',
      worktree_path: '',
      base_branch: '',
      branch: `agent-workflow/${Q1_TASK}`,
      status: 'done',
      inputs: '{}',
      space_kind: 'scratch',
      started_at: now,
      finished_at: now + 1,
      owner_user_id: 'q1-user',
      branch_started_at: now,
    })
    for (const [i, [id, nodeId]] of [
      ['q1-agent-run', 'agent'],
      ['q1-review-run', 'review'],
      [Q1_CLARIFY_RUN, 'clarify'],
      ['q1-unknown-run', 'removed-node'],
    ].entries()) {
      // Positive seq values come from this allocator in a real installation.
      // The old daemon rejects seeded runs that are ahead of its high-water mark.
      const seq = sourceInstalled
        ? db
            .query<
              { seq: number },
              [string, string, number]
            >('INSERT INTO node_run_seq_allocations (task_id, node_run_id, allocated_at) VALUES (?, ?, ?) RETURNING seq')
            .get(Q1_TASK, id!, now + i)!.seq
        : i + 1
      insert('node_runs', {
        id: id!,
        task_id: Q1_TASK,
        node_id: nodeId!,
        status: 'done',
        seq,
        retry_index: i,
        scope_path: '',
        started_at: now + i,
        finished_at: now + 10,
        envelope_nonce: `nonce-${i}`,
        review_iteration: 0,
        parent_node_run_id: i === 3 ? 'q1-agent-run' : null,
        opencode_session_id: 'q1-session-display',
        prompt_text: 'Original prompt',
        tok_total: 4,
      })
    }
    for (const [i, runId] of ['q1-agent-run', 'q1-unknown-run'].entries()) {
      insert('node_run_events', {
        id: i + 1,
        node_run_id: runId,
        ts: now + i,
        kind: 'text',
        session_id: 'q1-session-display',
        parent_session_id: null,
        payload: `Original session event ${runId}`,
      })
      insert('observation_calls', {
        id: `q1-call-${i}`,
        purpose: 'task',
        task_id: Q1_TASK,
        node_run_id: runId,
        owner_user_id: 'q1-user',
        agent_id: Q1_AGENT,
        agent_name: Q1_AGENT,
        runtime_name: 'opencode',
        protocol: 'opencode',
        status: 'done',
        started_at: now + i,
        ended_at: now + 10,
        usage_state: 'complete',
        input_tokens: 1,
        output_tokens: 3,
        cost_state: 'unpriced',
        updated_at: now + 10,
      })
      insert('observation_call_models', {
        call_id: `q1-call-${i}`,
        model: 'q1-model',
        input_tokens: 1,
        output_tokens: 3,
        cost_state: 'unpriced',
      })
    }
    const bodyPath = 'reviews/review/docpath/q1-review.md'
    await mkdir(join(home, 'reviews/review/docpath'), { recursive: true })
    await writeFile(join(home, bodyPath), '# Original review\n')
    insert('doc_versions', {
      id: 'q1-doc',
      task_id: Q1_TASK,
      review_node_id: 'review',
      review_node_run_id: 'q1-review-run',
      source_node_id: 'agent',
      source_port_name: 'docpath',
      version_index: 1,
      review_iteration: 0,
      body_path: bodyPath,
      decision: 'approved',
      created_at: now + 5,
      decided_at: now + 6,
      decided_by: 'q1-user',
      decided_by_role: 'owner',
    })
    insert('clarify_rounds', {
      id: 'q1-round',
      task_id: Q1_TASK,
      kind: 'self',
      asking_node_id: 'agent',
      asking_node_run_id: 'q1-agent-run',
      intermediary_node_id: 'clarify',
      intermediary_node_run_id: Q1_CLARIFY_RUN,
      questions_json: '[]',
      answers_json:
        '[{"questionId":"q","selectedOptionIndices":[],"selectedOptionLabels":[],"customText":"original answer"}]',
      draft_answers_json: '{"q":{"selectedOptionIndices":[],"customText":"unsent draft"}}',
      answer_attributions_json: '{"q":{"userId":"q1-user","role":"owner","updatedAt":1}}',
      status: 'answered',
      directive: 'continue',
      created_at: now + 6,
      answered_at: now + 7,
      answered_by: 'q1-user',
      submitted_by_role: 'owner',
    })
  } finally {
    db.close()
  }
  const provenance = {
    sourceCommit,
    installation: sourceInstalled ? 'old-binary' : 'drizzle-migrator',
    journalSha256: createHash('sha256').update(journalBytes).digest('hex'),
    migrations: migrations.map((m, i) => ({ tag: journal.entries[i]!.tag, sha256: m.hash })),
  }
  await writeFile(join(home, 'q1-source-provenance.json'), JSON.stringify(provenance, null, 2))
  return { token, provenance }
}
