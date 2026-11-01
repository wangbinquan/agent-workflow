// RFC-398 — pre-v0.5.0 installations have repository URLs but never had secret.key. The frozen
// chain turns those URLs into legacy escrow that the boot upgrade must seal with a key, so a real
// v0.2.0 home was refused (`v2-boot-url-key-missing`, release-upgrade nightly 41287876705). By user
// decision (2026-11-01) the migration creates the key for a live app home exactly as the daemon's
// first v0.5.0+ boot would (ensureSecretKey: 32 random bytes, mode 0600), once, so later captures
// and retries seal with the same key. Sealed URLs without their key, backups and hosted sources
// keep the previous behaviour.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { epochMigrationKeys } from '@/bootstrap/epochMigrationKeys'
import type { BootUpgradeCaptureInput } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import { sha256Hex } from '@/util/hash'

const ESCROW = `aw-legacy-url-hex-v1:${Buffer.from('https://example.test/repo.git').toString('hex')}`
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function capture(urls: readonly (string | null)[], kind: 'app-home' | 'backup' = 'app-home') {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc398-url-key-'))
  homes.push(root)
  const rows = urls.map((url_enc, index) => ({ id: `repo-${index}`, url_enc, url_redacted: null }))
  const artifacts = new Map<string, Uint8Array>()
  const input = {
    stage: 'plan',
    root: { kind, root, runsSupplied: false },
    source: {
      preflight: { tables: [{ table: 'cached_repos' }], expectedAbsent: [] },
      reader: {
        async readChunk() {
          return { rows, decodedRows: rows, lastKey: null }
        },
      },
    },
    async readArtifact(name: string) {
      return artifacts.get(name) ?? null
    },
    async writeArtifact(name: string, bytes: Uint8Array) {
      artifacts.set(name, bytes)
    },
  } as unknown as BootUpgradeCaptureInput
  return { root, input, artifacts, keyPath: join(root, 'secret.key') }
}

test('a live app home whose URLs are all legacy escrow gets one daemon-format secret.key', async () => {
  const f = capture([ESCROW, null, ESCROW])
  const warnings: string[] = []
  const provider = epochMigrationKeys(undefined, f.root, (line) => warnings.push(line))
  const first = await provider.open(f.input)
  expect(first).not.toBeNull()
  const key = readFileSync(f.keyPath)
  expect(key.length).toBe(32)
  if (process.platform !== 'win32') expect(statSync(f.keyPath).mode & 0o777).toBe(0o600)
  expect(first!.identity).toBe(f.keyPath)
  expect(first!.fingerprint).toBe(`sha256:${sha256Hex(key)}`)
  expect(first!.box.unseal(createSecretBoxFromKey(key).seal('sealed'))).toBe('sealed')
  const record = JSON.parse(Buffer.from(f.artifacts.get('boot-url-key/created.json')!).toString())
  expect(record).toEqual({
    path: f.keyPath,
    fingerprint: first!.fingerprint,
    repositories: 2,
    stage: 'plan',
  })
  // One operator notice on the offline stderr channel (`start` relays `WARN ` lines).
  expect(warnings).toEqual([
    `created secret.key for legacy repository URLs (pre-v0.5.0 installation): ${f.keyPath} (2 repositories, ${first!.fingerprint})`,
  ])
  // Later captures (freeze, run, a resumed session) reopen the same key and create nothing.
  f.artifacts.clear()
  const again = await provider.open(f.input)
  expect(again!.fingerprint).toBe(first!.fingerprint)
  expect(readFileSync(f.keyPath)).toEqual(key)
  expect(f.artifacts.size).toBe(0)
  expect(warnings).toHaveLength(1)
})

const silent = () => {
  throw new Error('no notice expected')
}

test('sealed URLs without their original key stay blocked and no key is created', async () => {
  const sealed = createSecretBoxFromKey(Buffer.alloc(32, 7)).seal('https://example.test/r.git')
  const f = capture([ESCROW, sealed])
  expect(await epochMigrationKeys(undefined, f.root, silent).open(f.input)).toBeNull()
  expect(existsSync(f.keyPath)).toBe(false)
  expect(f.artifacts.size).toBe(0)
})

test('no encoded URL needs no key, and none is created', async () => {
  for (const urls of [[], [null, null]]) {
    const f = capture(urls)
    expect(await epochMigrationKeys(undefined, f.root, silent).open(f.input)).toBeNull()
    expect(existsSync(f.keyPath)).toBe(false)
  }
})

test('an existing key is used as is, never replaced', async () => {
  const f = capture([ESCROW])
  const key = Buffer.alloc(32, 3)
  writeFileSync(f.keyPath, key)
  const opened = await epochMigrationKeys(undefined, f.root, silent).open(f.input)
  expect(opened!.fingerprint).toBe(`sha256:${sha256Hex(key)}`)
  expect(readFileSync(f.keyPath)).toEqual(key)
  expect(f.artifacts.size).toBe(0)
})

test('backups and hosted sources never create a key', async () => {
  const backup = capture([ESCROW], 'backup')
  expect(await epochMigrationKeys(undefined, undefined, silent).open(backup.input)).toBeNull()
  expect(existsSync(backup.keyPath)).toBe(false)
  const hosted = capture([ESCROW])
  expect(await epochMigrationKeys(() => null, undefined, silent).open(hosted.input)).toBeNull()
  expect(existsSync(hosted.keyPath)).toBe(false)
})
