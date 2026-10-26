// BF-D17: exercise the real process-level boot/migrate refusal, not only its error code.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { prepareEpoch2DatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { readGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { removeTempDirSync } from './fixtures/tempDir'

for (const kind of ['receipt-mismatch', 'physical-drift'] as const)
  test(`BF-D17 start and migrate name ${kind}, the live database and recovery options`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'bf-drift-'))
    const pointerPath = join(home, 'database-generation.json')
    try {
      const prepared = await prepareEpoch2DatabaseProviderRuntime({
        config: { provider: 'sqlite' },
        contract: logicalSchemaContract,
        sqlitePath: join(home, 'db.sqlite'),
        generationPointerPath: pointerPath,
        operationsRoot: join(home, 'database-migrations'),
        sqliteOptions: {},
      })
      await prepared.runtime.close()
      const pointer = readGenerationPointerV2(pointerPath)
      if (pointer.payload.database.kind !== 'sqlite-file')
        throw new Error('SQLite fixture required')
      const path = join(home, pointer.payload.database.relativePath)
      const db = new Database(path)
      db.exec(
        kind === 'receipt-mismatch'
          ? `UPDATE aw_meta_schema_history SET contract_digest='sha256:${'0'.repeat(64)}'`
          : 'CREATE TABLE bf_drift_probe (unexpected TEXT)',
      )
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      db.close()
      const before = readFileSync(pointerPath)
      for (const command of ['start', 'migrate']) {
        const child = Bun.spawn(
          [process.execPath, resolve(import.meta.dir, '../src/main.ts'), command],
          {
            cwd: resolve(import.meta.dir, '..'),
            env: { ...process.env, AGENT_WORKFLOW_HOME: home },
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 30_000,
          },
        )
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        const output = stdout + stderr
        expect(code).toBe(1)
        expect(output).toContain('database schema drift detected — refusing to start')
        expect(output).toContain(`db:    ${path}`)
        expect(output).toContain(
          `stage: schema-history-${kind === 'receipt-mismatch' ? 'receipt-preflight' : 'catalog-admission'}`,
        )
        expect(output).toContain(
          kind === 'receipt-mismatch' ? 'aw_meta_schema_history receipt differs' : 'bf_drift_probe',
        )
        expect(output).toContain('Safe recovery options:')
        expect(output).toContain('Restore a verified backup.')
        expect(output).toContain('add a new forward migration')
        expect(readFileSync(pointerPath)).toEqual(before)
      }
    } finally {
      removeTempDirSync(home)
    }
  }, 90_000)
