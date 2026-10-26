import { z } from 'zod'
import { contentRefColumns, type ContentStore } from '@/platform/content/contentStore'

const cell = z.discriminatedUnion('type', [
  z.object({ type: z.literal('null') }),
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('boolean'), value: z.boolean() }),
  z.object({ type: z.literal('integer'), value: z.string().regex(/^-?\d+$/) }),
  z.object({ type: z.literal('real'), value: z.string() }),
  z.object({ type: z.literal('bytes'), value: z.string() }),
])
const evidenceSchema = z.object({
  format: z.literal('node-run-evidence@2'),
  sourceRef: z.object({
    table: z.literal('node_runs'),
    key: z.string(),
    phase: z.enum(['current', 'pre-upgrade']),
  }),
  sourceValues: z.record(z.string(), cell),
})
export interface NodeRunEvidenceIdentity {
  readonly id: string
  readonly taskId: string
  readonly recordMode: string
  readonly role: string | null
  readonly slotKey: string | null
  readonly attemptIndex: number | null
  readonly scopePath: string | null
}
export interface NodeRunEvidenceContent {
  readonly contentRefJson: string | null
  readonly contentInlineBytes: Uint8Array | null
}

/** The sole node-run-evidence@2 reader. Runtime code never imports the converter. */
export async function readNodeRunLegacyEvidence(
  row: NodeRunEvidenceIdentity,
  evidence: NodeRunEvidenceContent | null,
  content: Pick<ContentStore, 'read'>,
): Promise<Readonly<Record<string, unknown>> | null> {
  const needed =
    row.recordMode === 'history-only' ||
    row.role === null ||
    row.slotKey === null ||
    row.attemptIndex === null ||
    row.scopePath === null
  if (!needed) return null
  const ref = contentRefColumns.decode(
    evidence?.contentRefJson ?? null,
    evidence?.contentInlineBytes ?? null,
  )
  if (ref === null) throw new Error(`node-run-display-evidence-missing:${row.id}`)
  const bytes = ref.kind === 'inline' ? ref.bytes : await content.read(ref)
  const parsed = evidenceSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  )
  const values = Object.fromEntries(
    Object.entries(parsed.sourceValues).map(([key, value]) => {
      switch (value.type) {
        case 'null':
          return [key, null]
        case 'text':
        case 'boolean':
          return [key, value.value]
        case 'bytes':
          return [key, Uint8Array.from(Buffer.from(value.value, 'base64'))]
        case 'integer': {
          const integer = BigInt(value.value)
          return [
            key,
            integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER)
              ? Number(integer)
              : integer,
          ]
        }
        case 'real': {
          const number = Number(value.value)
          if (!Number.isFinite(number))
            throw new Error(`node-run-display-evidence-invalid:${row.id}:${key}`)
          return [key, number]
        }
      }
    }),
  )
  if (values.id !== row.id || values.task_id !== row.taskId)
    throw new Error(`node-run-display-evidence-identity-mismatch:${row.id}`)
  return values
}
