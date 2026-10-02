import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type {
  EvidenceContentQueries,
  EvidenceRangeRead,
} from '../../application/pipelineEvidenceRead'

function readFileRange(
  deps: { blobPath(ref: string): string },
  input: { readonly sha256: string; readonly offsetBytes: number; readonly limitBytes: number },
): EvidenceRangeRead {
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
    const want = Math.min(input.limitBytes, totalBytes - input.offsetBytes)
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

export function createFileEvidenceContentQueries(deps: {
  blobPath(ref: string): string
}): EvidenceContentQueries {
  return Object.freeze({
    async readText(ref: string) {
      const file = Bun.file(deps.blobPath(ref))
      return (await file.exists()) ? await file.text() : null
    },
    readRange(input: Parameters<EvidenceContentQueries['readRange']>[0]) {
      return readFileRange(deps, input)
    },
  })
}
