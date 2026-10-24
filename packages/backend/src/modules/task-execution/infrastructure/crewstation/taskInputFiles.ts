// RFC-370 v3 V6 — original uploaded task inputs as task artifacts. Every file
// and the manifest naming them are `task-artifact` publications (key = artifact
// reference, scope = task id); each publication commits its hosted_task_artifacts
// row in its ready transaction. A partially retained request (files without a
// manifest) is completed by retrying the same request; the task object sweep
// releases everything once the task is gone.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  HostedObjectPublications,
  HostedObjectReceipt,
} from '@/modules/system-operations/public/participants'
import type { CrewStationStreamObjectStorage } from '@/platform/crewstation/objectStorage'
import { sha256Hex } from '@/util/hash'
import type { TaskInputFiles } from '../../application/ports/taskInputFiles'
import { HOSTED_TASK_ARTIFACT_OWNER, retainHostedTaskArtifactInTx } from './taskArtifacts'

const Receipt = z
  .object({
    id: z.guid({ error: 'Invalid uuid' }).meta({ format: 'uuid' }),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
  })
  .strict()
const Manifest = z
  .object({
    version: z.literal(2),
    taskId: z.string().min(1),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    limits: z
      .object({
        perFile: z.number().int().nonnegative(),
        perRequest: z.number().int().nonnegative(),
        perCount: z.number().int().nonnegative(),
      })
      .strict(),
    files: z.array(
      z
        .object({
          inputKey: z.string().min(1),
          filename: z.string().min(1),
          declaredMime: z.string(),
          object: Receipt,
        })
        .strict(),
    ),
  })
  .strict()
const prefixOf = (taskId: string) => {
  if (!taskId || /[/\\\0\r\n]/.test(taskId) || taskId === '.' || taskId === '..')
    throw new Error('hosted-input-task-invalid')
  return `runs/${taskId}/inputs/`
}

export function createHostedTaskInputFiles(input: {
  readonly db: PersistenceDb
  readonly objects: Pick<CrewStationStreamObjectStorage, 'open'>
  readonly publications: HostedObjectPublications
}): TaskInputFiles {
  const find = async (reference: string) => {
    const { hostedTaskArtifacts } = tablesOf(input.db)
    return (
      await input.db
        .select()
        .from(hostedTaskArtifacts)
        .where(eq(hostedTaskArtifacts.reference, reference))
        .limit(1)
    )[0]
  }
  const readBytes = async (object: HostedObjectReceipt) => {
    const bytes = new Uint8Array(await new Response(await input.objects.open(object)).arrayBuffer())
    if (bytes.length !== object.size || sha256Hex(bytes) !== object.sha256)
      throw new Error('hosted-input-content-corrupt')
    return bytes
  }
  return {
    async retain(request) {
      const prefix = prefixOf(request.taskId)
      const manifestReference = `${prefix}manifest.json`
      const fileReference = (index: number) => `${prefix}files/${index}`
      const existing = await find(manifestReference)
      const objects = await input.publications.publish(
        request.files.map((file, index) => ({
          owner: HOSTED_TASK_ARTIFACT_OWNER,
          key: fileReference(index),
          scope: request.taskId,
          bytes: file.bytes,
        })),
        {
          concurrency: 4,
          async commit(tx, receipts) {
            const { hostedTaskArtifacts } = tablesOf(tx)
            const saved = await tx
              .select({ reference: hostedTaskArtifacts.reference })
              .from(hostedTaskArtifacts)
              .where(
                and(
                  eq(hostedTaskArtifacts.taskId, request.taskId),
                  // Exact, case-sensitive prefix on both engines (`LIKE` folds
                  // ASCII case on SQLite only); `substr` counts characters.
                  sql`substr(${hostedTaskArtifacts.reference}, 1, ${[...`${prefix}files/`].length}) = ${`${prefix}files/`}`,
                ),
              )
            const expected = new Set(receipts.map((_, index) => fileReference(index)))
            if (saved.some((row) => !expected.has(row.reference)))
              throw new Error('hosted-input-file-set-changed')
            for (let index = 0; index < receipts.length; index++)
              await retainHostedTaskArtifactInTx(tx, {
                reference: fileReference(index),
                taskId: request.taskId,
                object: receipts[index]!,
              })
          },
        },
      )
      const manifest = Manifest.parse({
        version: 2,
        taskId: request.taskId,
        requestDigest: request.requestDigest,
        limits: request.limits,
        files: request.files.map((file, index) => ({
          inputKey: file.inputKey,
          filename: file.filename,
          declaredMime: file.declaredMime,
          object: Receipt.parse(objects[index]),
        })),
      })
      const bytes = Buffer.from(JSON.stringify(manifest))
      if (existing && existing.digest !== sha256Hex(bytes))
        throw new Error('hosted-input-request-changed')
      await input.publications.publish(
        [
          {
            owner: HOSTED_TASK_ARTIFACT_OWNER,
            key: manifestReference,
            scope: request.taskId,
            bytes,
          },
        ],
        {
          async commit(tx, [object]) {
            await retainHostedTaskArtifactInTx(tx, {
              reference: manifestReference,
              taskId: request.taskId,
              object: object!,
            })
          },
        },
      )
    },
    async read(taskId) {
      const row = await find(`${prefixOf(taskId)}manifest.json`)
      if (!row) return null
      const manifest = Manifest.parse(
        JSON.parse(
          Buffer.from(
            await readBytes({ id: row.objectId, sha256: row.digest, size: row.size }),
          ).toString('utf8'),
        ),
      )
      if (
        manifest.taskId !== taskId ||
        manifest.files.length > manifest.limits.perCount ||
        manifest.files.some((file) => file.object.size > manifest.limits.perFile) ||
        manifest.files.reduce((sum, file) => sum + file.object.size, 0) > manifest.limits.perRequest
      )
        throw new Error('hosted-input-manifest-invalid')
      const files = []
      for (const file of manifest.files)
        files.push({
          inputKey: file.inputKey,
          filename: file.filename,
          declaredMime: file.declaredMime,
          bytes: await readBytes(file.object),
        })
      return { requestDigest: manifest.requestDigest, limits: manifest.limits, files }
    },
  }
}
