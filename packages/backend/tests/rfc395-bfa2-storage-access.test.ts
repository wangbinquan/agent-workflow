// BF-D10/D18: the soak and e2e fixtures write the selected generation and live run columns.
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { taskFixture, nodeRunFixture, workflowFixture } from './helpers/model'
import { prepareSoakDataset } from './helpers/rfc349PostgresqlHostedEvidence'
import { liveSqlitePath, liveSqliteGeneration } from '../../../e2e/storage'
import { removeTempDirSync } from './fixtures/tempDir'

function publish(home: string, generationId: string) {
  writeFileSync(
    join(home, 'database-generation.json'),
    JSON.stringify({
      payload: {
        version: 2,
        generationId,
        database: { kind: 'sqlite-file', relativePath: `databases/${generationId}/db.sqlite` },
      },
    }),
  )
}
test('BF-D18 the one storage helper follows each pointer replacement and never opens a root fallback', () => {
  const home = mkdtempSync(join(tmpdir(), 'bf-storage-'))
  try {
    writeFileSync(join(home, 'db.sqlite'), 'retained source must not be selected')
    expect(() => liveSqlitePath(home)).toThrow()
    for (const id of ['dbg_first', 'dbg_restored']) {
      publish(home, id)
      expect(liveSqliteGeneration(home)).toEqual({
        generationId: id,
        path: join(home, `databases/${id}/db.sqlite`),
      })
      expect(liveSqlitePath(home)).toBe(join(home, `databases/${id}/db.sqlite`))
    }
    writeFileSync(
      join(home, 'database-generation.json'),
      JSON.stringify({ payload: { version: 1 } }),
    )
    expect(() => liveSqlitePath(home)).toThrow('requires a published v2 SQLite generation')
    expect(existsSync(join(home, 'databases'))).toBeFalse()
    expect(readFileSync(join(home, 'db.sqlite'), 'utf8')).toBe(
      'retained source must not be selected',
    )
  } finally {
    removeTempDirSync(home)
  }
})

test('BF-D10 the soak completes pending/running runs with exit codes on node_runs and clears only their runtime PIDs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bf-soak-'))
  publish(home, 'dbg_soak')
  const path = liveSqlitePath(home)
  mkdirSync(join(path, '..'), { recursive: true })
  const db = openDb({ path, generationId: 'dbg_soak' })
  try {
    await workflowFixture(db, {
      id: 'soak-workflow',
      name: 'soak',
      definition: { nodes: [], edges: [] },
    })
    await taskFixture(db, {
      id: 'soak-task',
      workflowId: 'soak-workflow',
      status: 'running',
      repoPath: '/fixture/repo',
      worktreePath: '/fixture/worktree',
      baseBranch: 'main',
      branch: 'soak',
      workflowSnapshot: {},
      inputs: {},
      startedAt: 1,
    })
    for (const [id, status, exitCode] of [
      ['pending', 'pending', null],
      ['running', 'running', 7],
      ['finished', 'done', 9],
    ] as const)
      await nodeRunFixture(db, {
        id,
        taskId: 'soak-task',
        nodeId: id,
        status,
        startedAt: 1,
        exitCode,
        pid: 123,
      })
    const resultsBefore = db.$client
      .query('SELECT * FROM node_run_results ORDER BY node_run_id')
      .all()
    prepareSoakDataset(path)
    expect(db.$client.query('SELECT id,status,exit_code FROM node_runs ORDER BY id').all()).toEqual(
      [
        { id: 'finished', status: 'done', exit_code: 9 },
        { id: 'pending', status: 'done', exit_code: 0 },
        { id: 'running', status: 'done', exit_code: 7 },
      ],
    )
    expect(
      db.$client
        .query('SELECT node_run_id,pid FROM node_run_runtime_states ORDER BY node_run_id')
        .all(),
    ).toEqual([
      { node_run_id: 'finished', pid: 123 },
      { node_run_id: 'pending', pid: null },
      { node_run_id: 'running', pid: null },
    ])
    expect(db.$client.query('SELECT * FROM node_run_results ORDER BY node_run_id').all()).toEqual(
      resultsBefore,
    )
    expect(db.$client.query('SELECT status,finished_at FROM tasks').get()).toMatchObject({
      status: 'done',
      finished_at: expect.any(Number),
    })
    expect(existsSync(join(home, 'db.sqlite'))).toBeFalse()
  } finally {
    db.$client.close()
    removeTempDirSync(home)
  }
})
