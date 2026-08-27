import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { collaborationGateArtifacts, collaborationGateOperations } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type {
  HumanGateArtifactStore,
  PlannedReviewArtifact,
} from '../application/ports/humanGateArtifactStore'
import type { HumanGateArtifactSnapshot } from '../application/ports/humanGateOperationStore'
import { HumanGateOperationError } from '../domain/humanGateOperation'

function absolutePath(appHome: string, relativePath: string): string {
  return join(appHome, ...relativePath.split('/'))
}

function bytesOf(body: string): Uint8Array {
  return Buffer.from(body, 'utf8')
}

function assertContent(path: string, expectedSha256: string, expectedBytes: number): Buffer {
  const body = readFileSync(path)
  const actualSha256 = sha256Hex(body)
  if (actualSha256 !== expectedSha256 || body.byteLength !== expectedBytes) {
    throw new HumanGateOperationError(
      'human-gate-artifact-digest-mismatch',
      `human-gate artifact content does not match its journal: ${path}`,
      { expectedBytes, actualBytes: body.byteLength },
    )
  }
  return body
}

function stageReceipt(plan: PlannedReviewArtifact): string {
  return JSON.stringify({
    kind: 'review-doc-staged',
    sha256: plan.sha256,
    byteSize: plan.byteSize,
    stagedPath: plan.stagedPath,
  })
}

function finalizeReceipt(artifact: HumanGateArtifactSnapshot): string {
  return JSON.stringify({
    kind: 'review-doc-finalized',
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    finalPath: artifact.finalPath,
  })
}

export class FsHumanGateArtifactStore implements HumanGateArtifactStore {
  constructor(private readonly appHome: string) {}

  planReviewArtifact(input: {
    operationId: string
    artifactKey: string
    finalPath: string
    body: string
  }): PlannedReviewArtifact {
    const body = bytesOf(input.body)
    const operationSegment = sha256Hex(input.operationId).slice(0, 24)
    const artifactSegment = sha256Hex(input.artifactKey).slice(0, 24)
    return {
      operationId: input.operationId,
      artifactKey: input.artifactKey,
      stagedPath: posix.join(
        'runs',
        '.human-gate-staging',
        operationSegment,
        `${artifactSegment}.md`,
      ),
      finalPath: input.finalPath,
      sha256: sha256Hex(body),
      byteSize: body.byteLength,
    }
  }

  stageReviewArtifact(plan: PlannedReviewArtifact, body: string): string {
    const bytes = bytesOf(body)
    if (sha256Hex(bytes) !== plan.sha256 || bytes.byteLength !== plan.byteSize) {
      throw new HumanGateOperationError(
        'human-gate-artifact-digest-mismatch',
        `human-gate artifact '${plan.artifactKey}' changed after planning`,
        { expectedBytes: plan.byteSize, actualBytes: bytes.byteLength },
      )
    }
    const staged = absolutePath(this.appHome, plan.stagedPath)
    if (existsSync(staged)) {
      assertContent(staged, plan.sha256, plan.byteSize)
      return stageReceipt(plan)
    }
    mkdirSync(dirname(staged), { recursive: true })
    const temporary = `${staged}.writing`
    writeFileSync(temporary, bytes)
    renameSync(temporary, staged)
    assertContent(staged, plan.sha256, plan.byteSize)
    return stageReceipt(plan)
  }

  finalizeReviewArtifact(artifact: HumanGateArtifactSnapshot): string {
    const staged = absolutePath(this.appHome, artifact.stagedPath)
    const final = absolutePath(this.appHome, artifact.finalPath)
    if (existsSync(final)) {
      assertContent(final, artifact.sha256, artifact.byteSize)
      rmSync(staged, { force: true })
      rmSync(`${staged}.writing`, { force: true })
      return finalizeReceipt(artifact)
    }
    if (!existsSync(staged)) {
      throw new HumanGateOperationError(
        'human-gate-artifact-missing',
        `human-gate artifact '${artifact.artifactKey}' has neither staged nor final content`,
        { operationId: artifact.operationId, artifactKey: artifact.artifactKey },
      )
    }
    assertContent(staged, artifact.sha256, artifact.byteSize)
    mkdirSync(dirname(final), { recursive: true })
    renameSync(staged, final)
    assertContent(final, artifact.sha256, artifact.byteSize)
    return finalizeReceipt(artifact)
  }

  cleanupReviewArtifact(artifact: HumanGateArtifactSnapshot): void {
    const staged = absolutePath(this.appHome, artifact.stagedPath)
    if (existsSync(staged)) assertContent(staged, artifact.sha256, artifact.byteSize)
    rmSync(staged, { force: true })
    rmSync(`${staged}.writing`, { force: true })
  }
}

export function readCommittedReviewArtifactBody(
  db: DbClient,
  appHome: string,
  finalPath: string,
): string {
  const artifact = db
    .select({
      stagedPath: collaborationGateArtifacts.stagedPath,
      sha256: collaborationGateArtifacts.sha256,
      byteSize: collaborationGateArtifacts.byteSize,
    })
    .from(collaborationGateArtifacts)
    .innerJoin(
      collaborationGateOperations,
      eq(collaborationGateOperations.id, collaborationGateArtifacts.operationId),
    )
    .where(
      and(
        eq(collaborationGateArtifacts.finalPath, finalPath),
        inArray(collaborationGateArtifacts.state, ['consumed', 'finalized']),
        inArray(collaborationGateOperations.state, ['committed', 'completed']),
      ),
    )
    .get()
  const final = absolutePath(appHome, finalPath)
  if (existsSync(final)) {
    if (artifact === undefined) return readFileSync(final, 'utf8')
    return assertContent(final, artifact.sha256, artifact.byteSize).toString('utf8')
  }
  if (artifact !== undefined) {
    const staged = absolutePath(appHome, artifact.stagedPath)
    if (existsSync(staged)) {
      return assertContent(staged, artifact.sha256, artifact.byteSize).toString('utf8')
    }
  }
  throw new HumanGateOperationError(
    'human-gate-artifact-missing',
    `review body file not found: ${finalPath}`,
  )
}
