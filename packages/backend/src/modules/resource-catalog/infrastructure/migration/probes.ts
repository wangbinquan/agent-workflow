import {
  decodeResourcePackageArtifacts,
  decodeResourcePackageReceipt,
} from '../resourcePackageArtifactCodec'
import { targetTableName } from '@/platform/persistence/migration/target/loader'
import { workflowDependencyIndexEntries } from '@agent-workflow/shared'
import type { ReadOnlyProbe } from '@/platform/persistence/migration/run/types'
import { encodeAgentSkillReferenceKey } from '../../domain/agentReferenceKey'

export const readOnlyProbes: readonly ReadOnlyProbe[] = [
  {
    id: 'resource-catalog:apply-artifact-envelopes',
    async run(connection) {
      const rows = await connection.query(
        `SELECT id, state, prepared_artifacts_json, receipt_json FROM ${targetTableName(connection.provider, 'resource_bundle_applies')} ORDER BY id`,
      )
      const failures: string[] = []
      for (const row of rows) {
        try {
          decodeResourcePackageArtifacts(String(row.prepared_artifacts_json))
          if (row.state === 'committed')
            decodeResourcePackageReceipt({
              id: String(row.id),
              receiptJson: row.receipt_json === null ? null : String(row.receipt_json),
            })
        } catch {
          failures.push(String(row.id))
        }
      }
      return {
        id: 'resource-catalog:apply-artifact-envelopes',
        passed: failures.length === 0,
        detail: { rows: rows.length, failures },
      }
    },
  },
  {
    id: 'resource-catalog:agent-reference-order',
    async run(connection) {
      const parents = new Set(
        (
          await connection.query(`SELECT id FROM ${targetTableName(connection.provider, 'agents')}`)
        ).map((row) => row.id),
      )
      const failures: string[] = []
      let count = 0
      for (const [table, field] of [
        ['agent_skill_refs', 'reference_key'],
        ['agent_mcp_refs', 'mcp_id'],
        ['agent_plugin_refs', 'plugin_id'],
        ['agent_dependencies', 'dependency_agent_id'],
      ] as const) {
        const rows = await connection.query(
          `SELECT * FROM ${targetTableName(connection.provider, table)} ORDER BY agent_id, ordinal`,
        )
        const ordinals = new Map<string, number>()
        const occurrences = new Map<string, number>()
        for (const row of rows) {
          count += 1
          const id = String(row.agent_id)
          const ordinal = ordinals.get(id) ?? 0
          const key = JSON.stringify([id, row[field]])
          const occurrence = occurrences.get(key) ?? 0
          if (
            !parents.has(row.agent_id) ||
            Number(row.ordinal) !== ordinal ||
            Number(row.occurrence) !== occurrence
          )
            failures.push(`${table}:${id}:${String(row.ordinal)}`)
          if (table === 'agent_skill_refs') {
            const expected =
              row.kind === 'managed' &&
              typeof row.skill_id === 'string' &&
              row.project_name === null
                ? encodeAgentSkillReferenceKey({ kind: 'managed', skillId: row.skill_id })
                : row.kind === 'project' &&
                    typeof row.project_name === 'string' &&
                    row.skill_id === null
                  ? encodeAgentSkillReferenceKey({ kind: 'project', name: row.project_name })
                  : null
            if (expected === null || expected !== row.reference_key)
              failures.push(`${table}:${id}:reference-key`)
          }
          ordinals.set(id, ordinal + 1)
          occurrences.set(key, occurrence + 1)
        }
      }
      return {
        id: 'resource-catalog:agent-reference-order',
        passed: failures.length === 0,
        detail: { rows: count, failures },
      }
    },
  },
  {
    id: 'resource-catalog:workflow-index-parity',
    async run(connection) {
      const workflows = await connection.query(
        `SELECT id, version, definition FROM ${targetTableName(connection.provider, 'workflows')} ORDER BY id`,
      )
      const index = await connection.query(
        `SELECT workflow_id, revision, reference_path, resource_kind, selector_kind, selector_value, namespace_json FROM ${targetTableName(connection.provider, 'workflow_dependency_index')} ORDER BY workflow_id, reference_path`,
      )
      const failures: string[] = []
      const known = new Set(workflows.map((row) => row.id))
      const byWorkflow = new Map<unknown, (typeof index)[number][]>()
      for (const row of index) {
        if (!known.has(row.workflow_id)) failures.push(`orphan:${String(row.workflow_id)}`)
        const rows = byWorkflow.get(row.workflow_id) ?? []
        rows.push(row)
        byWorkflow.set(row.workflow_id, rows)
      }
      const canonical = (rows: readonly { referencePath: string }[]) =>
        JSON.stringify(
          [...rows].sort((a, b) =>
            a.referencePath < b.referencePath ? -1 : a.referencePath > b.referencePath ? 1 : 0,
          ),
        )
      for (const row of workflows) {
        try {
          const expected = workflowDependencyIndexEntries(String(row.definition))
          const actual = (byWorkflow.get(row.id) ?? []).map((entry) => ({
            referencePath: String(entry.reference_path),
            resourceKind: String(entry.resource_kind),
            selectorKind: String(entry.selector_kind),
            selectorValue: String(entry.selector_value),
            namespaceJson: String(entry.namespace_json),
          }))
          if (
            (byWorkflow.get(row.id) ?? []).some(
              (entry) => Number(entry.revision) !== Number(row.version),
            ) ||
            canonical(expected) !== canonical(actual)
          )
            failures.push(String(row.id))
        } catch {
          failures.push(`definition:${String(row.id)}`)
        }
      }
      return {
        id: 'resource-catalog:workflow-index-parity',
        passed: failures.length === 0,
        detail: { workflows: workflows.length, references: index.length, failures },
      }
    },
  },
]
