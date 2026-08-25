// RFC-310 PR-6 T65 —— pipeline evidence 的 safe streaming import（design §6.3/§6.4）。
//
// adapter 只产 staged sink（文件树）+ 小 envelope（gate facts + 文件描述引用）；
// 本模块把 sink 收编成平台事实：真实文件集以 safe-walk 为准（symlink/逃逸/NUL/
// 预算拒收——EvidenceStore.importStagedTree 单点），digest 全部平台重算，adapter
// 自报的一律不作数（§3.3「平台重新 walk 输出目录并计算真实 digest」）。产出
// PipelineEvidenceManifestV1（schema 自检 + canonical manifestDigest）并把
// manifest JSON 本体存进内容寻址 blob 池——DB/prompt 永远只持 ref/digest，
// 大日志不经 DB/event/WS/prompt。压缩文件不展开、不执行：按普通字节文件登记
// （mediaType 提示 gzip/zip），Agent 侧 bounded ranged read 自行处置。

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalDigest, canonicalStringify } from '../domain/canonicalJson'
import {
  pipelineEvidenceManifestV1Schema,
  type GateStatus,
  type PipelineEvidenceManifestV1,
} from '../domain/pipelineManifest'
import type { EvidenceBudget, EvidenceStore } from './evidenceStore'

/** adapter collect envelope 的结构同形输入（integration 侧词表各自持有）。 */
export interface PipelineCollectEnvelopeLike {
  readonly providerKey: string
  /** provider 无 head 绑定（partial）时为 null——completeness 强制 partial。 */
  readonly providerHeadSha: string | null
  readonly targetSha: string | null
  readonly completeness: 'complete' | 'partial'
  readonly gates: readonly {
    readonly gateKey: string
    readonly required: boolean
    readonly status: GateStatus
    readonly runRef: string
    readonly attempt: number
    readonly finishedAt: string | null
    readonly retryability: 'safe' | 'unsafe' | 'unknown'
    readonly failureCategories: readonly string[]
    readonly files: readonly { readonly fileId: string; readonly relativePath: string }[]
  }[]
  readonly redaction: 'complete' | 'failed'
}

export type ImportPipelineEvidenceResult =
  | {
      readonly ok: true
      readonly manifest: PipelineEvidenceManifestV1
      /** manifest JSON 本体的内容寻址 blob ref（cells `__pipeline.manifestRef`）。 */
      readonly manifestRef: string
    }
  | { readonly ok: false; readonly code: string; readonly detail: string }

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  zip: 'application/zip',
}

function mediaTypeOf(relativePath: string): string {
  const dot = relativePath.lastIndexOf('.')
  const ext = dot >= 0 ? relativePath.slice(dot + 1).toLowerCase() : ''
  return MEDIA_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * staged sink + collect envelope → 平台 manifest（文件全集以 walk 为准）。
 * envelope 引用了 sink 里不存在的 path ⇒ 整体拒收（adapter 合同违约，不静默
 * 剪枝）；sink 里 envelope 未提及的文件照收（fileId=relativePath 补登），保证
 * 「平台看到的 = 磁盘上的」。fence（两次 head 对拍）不在本模块——它属采集
 * 编排（pipelineEvidenceChain），本模块只管把已通过 fence 的快照收编为事实。
 */
/** composition 注入用的端口工厂（分支逻辑留在 infrastructure，composition 纯装配）。 */
export function createPipelineImportAdapter(
  evidence: EvidenceStore,
  budget: EvidenceBudget,
): {
  import(input: {
    readonly stagedRoot: string
    readonly envelope: PipelineCollectEnvelopeLike
    readonly expectedHeadSha: string
    readonly expectedTargetSha: string
  }): Promise<
    | { readonly ok: true; readonly manifestJson: string; readonly manifestRef: string }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
} {
  return {
    async import(input) {
      const out = await importPipelineEvidence({ evidence }, { ...input, budget })
      if (!out.ok) return out
      return {
        ok: true,
        manifestJson: canonicalStringify(out.manifest),
        manifestRef: out.manifestRef,
      }
    },
  }
}

export async function importPipelineEvidence(
  deps: { readonly evidence: EvidenceStore },
  input: {
    readonly stagedRoot: string
    readonly envelope: PipelineCollectEnvelopeLike
    readonly expectedHeadSha: string
    readonly expectedTargetSha: string
    readonly budget: EvidenceBudget
  },
): Promise<ImportPipelineEvidenceResult> {
  // A provider that could not complete redaction must not get its bytes into
  // the durable evidence pool. Reject before safe-walk/import, not merely
  // after a manifest describing the unsafe bundle has already been stored.
  if (input.envelope.redaction !== 'complete') {
    return {
      ok: false,
      code: 'pipeline-evidence-redaction-incomplete',
      detail: 'pipeline evidence redaction did not complete',
    }
  }
  let record
  try {
    record = await deps.evidence.importStagedTree(input.stagedRoot, input.budget)
  } catch (error) {
    return {
      ok: false,
      code: 'pipeline-evidence-import-failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  const byPath = new Map(record.entries.map((entry) => [entry.relativePath, entry]))

  // envelope 文件引用必须逐个命中磁盘（fileId → 描述符；路径冲突的 fileId 拒）。
  const fileIdByPath = new Map<string, string>()
  const idSeen = new Set<string>()
  for (const gate of input.envelope.gates) {
    for (const ref of gate.files) {
      if (!byPath.has(ref.relativePath)) {
        return {
          ok: false,
          code: 'pipeline-evidence-file-missing-in-sink',
          detail: `gate '${gate.gateKey}' references '${ref.relativePath}' which is not in the staged sink`,
        }
      }
      const prior = fileIdByPath.get(ref.relativePath)
      if (prior !== undefined && prior !== ref.fileId) {
        return {
          ok: false,
          code: 'pipeline-evidence-file-id-conflict',
          detail: `'${ref.relativePath}' claimed as both '${prior}' and '${ref.fileId}'`,
        }
      }
      if (prior === undefined) {
        if (idSeen.has(ref.fileId)) {
          return {
            ok: false,
            code: 'pipeline-evidence-file-id-conflict',
            detail: `fileId '${ref.fileId}' claimed for multiple paths`,
          }
        }
        fileIdByPath.set(ref.relativePath, ref.fileId)
        idSeen.add(ref.fileId)
      }
    }
  }

  const files = record.entries
    .map((entry) => ({
      fileId: fileIdByPath.get(entry.relativePath) ?? entry.relativePath,
      relativePath: entry.relativePath,
      mediaType: mediaTypeOf(entry.relativePath),
      bytes: entry.bytes,
      sha256: entry.sha256,
      redaction: 'none' as const,
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))

  // provider 无 head 绑定 ⇒ completeness 强制 partial（绝不判 pass 的兜底在
  // facts 投影）；manifest.headSha 记 fence 通过的 expected head（占位可追溯）。
  const completeness =
    input.envelope.providerHeadSha === null ? ('partial' as const) : input.envelope.completeness

  const core = {
    schemaVersion: 1 as const,
    bundleId: record.bundleId,
    providerKey: input.envelope.providerKey,
    headSha: input.envelope.providerHeadSha ?? input.expectedHeadSha,
    targetSha: input.envelope.targetSha ?? input.expectedTargetSha,
    completeness,
    gates: input.envelope.gates.map((gate) => ({
      gateKey: gate.gateKey,
      required: gate.required,
      status: gate.status,
      runRef: gate.runRef,
      attempt: gate.attempt,
      finishedAt: gate.finishedAt,
      retryability: gate.retryability,
      failureCategories: [...gate.failureCategories].sort(),
      evidenceFileIds: gate.files.map((f) => fileIdByPath.get(f.relativePath) ?? f.relativePath),
    })),
    files,
    totals: { files: record.entries.length, bytes: record.totalBytes },
    redaction: input.envelope.redaction,
  }
  const manifest = { ...core, manifestDigest: canonicalDigest(core) }
  const parsed = pipelineEvidenceManifestV1Schema.safeParse(manifest)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'pipeline-manifest-invalid',
      detail: parsed.error.issues[0]?.message ?? 'manifest schema violation',
    }
  }

  // manifest 本体入池（内容寻址）；经临时文件走同一个流式 hash 入口。
  const tmp = mkdtempSync(join(tmpdir(), 'aw-pipeline-manifest-'))
  try {
    const file = join(tmp, 'manifest.json')
    writeFileSync(file, canonicalStringify(parsed.data))
    const blob = await deps.evidence.putBlobFromFile(file)
    return { ok: true, manifest: parsed.data, manifestRef: blob.sha256 }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
