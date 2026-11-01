// RFC-398 — fsync of a read-only handle fails with EPERM on Windows (FlushFileBuffers needs a
// write-capable handle). Every Windows SQLite automatic upgrade stopped at the offline copy in
// release-upgrade nightly 41287876705 (`syncSourceDirectory`), and the epoch-switch artifact store
// flushed its copies the same way. The flush helpers open write-capable handles on Windows only,
// tolerate a Windows file that cannot be opened for writing, and keep read-only handles on POSIX
// (where they work and must not require write permission on captured files).
import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flushSourceFile,
  syncSourceDirectory,
} from '@/platform/persistence/migration/freeze/artifacts'
import { flushEpochFile } from '@/modules/system-operations/infrastructure/epochSwitch/fileJournal'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function root() {
  const path = mkdtempSync(join(tmpdir(), 'aw-rfc398-flush-'))
  roots.push(path)
  return path
}
function file(mode = 0o644, dir = root()) {
  const path = join(dir, 'artifact')
  writeFileSync(path, 'bytes')
  chmodSync(path, mode)
  return path
}
const failure = (code: string) => Object.assign(new Error(code), { code })

type Flush = (
  path: string,
  platform: NodeJS.Platform,
  openFile?: (path: string, flags: 'r' | 'r+') => unknown,
) => Promise<void>
const helpers: [string, Flush, (path: string, flags: 'r' | 'r+') => unknown][] = [
  [
    'flushSourceFile',
    (path, platform, openFile) =>
      flushSourceFile(path, platform, openFile as Parameters<typeof flushSourceFile>[2]),
    (path, flags) => open(path, flags),
  ],
  [
    'flushEpochFile',
    async (path, platform, openFile) =>
      flushEpochFile(path, platform, openFile as Parameters<typeof flushEpochFile>[2]),
    (path, flags) => openSync(path, flags),
  ],
]

for (const [name, flush, real] of helpers) {
  test(`${name}: Windows opens a write-capable handle, POSIX a read-only one`, async () => {
    for (const [platform, expected] of [
      ['win32', 'r+'],
      ['linux', 'r'],
      ['darwin', 'r'],
    ] as const) {
      const flags: string[] = []
      await flush(file(), platform, (path, mode) => {
        flags.push(mode)
        return real(path, mode)
      })
      expect({ platform, flags }).toEqual({ platform, flags: [expected] })
    }
  })

  test(`${name}: only Windows tolerates a file it cannot open for writing`, async () => {
    for (const code of ['EPERM', 'EACCES'])
      await flush(file(), 'win32', () => {
        throw failure(code)
      })
    let error: unknown = null
    try {
      await flush(file(), 'linux', () => {
        throw failure('EPERM')
      })
    } catch (caught) {
      error = caught
    }
    expect((error as NodeJS.ErrnoException | null)?.code).toBe('EPERM')
  })

  test(`${name}: a missing file fails on every platform`, async () => {
    for (const platform of ['win32', 'linux'] as const) {
      let error: unknown = null
      try {
        await flush(join(root(), 'missing'), platform)
      } catch (caught) {
        error = caught
      }
      expect({ platform, code: (error as NodeJS.ErrnoException | null)?.code }).toEqual({
        platform,
        code: 'ENOENT',
      })
    }
  })

  test(`${name}: POSIX flushes a read-only captured file without write permission`, async () => {
    const path = file(0o444)
    await flush(path, 'linux')
    expect(readFileSync(path, 'utf8')).toBe('bytes')
    chmodSync(path, 0o644)
  })
}

test('syncSourceDirectory flushes every nested file and keeps their bytes', async () => {
  const dir = root()
  mkdirSync(join(dir, 'nested'), { recursive: true })
  file(0o444, dir)
  file(0o644, join(dir, 'nested'))
  await syncSourceDirectory(dir)
  expect(readFileSync(join(dir, 'artifact'), 'utf8')).toBe('bytes')
  expect(readFileSync(join(dir, 'nested', 'artifact'), 'utf8')).toBe('bytes')
  chmodSync(join(dir, 'artifact'), 0o644)
})
