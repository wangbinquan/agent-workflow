// RFC-310 PR-6 T67 —— pipeline evidence 的 bounded/ranged 读（design §6.4）。
//
// 大日志只躺在 evidence 池；任何读面（Agent/HTTP/UI）都有字节预算，超限
// 返回可定位的截断 receipt（totalBytes/nextOffset），**不伪装完整**——调用方
// 可按 offset 续读。精准区间读（openSync/readSync），2 GB 文件也不整载内存。

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/** 单次读的硬上限；调用方 limit 超过时被 clamp 到它。 */
export const EVIDENCE_READ_MAX_BYTES = 4 * 1024 * 1024

export type EvidenceRangeRead =
  | {
      readonly ok: true
      readonly bytes: Uint8Array
      readonly totalBytes: number
      /** 本次没读到文件尾（还有后续字节可按 nextOffset 续读）。 */
      readonly truncated: boolean
      readonly nextOffset: number | null
    }
  | { readonly ok: false; readonly code: 'evidence-file-missing' | 'range-invalid' }

export function readEvidenceFileRange(
  deps: { blobPath(ref: string): string },
  input: { readonly sha256: string; readonly offsetBytes: number; readonly limitBytes: number },
): EvidenceRangeRead {
  if (
    !Number.isInteger(input.offsetBytes) ||
    input.offsetBytes < 0 ||
    !Number.isInteger(input.limitBytes) ||
    input.limitBytes <= 0
  ) {
    return { ok: false, code: 'range-invalid' }
  }
  const limit = Math.min(input.limitBytes, EVIDENCE_READ_MAX_BYTES)
  let fd: number
  try {
    fd = openSync(deps.blobPath(input.sha256), 'r')
  } catch {
    return { ok: false, code: 'evidence-file-missing' }
  }
  try {
    const totalBytes = fstatSync(fd).size
    if (input.offsetBytes >= totalBytes) {
      // 超尾不是错误：空读 + 明确「没有更多」（幂等的续读终点）。
      return { ok: true, bytes: new Uint8Array(0), totalBytes, truncated: false, nextOffset: null }
    }
    const want = Math.min(limit, totalBytes - input.offsetBytes)
    const buffer = new Uint8Array(want)
    let read = 0
    while (read < want) {
      const n = readSync(fd, buffer, read, want - read, input.offsetBytes + read)
      if (n === 0) break
      read += n
    }
    const bytes = read === want ? buffer : buffer.subarray(0, read)
    const end = input.offsetBytes + read
    const truncated = end < totalBytes
    return {
      ok: true,
      bytes,
      totalBytes,
      truncated,
      nextOffset: truncated ? end : null,
    }
  } finally {
    closeSync(fd)
  }
}
