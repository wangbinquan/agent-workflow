import { rimrafDir } from './helpers/cleanup'
// RFC-036 — AES-256-GCM secret box invariants.

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretBox, createSecretBoxFromKey, ensureSecretKey } from '../src/auth/secretBox'
import { isWindows } from './helpers/stub-runtime'

describe('ensureSecretKey', () => {
  test('creates a 32-byte file with mode 0600 on first call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-secret-'))
    try {
      const keyPath = join(dir, 'secret.key')
      expect(existsSync(keyPath)).toBe(false)
      const k = ensureSecretKey(keyPath)
      expect(k.length).toBe(32)
      expect(existsSync(keyPath)).toBe(true)
      // On Windows, chmod is no-op; ACL verified separately in platform-fs.test.ts.
      if (!isWindows) {
        const mode = statSync(keyPath).mode & 0o777
        expect(mode).toBe(0o600)
      }
      const second = ensureSecretKey(keyPath)
      expect(Buffer.compare(k, second)).toBe(0)
      expect(Buffer.compare(k, readFileSync(keyPath))).toBe(0)
    } finally {
      rimrafDir(dir)
    }
  })

  test('rejects a key of the wrong size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-secret-'))
    try {
      const keyPath = join(dir, 'secret.key')
      // Write a 10-byte file.
      writeFileSync(keyPath, randomBytes(10), { mode: 0o600 })
      expect(() => ensureSecretKey(keyPath)).toThrow(/wrong size/)
    } finally {
      rimrafDir(dir)
    }
  })
})

describe('SecretBox round-trip', () => {
  test('seal → unseal returns plaintext', () => {
    const box = createSecretBoxFromKey(randomBytes(32))
    const pt = 'super-secret-client-secret-1234'
    const sealed = box.seal(pt)
    expect(sealed).not.toContain(pt)
    expect(box.unseal(sealed)).toBe(pt)
  })

  test('tampering with the tag throws', () => {
    const box = createSecretBoxFromKey(randomBytes(32))
    const sealed = box.seal('hello')
    const buf = Buffer.from(sealed, 'base64')
    const last = buf.length - 1
    buf[last] = ((buf[last] ?? 0) ^ 0xff) & 0xff
    const tampered = buf.toString('base64')
    expect(() => box.unseal(tampered)).toThrow()
  })

  test('decryption with a different key throws', () => {
    const a = createSecretBoxFromKey(randomBytes(32))
    const b = createSecretBoxFromKey(randomBytes(32))
    const sealed = a.seal('payload')
    expect(() => b.unseal(sealed)).toThrow()
  })

  test('reject obviously too-short payload', () => {
    const box = createSecretBoxFromKey(randomBytes(32))
    expect(() => box.unseal(Buffer.from([0x01, 0x02]).toString('base64'))).toThrow(/too short/)
  })
})

describe('createSecretBox wires up a temp keyfile', () => {
  test('creates key + round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-secret-'))
    try {
      const box = createSecretBox(join(dir, 'secret.key'))
      const pt = 'oidc-client-secret'
      expect(box.unseal(box.seal(pt))).toBe(pt)
    } finally {
      rimrafDir(dir)
    }
  })
})
