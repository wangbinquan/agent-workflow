import { expect, test, setDefaultTimeout } from 'bun:test'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeSwitchFixture } from './helpers/rfc395V3SwitchFixture'
import { describeV3SwitchJourney } from './helpers/rfc395V3SwitchJourney'

// A real backup and native switch or rollback take about 34 s per CI-scaled case; allow 105 s.
setDefaultTimeout(105000)
describeV3SwitchJourney('activate')

test('SQLite completion retains main, WAL and SHM independently across restarts', async () => {
  const f = makeSwitchFixture()
  try {
    writeFileSync(`${f.sourcePath}-wal`, 'wal bytes')
    writeFileSync(`${f.sourcePath}-shm`, 'shm bytes')
    const retained = await f.deps.retention.retain({
      operationId: f.operationId,
      source: { kind: 'sqlite-file', path: f.sourcePath, pointerPath: f.pointerPath },
    })
    expect(retained).toHaveLength(3)
    expect(
      readFileSync(
        join(f.deps.journal.operationRoot(f.operationId), 'source/db.sqlite-wal'),
        'utf8',
      ),
    ).toBe('wal bytes')
    expect(existsSync(f.sourcePath)).toBe(false)
    expect(
      await f.deps.retention.retain({
        operationId: f.operationId,
        source: { kind: 'sqlite-file', path: f.sourcePath, pointerPath: f.pointerPath },
      }),
    ).toEqual(retained)
  } finally {
    f.close()
  }
})

test('PostgreSQL to SQLite refusal leaves no journal and never stops the source', async () => {
  const f = makeSwitchFixture()
  try {
    const installation = f.deps.installation
    f.deps.installation = async () => {
      const result = await installation()
      return {
        ...result,
        source: { kind: 'postgresql-database', profileRef: 'env:SOURCE_URL' },
        facts: { ...result.facts, provider: 'postgresql' },
      }
    }
    await expect(f.app.plan({ target: { provider: 'sqlite' } })).rejects.toThrow('unsupported')
    expect(await f.deps.journal.list()).toEqual([])
    expect(f.control.quiesceCalls).toBe(0)
    expect(f.control.installed).toBe(false)
  } finally {
    f.close()
  }
})
