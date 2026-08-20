// RFC-284 T7（2026-08-12 审计 N20）——「单步 hash → hex」idiom 的唯一拼写。
//
// 此前 sha1Hex 三份具名拷贝 + sha1/sha256 单步内联散布 15+ 处（含凭据链
// patStore/sessionStore、webhook dedup 键、workflow 候选哈希等承重面）。
// 收敛为纯等价替换：同算法、默认/显式 utf8 对字符串输出字节完全一致
// （rfc284-microhelpers.test.ts 与 node:crypto 直算逐字节对拍）。
// **多步 builder（循环 update / 链式多段）与 shared 侧 16 行镜像桥
// （pluginOperationRevision ↔ mcpOperationRevision，分层理由成立）刻意不收。**

import { createHash } from 'node:crypto'

export interface Sha256DigestBuilder {
  update(input: string | Uint8Array): void
  digestHex(): string
}

export function sha1Hex(input: string | Uint8Array): string {
  return createHash('sha1').update(input).digest('hex')
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Streaming/multi-part SHA-256 without spreading node:crypto construction. */
export function createSha256DigestBuilder(): Sha256DigestBuilder {
  const hash = createHash('sha256')
  return {
    update(input) {
      hash.update(input)
    },
    digestHex() {
      return hash.digest('hex')
    },
  }
}
