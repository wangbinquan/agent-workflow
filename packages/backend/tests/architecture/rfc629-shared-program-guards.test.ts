// RFC-629: shared TypeScript program guards.
//
// Consolidates 6 live-corpus type-checked / multi-package AST guards onto 2 TypeScript programs:
//   1. One pure-.ts `backend + shared` ts.Program (packages/backend/tsconfig.json) serving:
//      - RFC-359 W5-T18 bare `db.transaction(`
//      - RFC-359 W5 unattended `void <promise>`
//      - RFC-395 I-b neutral query boundary
//      - Scheduler audit S-10 & RFC-317 T37 decorative async / raw SQLite transactions
//      - RFC-374 NodeRun mint order guard (backend + shared, full R1-R4 with real TypeChecker)
//   2. One dedicated `frontend` ts.Program (packages/frontend/tsconfig.json) serving:
//      - RFC-374 NodeRun mint order guard (frontend, full R1-R4 with real TypeChecker)
//   3. RFC-395 D4 mint order boundary reuses the already-parsed SourceFiles from both programs.
//
// Each original guard file retains its isolated negative fixtures, unit tests and behavior proofs.
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { sourceUnit } from './census'
import {
  BARE_TRANSACTION_DEBT,
  EXPECTED_ASYNC_TX_SITES,
  MINT_ORDER_EXCEPTIONS,
  MINT_ORDER_MIGRATION_PREFIX,
  NODE_RUN_ORDER_EXCEPTIONS,
  RAW_TRANSACTION_SITES,
  TRANSACTION_PRIMITIVES,
  UNATTENDED_VOID_PROMISE_DEBT,
  checkNodeRunOrderExceptions,
  countBareTransactions,
  countNonCommentMatches,
  countUnattendedVoidPromises,
  detectNodeRunIdOrder,
  isNeutralQueryWiringPath,
  mintOrderHits,
  nodeRunOrderVirtualProgram,
  sqliteQueryFindings,
  sqliteTransactionSource,
  withoutConversionTargetTransactions,
  withoutNeutralSessionTransactions,
} from '../helpers/rfc629SharedProgramRules'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const BACKEND_ROOT = resolve(REPO_ROOT, 'packages/backend')
const BACKEND_SRC = join(BACKEND_ROOT, 'src')
const SHARED_SRC = resolve(REPO_ROOT, 'packages/shared/src')
const FRONTEND_ROOT = resolve(REPO_ROOT, 'packages/frontend')
const FRONTEND_SRC = join(FRONTEND_ROOT, 'src')

const slash = (path: string) => path.replaceAll('\\', '/')

function walkSources(dir: string, pattern: RegExp): string[] {
  const out: string[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && pattern.test(entry.name)) out.push(full)
    }
  }
  visit(dir)
  return out.sort()
}

function readCompilerOptions(pkgRoot: string): ts.CompilerOptions {
  const configPath = resolve(pkgRoot, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  return ts.parseJsonConfigFileContent(config.config, ts.sys, pkgRoot).options
}

const BACKEND_FILES = walkSources(BACKEND_SRC, /\.ts$/)
const SHARED_FILES = walkSources(SHARED_SRC, /\.[cm]?tsx?$/)
const FRONTEND_FILES = walkSources(FRONTEND_SRC, /\.[cm]?tsx?$/)

interface LoadedPrograms {
  readonly backendSharedProgram: ts.Program
  readonly backendChecker: ts.TypeChecker
  readonly frontendProgram: ts.Program
  readonly frontendChecker: ts.TypeChecker
}

let loaded: LoadedPrograms | undefined

function requireLoaded(): LoadedPrograms {
  if (loaded === undefined) throw new Error('RFC-629 shared programs not initialized')
  return loaded
}

describe('RFC-629 shared TypeScript program guards', () => {
  beforeAll(() => {
    const backendSharedProgram = ts.createProgram(
      [...BACKEND_FILES, ...SHARED_FILES],
      readCompilerOptions(BACKEND_ROOT),
    )
    const frontendProgram = ts.createProgram(FRONTEND_FILES, readCompilerOptions(FRONTEND_ROOT))
    loaded = {
      backendSharedProgram,
      backendChecker: backendSharedProgram.getTypeChecker(),
      frontendProgram,
      frontendChecker: frontendProgram.getTypeChecker(),
    }
  }, 120_000)

  test('corpus floors: backend, shared and frontend source trees are non-empty', () => {
    expect(BACKEND_FILES.length).toBeGreaterThanOrEqual(1500)
    expect(
      BACKEND_FILES.length + SHARED_FILES.length + FRONTEND_FILES.length,
    ).toBeGreaterThanOrEqual(3000)
  })

  test('RFC-359 W5-T18: bare `db.transaction(` matches exact empty ledger and active primitives', () => {
    const { backendSharedProgram, backendChecker } = requireLoaded()
    const counts = new Map<string, number>()
    const offenders: string[] = []
    for (const file of BACKEND_FILES) {
      const rel = slash(relative(BACKEND_SRC, file))
      const source = backendSharedProgram.getSourceFile(file)
      if (source === undefined) throw new Error(`RFC-359 transaction corpus missing ${rel}`)
      const count = countBareTransactions(source, backendChecker)
      counts.set(rel, count)
      if (rel in TRANSACTION_PRIMITIVES) continue
      if (count > 0) offenders.push(`${rel}: ${count}`)
    }
    expect(offenders.sort()).toEqual([...BARE_TRANSACTION_DEBT])
    for (const [rel, why] of Object.entries(TRANSACTION_PRIMITIVES)) {
      expect(rel).toMatch(/\.ts$/)
      expect(existsSync(join(BACKEND_SRC, rel))).toBe(true)
      expect(counts.get(rel) ?? 0).toBeGreaterThan(0)
      expect(why.length).toBeGreaterThan(60)
    }
  }, 30_000)

  test('RFC-359 W5: unattended `void <promise>` matches exact high-water ledger', () => {
    const { backendSharedProgram, backendChecker } = requireLoaded()
    const offenders: string[] = []
    for (const file of BACKEND_FILES) {
      const rel = slash(relative(BACKEND_SRC, file))
      const source = backendSharedProgram.getSourceFile(file)
      if (source === undefined) throw new Error(`RFC-359 void-promise corpus missing ${rel}`)
      const count = countUnattendedVoidPromises(source, backendChecker)
      if (count > 0) offenders.push(`${rel}: ${count}`)
    }
    expect(offenders.sort()).toEqual([...UNATTENDED_VOID_PROMISE_DEBT])
  }, 30_000)

  test('RFC-395 I-b: no business query uses a dialect terminal or database-level raw execution', () => {
    const { backendSharedProgram, backendChecker } = requireLoaded()
    const findings = BACKEND_FILES.flatMap((file) => {
      const rel = slash(relative(BACKEND_SRC, file))
      if (isNeutralQueryWiringPath(rel)) return []
      const source = backendSharedProgram.getSourceFile(file)
      if (source === undefined) throw new Error(`RFC-395 neutral-query corpus missing ${rel}`)
      return sqliteQueryFindings(source, backendChecker).map((finding) => `${rel}: ${finding}`)
    })
    expect(findings).toEqual([])
  }, 30_000)

  test('S-10 & RFC-317 T37: zero decorative async or raw SQLite transactions outside db/txSync.ts', () => {
    const { backendSharedProgram, backendChecker } = requireLoaded()
    const asyncActual: Record<string, number> = {}
    const rawActual: Record<string, number> = {}
    for (const file of BACKEND_FILES) {
      const rel = slash(relative(BACKEND_SRC, file))
      const source = backendSharedProgram.getSourceFile(file)
      if (source === undefined) throw new Error(`S-10 transaction source missing: ${file}`)
      const sqliteSource = sqliteTransactionSource(rel, source.text)
      if (sqliteSource === null) continue
      const filtered = /\.transaction\s*\(/.test(sqliteSource)
        ? withoutNeutralSessionTransactions(
            withoutConversionTargetTransactions(source, backendChecker, BACKEND_SRC, sqliteSource),
          )
        : sqliteSource
      const asyncCount = countNonCommentMatches(filtered, /\.transaction\s*\(\s*async\b/g)
      if (asyncCount > 0) asyncActual[rel] = asyncCount
      if (rel !== 'db/txSync.ts') {
        const rawCount = countNonCommentMatches(filtered, /\.transaction\s*\(/g)
        if (rawCount > 0) rawActual[rel] = rawCount
      }
    }
    expect(asyncActual).toEqual(EXPECTED_ASYNC_TX_SITES)
    expect(rawActual).toEqual(
      Object.fromEntries(
        Object.entries(RAW_TRANSACTION_SITES).map(([file, site]) => [file, site.count]),
      ),
    )
  }, 30_000)

  test('RFC-374: NodeRun mint order R1-R4 across backend, shared and frontend matches exact exception ledger', () => {
    const { backendSharedProgram, backendChecker, frontendProgram, frontendChecker } =
      requireLoaded()
    const hits = [
      ...[...BACKEND_FILES, ...SHARED_FILES].flatMap((file) => {
        const source = backendSharedProgram.getSourceFile(file)
        if (source === undefined) throw new Error(`RFC-374 backend/shared corpus missing ${file}`)
        const rel = slash(relative(REPO_ROOT, file))
        return detectNodeRunIdOrder(source, backendChecker).map((hit) => ({ ...hit, file: rel }))
      }),
      ...FRONTEND_FILES.flatMap((file) => {
        const source = frontendProgram.getSourceFile(file)
        if (source === undefined) throw new Error(`RFC-374 frontend corpus missing ${file}`)
        const rel = slash(relative(REPO_ROOT, file))
        return detectNodeRunIdOrder(source, frontendChecker).map((hit) => ({ ...hit, file: rel }))
      }),
    ]
    expect(checkNodeRunOrderExceptions(hits, NODE_RUN_ORDER_EXCEPTIONS)).toEqual([])
    const [firstExceptionFile] = Object.keys(NODE_RUN_ORDER_EXCEPTIONS)
    const removed = { ...NODE_RUN_ORDER_EXCEPTIONS }
    delete removed[firstExceptionFile!]
    expect(
      checkNodeRunOrderExceptions(hits, removed).some((error) => error.startsWith('unregistered:')),
    ).toBe(true)
    expect(
      checkNodeRunOrderExceptions(hits, {
        ...NODE_RUN_ORDER_EXCEPTIONS,
        'never.ts': { count: 1, reason: 'stale negative fixture' },
      }).some((error) => error.startsWith('stale:')),
    ).toBe(true)
  }, 30_000)

  test('RFC-395 D4: backend, shared and frontend sources keep no epoch-1 mint order outside the oracle', () => {
    const { backendSharedProgram, frontendProgram } = requireLoaded()
    const units = [
      ...[...BACKEND_FILES, ...SHARED_FILES]
        .map((file) => ({
          path: slash(relative(REPO_ROOT, file)),
          source: backendSharedProgram.getSourceFile(file)!,
        }))
        .filter((unit) => !unit.path.startsWith(MINT_ORDER_MIGRATION_PREFIX)),
      ...FRONTEND_FILES.map((file) => ({
        path: slash(relative(REPO_ROOT, file)),
        source: frontendProgram.getSourceFile(file)!,
      })),
    ]
    const hits = units.flatMap(mintOrderHits)
    const unexplained = hits.filter(
      (hit) => !MINT_ORDER_EXCEPTIONS.has(hit.slice(hit.indexOf(':') + 1)),
    )
    expect(unexplained).toEqual([])
    const matched = new Set(hits.map((hit) => hit.slice(hit.indexOf(':') + 1)))
    expect([...MINT_ORDER_EXCEPTIONS.keys()].filter((key) => !matched.has(key))).toEqual([])
  }, 30_000)
})

describe('RFC-629 shared program guard negative fixtures', () => {
  test('forged violations bite across all six shared rules', () => {
    const bareProgram = nodeRunOrderVirtualProgram({
      '/probe.ts':
        'interface Promise<T> { then(): void }\n' +
        'interface Db { select(): Query; insert(): void; update(): void; delete(): void; transaction(fn: () => void): void; all(): void; run(): void }\n' +
        'interface Query { then(): void; getSQL(): void; get(): void }\n' +
        'declare const db: Db;\n' +
        'declare function asyncWork(): Promise<number>;\n' +
        'db.transaction(() => {});\n' +
        'void asyncWork();\n' +
        'db.select().get();\n',
    })
    const probeSource = bareProgram.getSourceFile('/probe.ts')!
    const probeChecker = bareProgram.getTypeChecker()
    expect(countBareTransactions(probeSource, probeChecker)).toBe(1)
    expect(countUnattendedVoidPromises(probeSource, probeChecker)).toBe(1)
    expect(sqliteQueryFindings(probeSource, probeChecker)).toEqual(['SQLite query .get'])
    expect(
      countNonCommentMatches(
        'db.transaction(async (tx) => { await tx.select() })',
        /\.transaction\s*\(\s*async\b/g,
      ),
    ).toBe(1)

    const orderProgram = nodeRunOrderVirtualProgram({
      '/order.ts': 'declare const runId: string; runId > "other"; runId.localeCompare("other")',
    })
    expect(
      detectNodeRunIdOrder(
        orderProgram.getSourceFile('/order.ts')!,
        orderProgram.getTypeChecker(),
      ).map((hit) => hit.rule),
    ).toEqual(['R3', 'R4'])

    expect(
      mintOrderHits(
        sourceUnit('packages/frontend/src/probe.tsx', 'if (row.seq === null) return'),
      ).map((hit) => hit.slice(0, hit.indexOf(':'))),
    ).toEqual(['seq-null-check'])
  })
})
