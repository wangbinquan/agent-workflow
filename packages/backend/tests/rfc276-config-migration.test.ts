import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, readConfig } from '../src/config'

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rfc276-config-'))
  roots.push(root)
  const path = join(root, 'config.json')
  const original = `${JSON.stringify(
    {
      $schema_version: 1,
      language: 'en-US',
      sandboxMode: 'strict',
      businessToolchainPaths: ['/opt/runtime-tools'],
      inheritMachineOpencodeConfig: true,
      retainedExtension: { enabled: true },
    },
    null,
    2,
  )}\n`
  writeFileSync(path, original, { mode: 0o600 })
  return {
    path,
    original,
    backupPath: `${path}.pre-rfc276-runtime-hardening.bak`,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-276 config migration', () => {
  test('readConfig remains side-effect free while loadConfig archives and removes retired keys', () => {
    const { path, original, backupPath } = fixture()

    expect(readConfig(path)?.language).toBe('en-US')
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(existsSync(backupPath)).toBe(false)

    const loaded = loadConfig(path)
    expect(loaded.language).toBe('en-US')
    expect(readFileSync(backupPath, 'utf8')).toBe(original)
    expect(statSync(backupPath).mode & 0o777).toBe(0o600)

    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(persisted).not.toHaveProperty('sandboxMode')
    expect(persisted).not.toHaveProperty('businessToolchainPaths')
    expect(persisted).not.toHaveProperty('inheritMachineOpencodeConfig')
    expect(persisted.retainedExtension).toEqual({ enabled: true })

    const migratedBytes = readFileSync(path, 'utf8')
    expect(loadConfig(path).language).toBe('en-US')
    expect(readFileSync(path, 'utf8')).toBe(migratedBytes)
    expect(readFileSync(backupPath, 'utf8')).toBe(original)
  })

  test('a mismatched pre-existing recovery copy blocks the rewrite', () => {
    const { path, original, backupPath } = fixture()
    writeFileSync(backupPath, 'different bytes\n', { mode: 0o600 })

    expect(() => loadConfig(path)).toThrow('backup differs')
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(readFileSync(backupPath, 'utf8')).toBe('different bytes\n')
  })

  test('an identical recovery copy makes a crash retry safe', () => {
    const { path, original, backupPath } = fixture()
    writeFileSync(backupPath, original, { mode: 0o600 })

    expect(loadConfig(path).language).toBe('en-US')
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(persisted).not.toHaveProperty('sandboxMode')
    expect(readFileSync(backupPath, 'utf8')).toBe(original)
  })
})
