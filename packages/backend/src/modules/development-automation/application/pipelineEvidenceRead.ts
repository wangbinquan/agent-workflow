// RFC-310 PR-6 T67 —— pipeline evidence 的 bounded/ranged 读（design §6.4）。
//
// 大日志只躺在 evidence 池；任何读面（Agent/HTTP/UI）都有字节预算，超限
// 返回可定位的截断 receipt（totalBytes/nextOffset），**不伪装完整**——调用方
// 可按 offset 续读。精准区间读（openSync/readSync），2 GB 文件也不整载内存。

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

/** Owner-facing bytes; refs are opaque to the application and its callers. */
export interface EvidenceContentQueries {
  readText(ref: string): string | null | Promise<string | null>
  readRange(input: {
    readonly sha256: string
    readonly offsetBytes: number
    readonly limitBytes: number
  }): EvidenceRangeRead | Promise<EvidenceRangeRead>
}

export async function readEvidenceRange(
  contents: EvidenceContentQueries,
  input: { readonly sha256: string; readonly offsetBytes: number; readonly limitBytes: number },
): Promise<EvidenceRangeRead> {
  if (
    !Number.isInteger(input.offsetBytes) ||
    input.offsetBytes < 0 ||
    !Number.isInteger(input.limitBytes) ||
    input.limitBytes <= 0
  ) {
    return { ok: false, code: 'range-invalid' }
  }
  return await contents.readRange({
    ...input,
    limitBytes: Math.min(input.limitBytes, EVIDENCE_READ_MAX_BYTES),
  })
}
