// Daemon token FILE management (design.md §10.2 的存量半边)。
// Daemon startup -> ensureTokenFile() reads or generates a 32-byte hex token
// at ~/.agent-workflow/token (chmod 600). Rotating the token invalidates all
// existing sessions (clients must re-read URL from daemon stdout or settings).
//
// RFC-285 B4：曾经与文件管理同居于此的 `tokenAuth` Hono 中间件（query 优先
// 接受 ?token= 的第三 token 读点）已删除——它在生产零消费（多用户 multiAuth
// 是唯一在网中间件），而其 query 通道正是 B4 要关的泄露面。

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const TOKEN_BYTES = 32 // 32 bytes hex = 64-char string

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/**
 * Read the existing token file, or generate a new one if missing.
 * Always ensures mode 0o600 (some filesystems / umasks ignore the open flag).
 */
export function ensureTokenFile(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    chmodSync(tokenPath, 0o600)
    return readFileSync(tokenPath, 'utf-8').trim()
  }
  return rotateTokenFile(tokenPath)
}

/** Generate a fresh token, overwriting any existing file. */
export function rotateTokenFile(tokenPath: string): string {
  const token = generateToken()
  mkdirSync(dirname(tokenPath), { recursive: true })
  writeFileSync(tokenPath, token, { mode: 0o600 })
  chmodSync(tokenPath, 0o600)
  return token
}
