// RFC-310 PR-3 T36a —— RepositoryUploadPlan 的 placement（SeedChangeRef 物化）。
//
// seed 根 = `<evidence>/seeds/<planDigest>/`：内容由 plan 唯一决定，因此
// **planDigest 即幂等键**——已存在时对拍 seedTreeDigest，一致直接复用，不一致
// （中断残留）废弃重建；绝不在旧目录上叠加第二遍（design §5.4）。
// already-present entry 不物化（不制造伪 diff）；全 already-present ⇒
// seedChangeRef=null + 直接写 baseline-observed fulfillment（不能为类型好看
// 生成伪 change）。

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import {
  developmentRepositoryUploadPlanEntries,
  developmentRepositoryUploadPlans,
  developmentRepositoryUploadReceipts,
} from '@/db/schema'
import { repoRelativePathSchema } from '../domain/requirementManifest'
import type { UploadPlacementPort } from '../application/ports/reconcilerPorts'
import type { EvidenceStore } from './evidenceStore'

/** seed 树的稳定内容 digest（相对路径排序 + 每文件 sha256）。 */
export function seedTreeDigestOf(root: string): string {
  const hash = createHash('sha256')
  const files: string[] = []
  const walk = (rel: string): void => {
    const abs = rel === '' ? root : join(root, rel)
    const st = lstatSync(abs)
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(rel === '' ? name : `${rel}/${name}`)
      return
    }
    if (st.isFile()) files.push(rel)
  }
  if (existsSync(root)) walk('')
  for (const rel of files.sort()) {
    const content = readFileSync(join(root, rel))
    hash.update(`${rel}\n`)
    hash.update(createHash('sha256').update(content).digest('hex'))
    hash.update('\n')
  }
  return hash.digest('hex')
}

export interface PlacementDeps {
  readonly db: DbClient
  readonly evidence: EvidenceStore
  readonly seedsRoot: string
  readonly now: () => number
}

export interface PlacementResult {
  readonly seedChangeRef: string | null
  readonly seedTreeDigest: string
  readonly dispositions: readonly {
    fileId: string
    disposition: 'created' | 'replaced' | 'already-present'
  }[]
}

export async function placeUploadSeed(
  deps: PlacementDeps,
  input: { readonly planId: string },
): Promise<PlacementResult> {
  const plan = deps.db
    .select()
    .from(developmentRepositoryUploadPlans)
    .where(eq(developmentRepositoryUploadPlans.id, input.planId))
    .get()
  if (plan === undefined) throw new Error(`upload plan not found: ${input.planId}`)
  const entries = deps.db
    .select()
    .from(developmentRepositoryUploadPlanEntries)
    .where(eq(developmentRepositoryUploadPlanEntries.planId, input.planId))
    .all()
    .sort((a, b) => a.ordinal - b.ordinal)

  const active = entries.filter((e) => e.expectedTargetKind !== 'already-present')
  const dispositions = entries.map((e) => ({
    fileId: e.fileId,
    disposition:
      e.expectedTargetKind === 'already-present'
        ? ('already-present' as const)
        : e.expectedTargetKind === 'absent'
          ? ('created' as const)
          : ('replaced' as const),
  }))

  // 全 already-present：null seed + baseline-observed fulfillment（幂等 upsert）。
  if (active.length === 0) {
    const emptyDigest = seedTreeDigestOf(join(deps.seedsRoot, '__nonexistent__'))
    const existing = deps.db
      .select()
      .from(developmentRepositoryUploadReceipts)
      .where(eq(developmentRepositoryUploadReceipts.planId, input.planId))
      .all()
    if (!existing.some((r) => r.receiptKind === 'placement')) {
      deps.db
        .insert(developmentRepositoryUploadReceipts)
        .values({
          id: ulid(),
          planId: input.planId,
          baselineSnapshotRef: plan.baselineSnapshotRef,
          receiptKind: 'placement',
          seedChangeRef: null,
          seedTreeDigest: emptyDigest,
          fulfillmentKind: 'baseline-observed',
          commitSha: plan.baselineSha,
          entriesJson: JSON.stringify(dispositions),
          createdAt: deps.now(),
        })
        .run()
    }
    return { seedChangeRef: null, seedTreeDigest: emptyDigest, dispositions }
  }

  const seedRoot = join(deps.seedsRoot, plan.planDigest)
  const rebuild = (): void => {
    if (existsSync(seedRoot)) rmSync(seedRoot, { recursive: true, force: true })
    const staging = `${seedRoot}.tmp-${ulid()}`
    mkdirSync(staging, { recursive: true })
    for (const entry of active) {
      // 深防：plan 行必经 schema 才能落库，但 placement 是文件系统写入点，
      // 独立复验一次（手改 DB 行/未来新写入路径都拦在这）。
      if (!repoRelativePathSchema.safeParse(entry.repositoryTargetPath).success) {
        rmSync(staging, { recursive: true, force: true })
        throw new Error(`unsafe repository target path: ${entry.repositoryTargetPath}`)
      }
      const src = deps.evidence.blobPath(entry.uploadBlobRef)
      if (!existsSync(src)) {
        rmSync(staging, { recursive: true, force: true })
        throw new Error(
          `upload blob missing: ${entry.uploadBlobRef} (${entry.repositoryTargetPath})`,
        )
      }
      const dest = join(staging, entry.repositoryTargetPath)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
    }
    renameSync(staging, seedRoot)
  }

  // 幂等：已有 seed 且树 digest 与内容一致 ⇒ 复用；否则废弃重建（byte-identical）。
  const expectedReceipt = deps.db
    .select()
    .from(developmentRepositoryUploadReceipts)
    .where(eq(developmentRepositoryUploadReceipts.planId, input.planId))
    .all()
    .find((r) => r.receiptKind === 'placement')
  if (!existsSync(seedRoot)) {
    rebuild()
  } else if (
    expectedReceipt !== undefined &&
    expectedReceipt.seedTreeDigest !== seedTreeDigestOf(seedRoot)
  ) {
    rebuild()
  }
  const digest = seedTreeDigestOf(seedRoot)
  if (expectedReceipt !== undefined && expectedReceipt.seedTreeDigest !== null) {
    if (expectedReceipt.seedTreeDigest !== digest) {
      // receipt 在而内容对不上且重建后仍不一致 ⇒ blob 池损坏，显式抛出。
      throw new Error(`seed digest mismatch for plan ${input.planId}`)
    }
  } else {
    deps.db
      .insert(developmentRepositoryUploadReceipts)
      .values({
        id: ulid(),
        planId: input.planId,
        baselineSnapshotRef: plan.baselineSnapshotRef,
        receiptKind: 'placement',
        seedChangeRef: plan.planDigest,
        seedTreeDigest: digest,
        fulfillmentKind: null,
        commitSha: null,
        entriesJson: JSON.stringify(dispositions),
        createdAt: deps.now(),
      })
      .run()
  }
  return { seedChangeRef: plan.planDigest, seedTreeDigest: digest, dispositions }
}

/** reconciler 的 UploadPlacementPort provider（composition 注入；不改 reconciler）。 */
export function createUploadPlacementProvider(deps: PlacementDeps): UploadPlacementPort {
  return {
    async place(input) {
      try {
        const result = await placeUploadSeed(deps, { planId: input.uploadPlanRef })
        return { ok: true, seedTreeDigest: result.seedTreeDigest }
      } catch (error) {
        return {
          ok: false,
          failure: {
            category: 'configuration',
            code: 'upload-placement-failed',
            retryability: 'after-configuration',
            attemptOrdinal: 0,
            remediation: (error as Error).message.slice(0, 200),
            evidenceRef: null,
          },
        }
      }
    },
  }
}
