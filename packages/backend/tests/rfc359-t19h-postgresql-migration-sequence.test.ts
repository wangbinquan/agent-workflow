// RFC-359 T19h — the immutable root, generated edges and completed receipts
// describe one exact history. These are pure artifact/sequence tests; actual
// PostgreSQL DDL, transaction rollback and boot resumption have separate coverage.

import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, relative, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { generatePostgresqlMigrationHistory } from '../scripts/rfc349-postgresql-schema'
import { extractFilesTo } from '@/embed'
import {
  loadPostgresqlMigrationHistory,
  POSTGRESQL_MIGRATION_ROOT_FILE,
  readPostgresqlMigrationHistoryPrefix,
} from '@/platform/persistence/postgresqlMigrationHistory'
import {
  assertPostgresqlMigrationHead,
  createPostgresqlIndexUpgrade,
  planPostgresqlUpgrade,
  postgresqlMigrationDigest,
  postgresqlMigrationSqlDigest,
  postgresqlSchemaIdentity,
  postgresqlSqliteMigrationIdentity,
  postgresqlUpgradeReceipt,
  renderPostgresqlUpgradeSql,
  replayPostgresqlMigrationHistory,
  resolvePostgresqlHistoricalContract,
  resolvePostgresqlIndexOnlyRowBridge,
  type PostgresqlIndexUpgrade,
  type PostgresqlMigrationHistory,
  type PostgresqlMigrationVersion,
} from '@/platform/persistence/postgresqlMigrationSequence'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import {
  digestSchemaContract,
  type LogicalIndexContract,
} from '@/platform/persistence/schemaContract'

const committedFolder = resolve(import.meta.dir, '..', 'db', 'postgresql-migrations')
const roots: string[] = []
let committed: PostgresqlMigrationHistory
let next: PostgresqlMigrationVersion
let second: PostgresqlIndexUpgrade
let extended: PostgresqlMigrationHistory

function temporaryHistory(): string {
  const folder = mkdtempSync(join(tmpdir(), 'rfc359-schema-history-'))
  roots.push(folder)
  cpSync(committedFolder, folder, { recursive: true })
  return folder
}

function addIndex(from: PostgresqlMigrationVersion, name: string): PostgresqlMigrationVersion {
  const index: LogicalIndexContract = {
    name,
    unique: false,
    columns: ['status', 'id'],
    where: null,
  }
  const { digest: _digest, ...body } = from.contract
  const payload = {
    ...body,
    tables: body.tables.map((table) =>
      table.id === 'tasks' ? { ...table, indexes: [...table.indexes, index] } : table,
    ),
  }
  const contract = { ...payload, digest: digestSchemaContract(payload) }
  const sqliteMigrations = [
    ...from.sqliteMigrations,
    {
      index: from.sqliteMigrations.length,
      folderMillis: from.sqliteMigration.last.folderMillis + 1,
      hash: createHash('sha256')
        .update(`CREATE INDEX "${name}" ON tasks(status, id);\n`)
        .digest('hex'),
      tag: `fixture_${name}`,
    },
  ]
  return {
    contract,
    plan: buildPostgresqlSchemaPlan(contract),
    sqliteMigrations,
    sqliteMigration: postgresqlSqliteMigrationIdentity(sqliteMigrations),
  }
}

function rehash(step: PostgresqlIndexUpgrade): PostgresqlIndexUpgrade {
  const { digest: _digest, ...payload } = step
  return { ...payload, digest: postgresqlMigrationDigest(payload) }
}

beforeAll(async () => {
  committed = await loadPostgresqlMigrationHistory()
  next = addIndex(committed.head, 'idx_rfc359_history_fixture')
  const sequence = committed.steps.length + 1
  second = createPostgresqlIndexUpgrade({
    from: committed.head,
    to: next,
    sequence,
    id: `${String(sequence).padStart(4, '0')}_rfc359_history_fixture`,
    previousEntryDigest:
      committed.steps.at(-1)?.digest ?? postgresqlMigrationDigest(committed.root),
  })
  extended = replayPostgresqlMigrationHistory(committed.root, [...committed.steps, second])
})

afterEach(() => {
  for (const folder of roots.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('RFC-359 T19h exact immutable PostgreSQL history', () => {
  test('keeps the published baseline bytes and complete original contract', () => {
    expect(
      postgresqlMigrationSqlDigest(
        readFileSync(join(committedFolder, '0000_rfc349_baseline.sql'), 'utf8'),
      ),
    ).toBe('sha256:b7aa48630c67c846b448ad5df315351f5609e0ce08e37b478a8130e362a4f39b')
    expect(
      postgresqlMigrationSqlDigest(
        readFileSync(join(committedFolder, 'meta', '_journal.json'), 'utf8'),
      ),
    ).toBe('sha256:ac39e8c9b1f37c8f94d95d2bfc9bb085792f0d0b8e2fe7a62b2505a653bd7821')
    expect(committed.root.contract.digest).toBe(
      'sha256:9aabfa484e39f2fa45bfbd7e67a0cffe0b92ead58ebdfa69e14855ec80036b4e',
    )
    expect(committed.root.plan.digest).toBe(
      'sha256:35a4a5ce169d9988a9487cd2dd4c71cd45fb7b5ac3aaa618ca31e87e88dbebd4',
    )
    expect(resolvePostgresqlHistoricalContract(committed, committed.root.contract.digest)).toEqual(
      committed.root.contract,
    )
    expect(committed.root.sqliteMigration).toEqual(
      postgresqlSqliteMigrationIdentity(committed.root.sqliteMigrations),
    )
    expect(committed.root.sqliteMigration.count).toBe(224)
    expect(committed.root.sqliteMigration.last.tag).toBe('0224_rfc359_node_run_lineage_explicit')
  })

  test('replays multiple edges to the complete current projection and exact SQLite prefix', () => {
    expect(extended.head).toEqual(next)
    expect(() => assertPostgresqlMigrationHead(extended, next.contract, next.plan)).not.toThrow()
    expect<typeof committed.root.sqliteMigrations>(
      extended.head.sqliteMigrations.slice(0, committed.root.sqliteMigrations.length),
    ).toEqual(committed.root.sqliteMigrations)
    expect(second.sqliteMigration.to).toEqual(next.sqliteMigration)
    expect(second.executableStatements.at(-1)?.logicalId).toBe('advance-contract-row')
    expect(second.executableStatements.at(-1)?.sql).toContain(
      `WHERE singleton = TRUE AND contract_digest = '${committed.head.contract.digest}' RETURNING contract_digest`,
    )
    expect(second.executableStatements.filter((statement) => statement.kind === 'table')).toEqual(
      [],
    )
  })

  test('one combined index edge and the full ordered chain reach the same whole plan', () => {
    const combined = createPostgresqlIndexUpgrade({
      from: committed.versions[0]!,
      to: next,
      id: '0001_combined_fixture',
      sequence: 1,
      previousEntryDigest: postgresqlMigrationDigest(committed.root),
    })
    expect(replayPostgresqlMigrationHistory(committed.root, [combined]).head).toEqual(extended.head)
  })

  test('selects only pending edges and does no DDL for completed or fresh current installations', () => {
    const baseline = postgresqlSchemaIdentity(committed.root.plan)
    expect(planPostgresqlUpgrade(extended, { baseline, current: baseline, completed: [] })).toEqual(
      extended.steps,
    )
    expect(
      planPostgresqlUpgrade(extended, {
        baseline,
        current: postgresqlSchemaIdentity(committed.head.plan),
        completed: committed.steps.map(postgresqlUpgradeReceipt),
      }),
    ).toEqual([second])
    expect(
      planPostgresqlUpgrade(extended, {
        baseline,
        current: postgresqlSchemaIdentity(next.plan),
        completed: extended.steps.map(postgresqlUpgradeReceipt).reverse(),
      }),
    ).toEqual([])
    expect(
      planPostgresqlUpgrade(extended, {
        baseline: postgresqlSchemaIdentity(next.plan),
        current: postgresqlSchemaIdentity(next.plan),
        completed: [],
      }),
    ).toEqual([])
  })

  test('distinguishes a later fresh baseline from a missing earlier upgrade receipt', () => {
    const baseline = postgresqlSchemaIdentity(committed.head.plan)
    expect(planPostgresqlUpgrade(extended, { baseline, current: baseline, completed: [] })).toEqual(
      [second],
    )
    expect(
      planPostgresqlUpgrade(extended, {
        baseline,
        current: postgresqlSchemaIdentity(next.plan),
        completed: [postgresqlUpgradeReceipt(second)],
      }),
    ).toEqual([])
    expect(() =>
      planPostgresqlUpgrade(extended, {
        baseline: postgresqlSchemaIdentity(committed.root.plan),
        current: postgresqlSchemaIdentity(next.plan),
        completed: [postgresqlUpgradeReceipt(second)],
      }),
    ).toThrow('gap or different ID/digest')
  })

  test('rejects unknown pairs, duplicate receipts and metadata ahead of its durable history', () => {
    const baseline = postgresqlSchemaIdentity(committed.root.plan)
    for (const key of ['contractDigest', 'planDigest'] as const) {
      expect(() =>
        planPostgresqlUpgrade(extended, {
          baseline: { ...baseline, [key]: `sha256:${'1'.repeat(64)}` },
          current: baseline,
          completed: [],
        }),
      ).toThrow('unsupported PostgreSQL baseline contract/plan pair')
    }
    const firstReceipt = postgresqlUpgradeReceipt(extended.steps[0]!)
    expect(() =>
      planPostgresqlUpgrade(extended, {
        baseline,
        current: postgresqlSchemaIdentity(next.plan),
        completed: [firstReceipt, firstReceipt],
      }),
    ).toThrow('duplicate PostgreSQL upgrade receipt')
    expect(() =>
      planPostgresqlUpgrade(extended, {
        baseline,
        current: postgresqlSchemaIdentity(next.plan),
        completed: committed.steps.map(postgresqlUpgradeReceipt),
      }),
    ).toThrow('metadata and completed upgrade receipts disagree')
    expect(() =>
      planPostgresqlUpgrade(extended, {
        baseline,
        current: postgresqlSchemaIdentity(extended.versions[1]!.plan),
        completed: [{ ...firstReceipt, baselineId: `${firstReceipt.baselineId}changed` }],
      }),
    ).toThrow('gap or different ID/digest')
  })

  test('rejects reordered or missing history edges and changed executable SQL even after rehashing', () => {
    expect(() =>
      replayPostgresqlMigrationHistory(committed.root, [...extended.steps].reverse()),
    ).toThrow('sequence or ID differs')
    expect(() => replayPostgresqlMigrationHistory(committed.root, [second])).toThrow(
      'sequence or ID differs',
    )
    const first = extended.steps[0]!
    const executableStatements = first.executableStatements.map((statement, index) =>
      index === 0 ? { ...statement, sql: `${statement.sql} ` } : statement,
    )
    const changed = rehash({
      ...first,
      executableStatements,
      sqlDigest: postgresqlMigrationSqlDigest(renderPostgresqlUpgradeSql({ executableStatements })),
    })
    expect(() => replayPostgresqlMigrationHistory(committed.root, [changed])).toThrow(
      'upgrade executable SQL differs',
    )
    expect(() =>
      replayPostgresqlMigrationHistory(committed.root, [
        rehash({
          ...first,
          indexAdditions: first.indexAdditions.map((addition, index) =>
            index === 0 ? { ...addition, position: 0 } : addition,
          ),
        }),
      ]),
    ).toThrow('upgrade target plan digest differs')
  })

  test('requires appended SQLite identities and preserves their whole old prefix', () => {
    const first = extended.steps[0]!
    expect(() =>
      replayPostgresqlMigrationHistory(committed.root, [
        rehash({ ...first, sqliteMigration: { ...first.sqliteMigration, appended: [] } }),
      ]),
    ).toThrow('SQLite prefix did not advance')
    expect(() =>
      replayPostgresqlMigrationHistory(committed.root, [
        rehash({
          ...first,
          sqliteMigration: {
            ...first.sqliteMigration,
            appended: first.sqliteMigration.appended.map((item) => ({
              ...item,
              index: item.index + 1,
            })),
          },
        }),
      ]),
    ).toThrow('SQLite migration identity differs')
    const from = committed.head
    expect(() =>
      createPostgresqlIndexUpgrade({
        from,
        to: {
          ...next,
          sqliteMigrations: from.sqliteMigrations,
          sqliteMigration: from.sqliteMigration,
        },
        id: second.id,
        sequence: second.sequence,
        previousEntryDigest: second.previousEntryDigest,
      }),
    ).toThrow('requires an appended SQLite migration')
  })

  test('does not reinterpret changed existing writes, rows or removed indexes as additive DDL', () => {
    const changedStatements = next.plan.statements.map((statement) =>
      statement.kind === 'table' && statement.logicalId === 'tasks'
        ? { ...statement, sql: `${statement.sql} ` }
        : statement,
    )
    const { digest: _digest, ...body } = next.plan
    const changedPlanBody = { ...body, statements: changedStatements }
    expect(() =>
      createPostgresqlIndexUpgrade({
        from: committed.head,
        to: {
          ...next,
          plan: { ...changedPlanBody, digest: postgresqlMigrationDigest(changedPlanBody) },
        },
        id: second.id,
        sequence: second.sequence,
        previousEntryDigest: second.previousEntryDigest,
      }),
    ).toThrow('changed an existing statement')
    const { digest: _contractDigest, ...contractBody } = next.contract
    const removedBody = {
      ...contractBody,
      tables: contractBody.tables.map((table) =>
        table.id === 'tasks'
          ? {
              ...table,
              indexes: table.indexes.filter((index) => index.name !== 'idx_tasks_status_finished'),
            }
          : table,
      ),
    }
    const removedContract = { ...removedBody, digest: digestSchemaContract(removedBody) }
    expect(() =>
      createPostgresqlIndexUpgrade({
        from: committed.head,
        to: {
          ...next,
          contract: removedContract,
          plan: buildPostgresqlSchemaPlan(removedContract),
        },
        id: second.id,
        sequence: second.sequence,
        previousEntryDigest: second.previousEntryDigest,
      }),
    ).toThrow('old indexes changed, moved or were removed')
  })

  test('bridges old archive rows only across verified index-only contracts', () => {
    const bridge = resolvePostgresqlIndexOnlyRowBridge(extended, {
      fromContractDigest: committed.root.contract.digest,
      toContractDigest: next.contract.digest,
    })
    expect(bridge.source).toEqual(committed.root.contract)
    expect(bridge.target).toEqual(next.contract)
    expect(bridge.steps).toEqual(extended.steps)
    expect(
      bridge.source.tables.filter((table) => table.disposition === 'ARCHIVE_THEN_OMIT'),
    ).toEqual(bridge.target.tables.filter((table) => table.disposition === 'ARCHIVE_THEN_OMIT'))
    expect(() => resolvePostgresqlHistoricalContract(extended, `sha256:${'2'.repeat(64)}`)).toThrow(
      'unsupported historical logical schema contract',
    )
    expect(() =>
      resolvePostgresqlIndexOnlyRowBridge(extended, {
        fromContractDigest: next.contract.digest,
        toContractDigest: committed.root.contract.digest,
      }),
    ).toThrow('unsupported historical index-only row bridge')
  })

  test('generates immutable artifacts, repeats without writes and loads their exact whole head', async () => {
    const folder = temporaryHistory()
    const oldBytes = new Map(
      [
        join(folder, '0000_rfc349_baseline.sql'),
        join(folder, 'meta', '_journal.json'),
        join(folder, 'meta', POSTGRESQL_MIGRATION_ROOT_FILE),
      ].map((path) => [path, readFileSync(path, 'utf8')]),
    )
    const first = await generatePostgresqlMigrationHistory({
      migrationsFolder: folder,
      contract: next.contract,
      sqliteMigrations: next.sqliteMigrations,
      appendId: second.id,
    })
    expect(first.created).toHaveLength(2)
    expect(
      (
        await loadPostgresqlMigrationHistory({
          migrationsFolder: folder,
          contract: next.contract,
          plan: next.plan,
        })
      ).head,
    ).toEqual(next)
    expect(
      await generatePostgresqlMigrationHistory({
        migrationsFolder: folder,
        contract: next.contract,
        sqliteMigrations: next.sqliteMigrations,
        appendId: second.id,
      }),
    ).toEqual({ created: [], planDigest: next.plan.digest })
    for (const [path, bytes] of oldBytes) expect(readFileSync(path, 'utf8')).toBe(bytes)
    const altered = addIndex(next, 'idx_rfc359_same_id_cannot_change')
    await expect(
      generatePostgresqlMigrationHistory({
        migrationsFolder: folder,
        contract: altered.contract,
        sqliteMigrations: altered.sqliteMigrations,
        appendId: second.id,
      }),
    ).rejects.toThrow('immutable PostgreSQL migration artifact differs')
    expect(readFileSync(join(folder, second.sqlFile), 'utf8')).toBe(
      renderPostgresqlUpgradeSql(second),
    )
  })

  test('does not verify an unchanged logical head against an unknown SQLite migration prefix', async () => {
    const folder = temporaryHistory()
    await expect(
      generatePostgresqlMigrationHistory({
        migrationsFolder: folder,
        contract: committed.head.contract,
        sqliteMigrations: next.sqliteMigrations,
      }),
    ).rejects.toThrow('history head differs from the complete current SQLite migration prefix')
    expect((await readPostgresqlMigrationHistoryPrefix({ migrationsFolder: folder })).head).toEqual(
      committed.head,
    )
  })

  test('rejects an interrupted SQL-only append and lets the same explicit generator complete it', async () => {
    const folder = temporaryHistory()
    writeFileSync(join(folder, second.sqlFile), renderPostgresqlUpgradeSql(second))
    await expect(
      readPostgresqlMigrationHistoryPrefix({ migrationsFolder: folder }),
    ).rejects.toMatchObject({ code: 'postgresql-migration-history-drift' })
    const result = await generatePostgresqlMigrationHistory({
      migrationsFolder: folder,
      contract: next.contract,
      sqliteMigrations: next.sqliteMigrations,
      appendId: second.id,
    })
    expect(result.created).toEqual([join(folder, 'meta', `${second.id}.upgrade.json`)])
    expect(
      (
        await loadPostgresqlMigrationHistory({
          migrationsFolder: folder,
          contract: next.contract,
          plan: next.plan,
        })
      ).head,
    ).toEqual(next)
  })

  test('classifies malformed root and changed SQL without accepting an unknown current head', async () => {
    const malformed = temporaryHistory()
    writeFileSync(join(malformed, 'meta', POSTGRESQL_MIGRATION_ROOT_FILE), '{bad')
    await expect(
      readPostgresqlMigrationHistoryPrefix({ migrationsFolder: malformed }),
    ).rejects.toMatchObject({ code: 'postgresql-migration-history-invalid' })
    const changed = temporaryHistory()
    const first = committed.steps[0]!
    writeFileSync(join(changed, first.sqlFile), `${renderPostgresqlUpgradeSql(first)}-- changed\n`)
    await expect(
      readPostgresqlMigrationHistoryPrefix({ migrationsFolder: changed }),
    ).rejects.toMatchObject({ code: 'postgresql-migration-history-drift' })
    await expect(
      loadPostgresqlMigrationHistory({
        migrationsFolder: committedFolder,
        contract: next.contract,
        plan: next.plan,
      }),
    ).rejects.toMatchObject({ code: 'postgresql-migration-history-drift' })
  })

  test('the actual binary collector and extractor include the frozen root and every appended SQL/JSON', async () => {
    const script = resolve(import.meta.dir, '..', '..', '..', 'scripts', 'build-binary.ts')
    const source = readFileSync(script, 'utf8')
    const parsed = ts.createSourceFile(
      script,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const functions = parsed.statements
      .filter(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) &&
          ['walkFiles', 'fileBundleDigest'].includes(statement.name?.text ?? ''),
      )
      .map((statement) => statement.getText(parsed))
    expect(functions).toHaveLength(2)
    const js = ts.transpileModule(functions.join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
    const globals = {
      root: committedFolder,
      existsSync,
      readdirSync,
      statSync,
      join,
      relative,
      posix,
      createHash,
      readFileSync,
    }
    const collected: unknown = runInNewContext(`${js}; walkFiles(root)`, globals)
    if (
      !Array.isArray(collected) ||
      !collected.every((path): path is string => typeof path === 'string')
    )
      throw new Error('binary collector returned an invalid file list')
    const bundleDigest: unknown = runInNewContext(
      `${js}; fileBundleDigest(root, walkFiles(root))`,
      globals,
    )
    expect(bundleDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    const files = Object.fromEntries(
      collected.map((path) => [relative(committedFolder, path), path]),
    )
    expect(Object.keys(files)).toContain(join('meta', POSTGRESQL_MIGRATION_ROOT_FILE))
    for (const step of committed.steps) {
      expect(Object.keys(files)).toContain(step.sqlFile)
      expect(Object.keys(files)).toContain(join('meta', `${step.id}.upgrade.json`))
    }
    const extracted = mkdtempSync(join(tmpdir(), 'rfc359-history-extracted-'))
    roots.push(extracted)
    expect(await extractFilesTo(extracted, files)).toBe(collected.length)
    for (const [path, original] of Object.entries(files))
      expect(readFileSync(join(extracted, path), 'utf8')).toBe(readFileSync(original, 'utf8'))
    expect((await loadPostgresqlMigrationHistory({ migrationsFolder: extracted })).head).toEqual(
      committed.head,
    )
  })
})
