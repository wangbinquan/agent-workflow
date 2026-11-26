// RFC-036 — AES-256-GCM helper for wrapping OIDC client_secret values at rest.
// Key file lives at ~/.agent-workflow/secret.key (32 random bytes, chmod 600);
// daemon first-run creates it. If the key file is lost, all sealed values are
// permanently unreadable — admins must re-enter the client_secret. Documented
// in design.md §5.7.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SecretBox } from '../contracts/secretBox'

const ALGO = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** Read or create the daemon's secret.key file. Side-effects: chmod 600. */
export function ensureSecretKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    chmodSync(keyPath, 0o600)
    const buf = readFileSync(keyPath)
    if (buf.length !== KEY_BYTES) {
      throw new Error(`secret.key wrong size (${buf.length}); expected ${KEY_BYTES}`)
    }
    return buf
  }
  mkdirSync(dirname(keyPath), { recursive: true })
  const key = randomBytes(KEY_BYTES)
  writeFileSync(keyPath, key, { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  return key
}

export function createSecretBox(keyPath: string): SecretBox {
  const key = ensureSecretKey(keyPath)
  return createSecretBoxFromKey(key)
}

/** Test-friendly variant: take key directly without touching the FS. */
export function createSecretBoxFromKey(key: Buffer): SecretBox {
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes`)
  }
  return {
    seal(plaintext: string): string {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGO, key, iv)
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([iv, ct, tag]).toString('base64')
    },
    unseal(packed: string): string {
      const buf = Buffer.from(packed, 'base64')
      if (buf.length < IV_BYTES + TAG_BYTES) {
        throw new Error('sealed payload too short')
      }
      const iv = buf.subarray(0, IV_BYTES)
      const tag = buf.subarray(buf.length - TAG_BYTES)
      const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES)
      const decipher = createDecipheriv(ALGO, key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    },
  }
}
