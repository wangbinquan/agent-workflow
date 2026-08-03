// RFC-249 — populated v1 repo-group data upgrades losslessly to explicit nodes.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const THROUGH_0133 = mkdtempSync(join(tmpdir(), 'rfc249-through-0133-'))
cpSync(MIGRATIONS, THROUGH_0133, { recursive: true })
const journalPath = join(THROUGH_0133, 'meta', '_journal.json')
const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
  entries: Array<{ idx: number }>
}
journal.entries = journal.entries.filter((entry) => entry.idx <= 132)
writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
afterAll(() => rmSync(THROUGH_0133, { recursive: true, force: true }))

let raw: Database
beforeEach(() => {
  raw = new Database(':memory:')
  raw.exec('PRAGMA foreign_keys = ON')
  migrate(drizzle(raw), { migrationsFolder: THROUGH_0133 })
  raw.exec(`
    INSERT INTO cached_repos
      (id, url_hash, url, local_path, default_branch, last_fetched_at, created_at)
    VALUES
      ('repo-app', 'app00001', 'https://git.example/app.git', '/tmp/app', 'main', 1, 1),
      ('repo-cli', 'cli00001', 'https://git.example/cli.git', '/tmp/cli', 'main', 1, 1);

    INSERT INTO repo_groups
      (id, name, description, schema_version, version, created_at, updated_at)
    VALUES
      ('group-inner', 'inner', '', 1, 1, 1, 1),
      ('group-outer', 'outer', '', 1, 1, 1, 1),
      ('group-empty', 'empty', '', 1, 1, 1, 1);

    INSERT INTO repo_group_members
      (group_id, member_index, kind, cached_repo_id, ref, subdir, child_group_id, mount_path, readonly)
    VALUES
      ('group-inner', 0, 'repo', 'repo-app', 'release', 'packages/app', NULL, '', 0),
      ('group-outer', 0, 'group', NULL, '', '', 'group-inner', 'packages/core', 1),
      ('group-outer', 1, 'repo', 'repo-cli', '', '', NULL, 'tools/cli', 0);
  `)
})

describe('migration 0134/0135 — explicit repo-group and task-space nodes', () => {
  test('旧成员逐项等价迁移，并补齐 root 与全部目录祖先', () => {
    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

    const rows = raw
      .query<
        {
          group_id: string
          path: string
          attachment_kind: string | null
          cached_repo_id: string | null
          ref: string
          subdir: string
          child_group_id: string | null
          readonly: number
        },
        []
      >(
        `
        SELECT group_id, path, attachment_kind, cached_repo_id, ref, subdir,
               child_group_id, readonly
        FROM repo_group_nodes
        ORDER BY group_id, length(path), path
      `,
      )
      .all()

    expect(rows).toEqual([
      {
        group_id: 'group-empty',
        path: '',
        attachment_kind: null,
        cached_repo_id: null,
        ref: '',
        subdir: '',
        child_group_id: null,
        readonly: 0,
      },
      {
        group_id: 'group-inner',
        path: '',
        attachment_kind: 'repo',
        cached_repo_id: 'repo-app',
        ref: 'release',
        subdir: 'packages/app',
        child_group_id: null,
        readonly: 0,
      },
      {
        group_id: 'group-outer',
        path: '',
        attachment_kind: null,
        cached_repo_id: null,
        ref: '',
        subdir: '',
        child_group_id: null,
        readonly: 0,
      },
      {
        group_id: 'group-outer',
        path: 'tools',
        attachment_kind: null,
        cached_repo_id: null,
        ref: '',
        subdir: '',
        child_group_id: null,
        readonly: 0,
      },
      {
        group_id: 'group-outer',
        path: 'packages',
        attachment_kind: null,
        cached_repo_id: null,
        ref: '',
        subdir: '',
        child_group_id: null,
        readonly: 0,
      },
      {
        group_id: 'group-outer',
        path: 'tools/cli',
        attachment_kind: 'repo',
        cached_repo_id: 'repo-cli',
        ref: '',
        subdir: '',
        child_group_id: null,
        readonly: 0,
      },
      {
        group_id: 'group-outer',
        path: 'packages/core',
        attachment_kind: 'group',
        cached_repo_id: null,
        ref: '',
        subdir: '',
        child_group_id: 'group-inner',
        readonly: 1,
      },
    ])
    expect(raw.query(`SELECT 1 FROM sqlite_master WHERE name='repo_group_members'`).all()).toEqual(
      [],
    )
    expect(
      raw.query<{ schema_version: number }, []>('SELECT schema_version FROM repo_groups').all(),
    ).toEqual([{ schema_version: 2 }, { schema_version: 2 }, { schema_version: 2 }])
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
  })

  test('新表约束 attachment 互斥、大小写路径唯一，并建成任务节点快照表', () => {
    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

    expect(() =>
      raw.exec(`
        INSERT INTO repo_group_nodes
          (group_id, path, attachment_kind, cached_repo_id, child_group_id)
        VALUES ('group-empty', 'bad', 'repo', 'repo-app', 'group-inner')
      `),
    ).toThrow()
    raw.exec(`INSERT INTO repo_group_nodes (group_id, path) VALUES ('group-empty', 'Docs')`)
    expect(() =>
      raw.exec(`INSERT INTO repo_group_nodes (group_id, path) VALUES ('group-empty', 'docs')`),
    ).toThrow()

    const tables = raw
      .query<{ name: string }, []>(
        `
        SELECT name FROM sqlite_master
        WHERE type='table' AND name IN ('repo_group_nodes', 'task_space_nodes')
        ORDER BY name
      `,
      )
      .all()
    expect(tables).toEqual([{ name: 'repo_group_nodes' }, { name: 'task_space_nodes' }])
  })
})
