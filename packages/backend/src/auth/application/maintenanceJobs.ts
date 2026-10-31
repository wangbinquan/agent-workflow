// RFC-399 B1: keep token audit slice counters and cursor scheduling at their owner.
import type { MaintenanceJobHandlers } from '@/platform/contracts/maintenanceJob'
import { parseMaintenanceJobPayload } from '@/platform/background/maintenanceJobPayload'
import type { TokenCallAuditParticipant } from './tokenCallAudit'

export function createTokenAuditMaintenanceJobHandlers(
  tokenAudit: Pick<TokenCallAuditParticipant, 'pruneSlice'>,
): Pick<MaintenanceJobHandlers, 'tokenAuditGc'> {
  return {
    async tokenAuditGc(input) {
      const payload = parseMaintenanceJobPayload('tokenAuditGc', input.payload)
      const result = await tokenAudit.pruneSlice(payload.retentionDays, input.cursor)
      return {
        counters: result.counters,
        delta: { kind: 'none' },
        ...(result.done ? {} : { continuation: { cursor: result.cursor, resumeAfterMs: 25 } }),
      }
    },
  }
}
