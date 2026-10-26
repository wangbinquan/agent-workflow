import type { ReadOnlyProbe } from '@/platform/persistence/migration/run/types'

/** A wires these read-only target probes; they never invoke runtime recovery. */
export const readOnlyProbes: readonly ReadOnlyProbe[] = [
  {
    id: 'task-execution:run-selection-integrity',
    async run(connection) {
      const violations = await connection.query(`
        SELECT s.task_id, s.slot_key, s.selected_run_id, s.revision
        FROM node_run_selections s
        LEFT JOIN node_runs r ON r.id = s.selected_run_id
        LEFT JOIN task_execution_generations g ON g.task_id = s.task_id AND g.generation_seq = s.generation_seq
        WHERE s.revision < 1 OR g.task_id IS NULL OR
          (s.selected_run_id IS NOT NULL AND (r.id IS NULL OR r.task_id <> s.task_id OR
            r.slot_key IS NULL OR r.slot_key <> s.slot_key))
        LIMIT 100
      `)
      return {
        id: this.id,
        passed: violations.length === 0,
        detail: { violations: violations.length },
      }
    },
  },
  {
    id: 'task-execution:run-input-integrity',
    async run(connection) {
      const violations = await connection.query(`
        SELECT i.consumer_run_id, i.ordinal
        FROM node_run_inputs i
        LEFT JOIN node_runs c ON c.id = i.consumer_run_id
        LEFT JOIN node_runs p ON p.id = i.producer_run_ref
        WHERE c.id IS NULL OR c.task_id <> i.task_id OR c.inputs_recorded = FALSE OR
          (i.producer_run_ref IS NOT NULL AND (p.id IS NULL OR p.task_id <> i.task_id OR
            p.node_id <> i.producer_node_id OR p.id <> i.producer_run_id)) OR
          (i.producer_run_ref IS NULL AND (i.provenance_quality <> 'legacy-derived' OR i.evidence_ref_json IS NULL))
        LIMIT 100
      `)
      return {
        id: this.id,
        passed: violations.length === 0,
        detail: { violations: violations.length },
      }
    },
  },
]
