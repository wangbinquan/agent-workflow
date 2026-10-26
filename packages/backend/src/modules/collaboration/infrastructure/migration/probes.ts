import type { ReadOnlyProbe } from '@/platform/persistence/migration/run/types'

/** Read-only target checks. A supplies the provider's generation connection. */
export const readOnlyProbes: readonly ReadOnlyProbe[] = [
  {
    id: 'collaboration:target-clarify-and-gate-content',
    async run(connection) {
      const violations = await connection.query(`
      SELECT 'answer-recording' AS issue, a.round_id AS id FROM clarify_answers a
      JOIN clarify_rounds r ON r.id = a.round_id WHERE r.answers_recorded = FALSE
      UNION ALL SELECT 'draft-recording', a.round_id FROM clarify_answer_drafts a
      JOIN clarify_rounds r ON r.id = a.round_id WHERE r.drafts_recorded = FALSE
      UNION ALL SELECT 'attribution-recording', a.round_id FROM clarify_answer_attributions a
      JOIN clarify_rounds r ON r.id = a.round_id WHERE r.attributions_recorded = FALSE
      UNION ALL SELECT 'gate-content-missing', operation_id FROM collaboration_gate_artifacts
      WHERE state IN ('staged', 'consumed', 'finalized')
      AND (content_ref_json IS NULL OR staged_content_ref_json IS NULL)
    `)
      return {
        id: 'collaboration:target-clarify-and-gate-content',
        passed: violations.length === 0,
        detail: violations.map((row) => ({ issue: String(row.issue), id: String(row.id) })),
      }
    },
  },
]
