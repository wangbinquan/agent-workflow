import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderGenerated } from '../../../scripts/build-binary'
import { persistenceHead, persistencePostgresqlMajors } from '@/bootstrap/persistenceHead'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')

describe('binary build virtual embed isolation', () => {
  test('injects embed.generated.ts in memory without mutating the watched dev source', () => {
    const source = readFileSync(resolve(repoRoot, 'scripts', 'build-binary.ts'), 'utf8')

    expect(source).toContain('files: { [generatedPath]: input.generatedContents }')
    expect(source).toContain(
      'const managedProcessLauncherSource = await buildManagedProcessLauncherSource()',
    )
    expect(source).toContain(
      'const gitCredentialHelperSource = await buildGitCredentialHelperSource()',
    )
    expect(source).toContain(
      'const generated = renderGenerated(managedProcessLauncherSource, gitCredentialHelperSource)',
    )
    expect(source).toContain("'postgresql-migrations'")
    expect(source).toContain('POSTGRESQL_MIGRATION_FILES')
    expect(source).toContain('SCHEMA_HISTORY_FILES')
    expect(source).toContain('POSTGRESQL_MIGRATION_BUNDLE_DIGEST')
    expect(source).not.toMatch(/writeFileSync\s*\(\s*generatedPath/)
  })
})

// RFC-395 A-3: compile a small consumer with the production asset map. Running it
// outside the checkout proves neither frozen history nor the live head needs disk fallbacks.
test('standalone bundle contains both frozen histories and the epoch-2 embedded head', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'a3-binary-history-'))
  try {
    const generated = renderGenerated('', '')
    expect(generated.counts.migrationCount).toBeGreaterThan(0)
    expect(generated.counts.postgresqlMigrationCount).toBeGreaterThan(0)
    expect(generated.counts.schemaHistoryCount).toBeGreaterThanOrEqual(4)
    const backend = join(repoRoot, 'packages/backend/src')
    const entry = join(directory, 'history.ts')
    writeFileSync(
      entry,
      `
      import { readFileSync } from 'node:fs'
      import { persistenceHead, persistencePostgresqlMajors } from ${JSON.stringify(join(backend, 'bootstrap/persistenceHead.ts'))}
      import { MIGRATION_FILES, POSTGRESQL_MIGRATION_FILES, SCHEMA_HISTORY_FILES, IS_EMBEDDED } from ${JSON.stringify(join(backend, 'embed.generated.ts'))}
      const count = (files) => Object.values(files).map((path) => readFileSync(path)).length
      console.log(JSON.stringify({ embedded: IS_EMBEDDED, digest: persistenceHead().contract.contract.digest,
        majors: persistencePostgresqlMajors(), sqlite: count(MIGRATION_FILES), postgresql: count(POSTGRESQL_MIGRATION_FILES), history: count(SCHEMA_HISTORY_FILES) }))
    `,
    )
    const outfile = join(directory, process.platform === 'win32' ? 'history.exe' : 'history')
    const build = await Bun.build({
      entrypoints: [entry],
      target: 'bun',
      compile: { outfile },
      files: { [join(backend, 'embed.generated.ts')]: generated.contents },
    })
    expect(build.logs.filter((log) => log.level === 'error')).toEqual([])
    expect(build.success).toBe(true)
    const child = Bun.spawn([outfile], { cwd: directory, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      embedded: true,
      digest: persistenceHead().contract.contract.digest,
      majors: persistencePostgresqlMajors(),
      sqlite: generated.counts.migrationCount,
      postgresql: generated.counts.postgresqlMigrationCount,
      history: generated.counts.schemaHistoryCount,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 120_000)
