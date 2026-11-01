// Authoring only: reconstruct missing release artifacts from tag sources in memory.
// No checkout, branch, worktree, live database, or test runner is involved.
import ts from 'typescript'
import { format, resolveConfig } from 'prettier'
import { build, type BunPlugin } from 'bun'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const dependency = createRequire(join(process.cwd(), 'packages/backend/package.json'))
import { collectSqliteHistoryCatalog } from '../../packages/backend/src/platform/persistence/schema/history/catalog'
import {
  applyFrozenSqliteMigrations,
  createFrozenSqliteJournal,
} from '../../packages/backend/src/platform/persistence/migration/epoch1/sqliteChain'

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const output = 'packages/backend/src/platform/persistence/migration/epoch1/released-postgresql'
const backend = 'packages/backend/src/'
const blob = (tag: string, path: string): Buffer =>
  execFileSync('git', ['show', `${tag}:${path}`], { maxBuffer: 32 * 1024 * 1024 })

for (const tag of ['v0.18.18', 'v0.18.19']) {
  const namespace = `release-${tag.replaceAll('.', '-')}`
  const resolver: BunPlugin = {
    name: namespace,
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${namespace}:`) }, ({ path }) => ({
        path: path.slice(namespace.length + 1),
        namespace,
      }))
      build.onLoad({ filter: /.*/, namespace }, ({ path }) => {
        let contents =
          path === '$shared'
            ? blob(tag, 'packages/shared/src/taskOperations.ts')
                .toString()
                .split('\n')
                .filter((line) =>
                  /^export const TASK_(LAUNCH_ORIGINS|CATALOG_VISIBILITIES) =/.test(line),
                )
                .join('\n')
            : blob(tag, path).toString()
        for (const reference of [...ts.preProcessFile(contents).importedFiles].reverse()) {
          const specifier = reference.fileName
          let resolved: string
          if (specifier.startsWith('@/'))
            resolved = `${namespace}:${backend}${specifier.slice(2)}.ts`
          else if (specifier.startsWith('.'))
            resolved = `${namespace}:${posix.normalize(posix.join(posix.dirname(path), specifier))}${specifier.endsWith('.ts') ? '' : '.ts'}`
          else if (specifier === '@agent-workflow/shared') resolved = `${namespace}:$shared`
          else if (specifier.startsWith('node:') || specifier === 'bun') resolved = specifier
          else resolved = dependency.resolve(specifier)
          const start =
            reference.pos +
            (contents[reference.pos] === '"' || contents[reference.pos] === "'" ? 1 : 0)
          contents = contents.slice(0, start) + resolved + contents.slice(start + specifier.length)
        }
        return { contents, loader: 'ts', resolveDir: process.cwd() }
      })
    },
  }
  const temporary = mkdtempSync('/tmp/rfc398-release-artifacts-')
  const entry = join(temporary, 'entry.ts')
  writeFileSync(
    entry,
    `export * as contractModule from '${namespace}:${backend}platform/persistence/schemaContract.ts'; export * as planModule from '${namespace}:${backend}platform/persistence/postgresqlSchema.ts'`,
  )
  const bundled = await build({ entrypoints: [entry], target: 'bun', plugins: [resolver] })
  if (!bundled.success)
    throw new AggregateError(
      bundled.logs,
      'Release artifact generator could not bundle tag sources',
    )
  const bundle = join(temporary, 'bundle.mjs')
  writeFileSync(bundle, await bundled.outputs[0]!.text())
  const { contractModule, planModule } = await import(bundle)
  rmSync(temporary, { recursive: true })
  const contract = contractModule.buildLogicalSchemaContract()
  const plan = planModule.buildPostgresqlSchemaPlan(contract)
  const sql = blob(tag, 'packages/backend/db/postgresql-migrations/0000_rfc349_baseline.sql')
  const journal = blob(tag, 'packages/backend/db/postgresql-migrations/meta/_journal.json')
  const recorded = JSON.parse(journal.toString())
  if (
    contract.digest !== recorded.contractDigest ||
    plan.digest !== recorded.planDigest ||
    planModule.renderPostgresqlBaselineSql(plan) !== sql.toString()
  )
    throw new Error(`${tag}: regenerated artifacts do not reproduce published identities/SQL`)
  const sqliteJournal = JSON.parse(
    blob(tag, 'packages/backend/db/migrations/meta/_journal.json').toString(),
  ) as { entries: { tag: string; when: number; idx: number; breakpoints: boolean }[] }
  const receipts = sqliteJournal.entries.map((entry) => {
    const bytes = blob(tag, `packages/backend/db/migrations/${entry.tag}.sql`)
    return {
      index: entry.idx,
      tag: entry.tag,
      folderMillis: entry.when,
      hash: hash(bytes),
      sql: bytes.toString().split('--> statement-breakpoint'),
      bps: entry.breakpoints,
    }
  })
  if (receipts.length !== 223) throw new Error(`${tag}: unexpected SQLite prefix`)
  const db = new Database(':memory:')
  createFrozenSqliteJournal(db)
  applyFrozenSqliteMigrations(db, receipts)
  const catalog = collectSqliteHistoryCatalog(db)
  db.close()
  const root = join(output, tag)
  const save = (name: string, value: string | Uint8Array) => {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), value)
  }
  save('0000_rfc349_baseline.sql', sql)
  save('meta/_journal.json', journal)
  save(
    'contract.json',
    await format(JSON.stringify(contract), {
      ...(await resolveConfig(join(root, 'contract.json'))),
      parser: 'json',
    }),
  )
  save('plan.json', JSON.stringify(plan, null, 2) + '\n')
  save('catalog.json', JSON.stringify(catalog, null, 2) + '\n')
  save(
    'sqlite-receipts.json',
    JSON.stringify(
      receipts.map(({ sql: _sql, bps: _bps, ...receipt }) => receipt),
      null,
      2,
    ) + '\n',
  )
  save(
    'provenance.json',
    JSON.stringify(
      {
        tag,
        commit: execFileSync('git', ['rev-parse', `${tag}^{commit}`])
          .toString()
          .trim(),
        sqlSha256: hash(sql),
        journalSha256: hash(journal),
        contractDigest: contract.digest,
        planDigest: plan.digest,
        sqliteThrough: 223,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    `${tag}: wrote original SQL/journal and regenerated contract, plan, SQLite catalog and receipts`,
  )
}
