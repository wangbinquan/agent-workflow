// RFC-399 B1: owner-owned maintenance bodies; slicing and result projection are unchanged.
import type { IntegrationMaintenanceCommands } from '../public/commands'
import type {
  MaintenanceJobExecutionResult,
  MaintenanceJobHandlers,
} from '@/platform/contracts/maintenanceJob'
import type { MaintenanceWorkerDelta } from '@/platform/background/maintenanceProtocol'
import { parseMaintenanceJobPayload } from '@/platform/background/maintenanceJobPayload'

const NONE: MaintenanceWorkerDelta = { kind: 'none' }

const DB_WRITE_SLICE_ROWS = 1_000
const DAY_MS = 86_400_000

interface WebhookDeliveryGcCursor {
  readonly version: 1
  readonly phase: 'bodies' | 'rows'
  readonly bodyCutoff: number
  readonly rowCutoff: number
}

function webhookDeliveryCursor(value: unknown): WebhookDeliveryGcCursor | null {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'object' ||
    (value as { readonly version?: unknown }).version !== 1 ||
    !['bodies', 'rows'].includes(String((value as { readonly phase?: unknown }).phase)) ||
    !Number.isSafeInteger((value as { readonly bodyCutoff?: unknown }).bodyCutoff) ||
    !Number.isSafeInteger((value as { readonly rowCutoff?: unknown }).rowCutoff)
  ) {
    throw new Error('maintenance-webhook-delivery-cursor-invalid')
  }
  const cursor = value as WebhookDeliveryGcCursor
  return {
    version: 1,
    phase: cursor.phase,
    bodyCutoff: cursor.bodyCutoff,
    rowCutoff: cursor.rowCutoff,
  }
}

export async function runWebhookDeliveryMaintenanceJob(input: {
  readonly commands: IntegrationMaintenanceCommands
  readonly bodyRetentionDays: number
  readonly rowRetentionDays: number
  readonly cursor?: unknown
  readonly now?: number
}): Promise<MaintenanceJobExecutionResult> {
  const result = await input.commands.gcWebhookDeliveries({
    now: input.now ?? Date.now(),
    retention: {
      bodyRetentionMs: input.bodyRetentionDays * DAY_MS,
      rowRetentionMs: input.rowRetentionDays * DAY_MS,
    },
    cursor: webhookDeliveryCursor(input.cursor),
    batchSize: DB_WRITE_SLICE_ROWS,
  })
  return {
    counters: { ...result.counters },
    delta: NONE,
    ...(result.done ? {} : { continuation: { cursor: result.cursor, resumeAfterMs: 25 } }),
  }
}

export function createIntegrationMaintenanceJobHandlers(
  commands: IntegrationMaintenanceCommands,
): Pick<MaintenanceJobHandlers, 'webhookDeliveryGc'> {
  return {
    async webhookDeliveryGc(input) {
      const payload = parseMaintenanceJobPayload('webhookDeliveryGc', input.payload)
      return await runWebhookDeliveryMaintenanceJob({
        commands: commands,
        bodyRetentionDays: payload.bodyRetentionDays,
        rowRetentionDays: payload.rowRetentionDays,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      })
    },
  }
}
