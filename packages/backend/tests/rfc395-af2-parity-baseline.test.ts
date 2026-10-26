// AF-D22 / BF-D26: baseline provenance is independent of CI checkout depth.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createQ1Epoch1Fixture,
  frozenFile,
  resolveQ1BaselineCommit,
  Q1_AGENT_RELATIONS,
} from './helpers/rfc395Q1Parity/fixture'

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// A tiny SQL chain sufficient for the synthetic parity data; no main-repository
// refs, remotes, frozen-chain files or network are required in the default lane.
const columns = {
  users: 'id username display_name role status created_at updated_at',
  user_sessions: 'id user_id token_hash created_at last_used_at expires_at',
  agents: 'id name created_at updated_at skills depends_on mcp plugins',
  workflows: 'id name definition created_at updated_at',
  tasks:
    'id name workflow_id workflow_version workflow_snapshot repo_path worktree_path base_branch branch status inputs space_kind started_at finished_at owner_user_id branch_started_at',
  node_runs:
    'id task_id node_id status seq retry_index scope_path started_at finished_at envelope_nonce review_iteration parent_node_run_id opencode_session_id prompt_text tok_total',
  node_run_events: 'id node_run_id ts kind session_id parent_session_id payload',
  observation_calls:
    'id purpose task_id node_run_id owner_user_id agent_id agent_name runtime_name protocol status started_at ended_at usage_state input_tokens output_tokens cost_state updated_at',
  observation_call_models: 'call_id model input_tokens output_tokens cost_state',
  doc_versions:
    'id task_id review_node_id review_node_run_id source_node_id source_port_name version_index review_iteration body_path decision created_at decided_at decided_by decided_by_role',
  clarify_rounds:
    'id task_id kind asking_node_id asking_node_run_id intermediary_node_id intermediary_node_run_id questions_json answers_json draft_answers_json answer_attributions_json status directive created_at answered_at answered_by submitted_by_role',
}
const prefix = 'packages/backend/db/migrations'
async function withRepository(
  run: (fixture: {
    repository: string
    root: string
    first: string
    second: string
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'rfc395-bfb-baseline-'))
  try {
    const repository = join(root, 'repository')
    await mkdir(join(repository, prefix, 'meta'), { recursive: true })
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Parity fixture',
          '-c',
          'user.email=parity@example.invalid',
          '-c',
          'commit.gpgsign=false',
          '-c',
          `core.hooksPath=${join(root, 'no-hooks')}`,
          ...args,
        ],
        { cwd: repository, encoding: 'utf8' },
      ).trim()
    git('init', '--initial-branch=main')
    const entries = [{ tag: '0000_fixture', when: 1, breakpoints: true }]
    await writeFile(
      join(repository, prefix, '0000_fixture.sql'),
      [
        ...Object.entries(columns).map(
          ([table, fields]) =>
            `CREATE TABLE "${table}" (${fields
              .split(' ')
              .map((field) => `"${field}"`)
              .join(', ')});`,
        ),
        // Drizzle executes one statement per breakpoint chunk.
        'CREATE TABLE baseline_marker (value TEXT);',
        "INSERT INTO baseline_marker VALUES ('first');",
      ].join('\n--> statement-breakpoint\n'),
    )
    const journal = () =>
      writeFile(join(repository, prefix, 'meta/_journal.json'), JSON.stringify({ entries }))
    await journal()
    git('add', '--', prefix)
    git('commit', '-m', 'first fixture chain')
    const first = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/remotes/origin/main', first)
    entries.push({ tag: '0001_marker', when: 2, breakpoints: true })
    await writeFile(
      join(repository, prefix, '0001_marker.sql'),
      "UPDATE baseline_marker SET value = 'second';",
    )
    await journal()
    git('add', '--', prefix)
    git('commit', '-m', 'second fixture chain')
    const second = git('rev-parse', 'HEAD')
    // Working files deliberately disagree with both committed baselines.
    await writeFile(join(repository, prefix, '0000_fixture.sql'), 'not executable SQL')
    await run({ repository, root, first, second })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('default is the delivery baseline; the environment can select a different full commit', async () => {
  await withRepository(async ({ repository, first, second }) => {
    expect(first).not.toBe(second)
    expect(resolveQ1BaselineCommit(repository, {})).toBe(first)
    expect(resolveQ1BaselineCommit(repository, { RFC395_Q1_OLD_COMMIT: ' HEAD ' })).toBe(second)
    expect(resolveQ1BaselineCommit(repository, { RFC395_Q1_OLD_COMMIT: first })).toBe(first)
  })
})

test('every fixture migration and its provenance come from the selected commit', async () => {
  await withRepository(async ({ repository, root, first, second }) => {
    for (const [commit, marker] of [
      [first, 'first'],
      [second, 'second'],
    ] as const) {
      const home = join(root, marker)
      const { provenance } = await createQ1Epoch1Fixture(repository, home, commit)
      const journalBytes = frozenFile(repository, `${prefix}/meta/_journal.json`, commit)
      const journal = JSON.parse(journalBytes.toString('utf8')) as { entries: { tag: string }[] }
      expect(provenance.sourceCommit).toBe(commit)
      expect(provenance.journalSha256).toBe(digest(journalBytes))
      expect(provenance.migrations).toEqual(
        journal.entries.map(({ tag }) => ({
          tag,
          sha256: digest(frozenFile(repository, `${prefix}/${tag}.sql`, commit)),
        })),
      )
      const db = new Database(join(home, 'db.sqlite'), { readonly: true })
      try {
        expect(db.query('SELECT value FROM baseline_marker').get()).toEqual({ value: marker })
        const agent = db
          .query<
            { skills: string; depends_on: string; mcp: string; plugins: string },
            []
          >("SELECT skills, depends_on, mcp, plugins FROM agents WHERE id = 'q1-agent'")
          .get()!
        expect(JSON.parse(agent.skills)).toEqual(Q1_AGENT_RELATIONS.skills)
        expect(JSON.parse(agent.depends_on)).toEqual(Q1_AGENT_RELATIONS.dependsOn)
        expect(JSON.parse(agent.mcp)).toEqual(Q1_AGENT_RELATIONS.mcp)
        expect(JSON.parse(agent.plugins)).toEqual(Q1_AGENT_RELATIONS.plugins)
        expect(db.query('SELECT node_run_id FROM node_run_events ORDER BY id').all()).toEqual([
          { node_run_id: 'q1-agent-run' },
          { node_run_id: 'q1-unknown-run' },
        ])
        expect(db.query('SELECT id, node_run_id FROM observation_calls ORDER BY id').all()).toEqual(
          [
            { id: 'q1-call-0', node_run_id: 'q1-agent-run' },
            { id: 'q1-call-1', node_run_id: 'q1-unknown-run' },
          ],
        )
      } finally {
        db.close()
      }
    }
  })
})
