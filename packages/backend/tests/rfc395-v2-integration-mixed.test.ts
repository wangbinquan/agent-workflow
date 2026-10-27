import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { integrationInput, convertIntegration } from './helpers/model/mixedIntegration'
// RFC-395 V2-core C: full dormant assembly over a mixed real frozen database, both providers.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { SPACE_KINDS } from '@agent-workflow/shared'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import {
  assertTaskDtos,
  assertClarifyReplay,
  assertAgentReplay,
  assertRunOracle,
} from './helpers/rfc395V2/integration'
import { seedMixedInstance } from './helpers/rfc395V2/integrationFixtures'
import { contentBytes, contentDigest } from './helpers/rfc395V2/contentFixtures'
import { contentSourceTables } from '@/platform/content/migration/specs'
import { historySourceTables } from '@/platform/persistence/migration/archives/codeHistory'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'

// Full frozen-source conversion and restart take about 6 s per CI-scaled case; allow 20 s.
setDefaultTimeout(20000)

describeV2Providers('RFC-395 V2 full mixed-instance integration', (h) => {
  test('all packages, all subjects/spaces, 227, nested frames, persisted writers, content and archives agree', async () => {
    await h.install()
    const expectedRuns = await seedMixedInstance(h)
    // Frozen skill bytes participate in B's proof and X's entry conversion in this same run.
    await h.sourceHarness.native.execute(
      `UPDATE ${h.sourceHarness.table('skills')} SET managed_path = 'database:skill_content_entries', content_version = 1, version_state = 'snapshot-authoritative' WHERE id = 'skill'`,
    )
    await h.sourceHarness.native.execute(
      `UPDATE ${h.sourceHarness.table('skill_versions')} SET files_path = 'database:skill_content_entries', content_hash = NULL WHERE skill_id = 'skill'`,
    )
    const input = await integrationInput(h)
    try {
      const result = await convertIntegration(input)
      const { sink, summary, sourceRows } = result
      // Exact lists: no blocks and no history-only rows in this proved mixed instance.
      expect(summary.blocks).toEqual([])
      expect(summary.historyOnly).toEqual([])
      expect(summary.status).toBe('converted')
      assertTaskDtos(result)
      assertClarifyReplay(result)
      assertAgentReplay(result)
      expect(await assertRunOracle(result, expectedRuns)).toBe(1) // registered workgroup #70 only
      expect(sink.rows('node_run_seq_allocations').find((row) => row.seq === 500)).toMatchObject({
        task_id: 'task',
        node_run_id: 'pruned-run',
        allocated_at: 900,
      })
      expect(sink.rows('resource_grants')).toEqual(
        sourceRows.get('resource_grants')!.map((row) => row.values),
      )
      const dependency = sink
        .rows('workflow_dependency_index')
        .find(
          (row) =>
            row.workflow_id === 'workflow' &&
            row.resource_kind === 'agent' &&
            row.selector_value === 'agent',
        )!
      expect(dependency.selector_kind).toBe('id')
      expect(dependency.reference_path).toBe('nodes[4].agentId')
      expect(JSON.parse(String(dependency.namespace_json))).toMatchObject({
        version: 2,
        nodeKind: 'agent-single',
      })
      for (const subject of ['workflow', 'agent', 'workgroup', 'digital-employee', 'code-round'])
        for (const space of SPACE_KINDS) {
          const id = `${subject}-${space}`
          expect(
            sink.rows('task_definitions').find((row) => row.task_id === id)!.subject_kind,
          ).toBe(subject)
          expect(sink.rows('task_workspaces').find((row) => row.task_id === id)!.space_kind).toBe(
            space,
          )
        }
      expect(sink.rows('task_execution_generations')).toHaveLength(sourceRows.get('tasks')!.length)
      expect(
        sink.rows('task_workspaces').find((row) => row.task_id === 'sample-227')!.task_branch,
      ).toBe('publish/task-227')
      expect(
        sink.rows('task_repository_mounts').find((row) => row.task_id === 'sample-227'),
      ).toMatchObject({
        branch: null,
        branch_state: 'detached',
        base_branch: 'sha-227',
        base_commit: 'sha-227',
      })
      for (const id of ['prep-old', 'prep-new'])
        expect(
          sink.rows('node_run_selections').find((row) => row.task_id === id)!.selected_run_id,
        ).toBe(`${id}-high-retry`)
      expect(
        sink.rows('node_run_inputs').filter((row) => row.input_kind === 'aggregator-shard'),
      ).toEqual([])
      expect(
        sink.rows('node_run_inputs').find((row) => row.consumer_run_id === 'agg'),
      ).toMatchObject({
        input_kind: 'frame-input',
        producer_run_id: 'shard-b',
        provenance_quality: 'legacy-derived',
      })
      expect(sink.rows('clarify_rounds').every((row) => row.container_run_id === 'inner')).toBe(
        true,
      )
      expect(sink.rows('clarify_answers').filter((row) => row.round_id === 'standalone')).toEqual(
        [],
      )
      expect(
        sink.rows('clarify_answer_attributions').filter((row) => row.round_id === 'standalone'),
      ).toHaveLength(1)
      expect(
        sink.rows('clarify_rounds').find((row) => row.id === 'legacy-answer')!.legacy_answers_json,
      ).toBe(' "legacy answer"\n')
      expect(
        sink.rows('node_run_repo_checkpoints').find((row) => row.node_run_id === 'member-merged'),
      ).toMatchObject({ isolation_base: 'base-only', node_tree: null })
      const evidence = sink
        .rows('execution_legacy_evidence')
        .find((row) => row.record_kind === 'node-run' && row.record_id === 'member-merged')!
      expect(Buffer.from(evidence.content_inline_bytes as Uint8Array).toString()).toContain(
        'node-tree-lost-by-known-defect',
      )
      expect(evidence.provenance_quality).toBe('legacy-derived')

      for (const table of [
        'maintenance_state',
        'users',
        'task_collaborators',
        'memories',
        'repo_group_nodes',
        'development_missions',
        'intent_turn_events',
        'runtime_session_leases',
        'user_access_audit',
      ])
        expect(sink.rows(table)).toEqual(
          expect.arrayContaining(sourceRows.get(table)!.map((row) => row.values)),
        )
      const intentJournal = sink.rows('intent_apply_journal')[0]!
      expect(intentJournal).toMatchObject({
        id: 'intent-apply',
        state: 'committed',
        receipt_json: '{ "same":true }',
      })
      expect(JSON.parse(String(intentJournal.prepared_artifacts_json))).toEqual({
        scene: 'intent',
        version: 3,
        artifacts: [
          {
            kind: 'skill-stage',
            skillId: 'skill',
            operationId: 'original-op',
            stagingDirectory: 'original',
            recovery: { kind: 'create', operationId: 'original-op', rootDirectory: 'original' },
          },
        ],
      })
      const bundleJournal = sink.rows('resource_bundle_applies')[0]!
      expect(bundleJournal).toMatchObject({
        id: 'bundle-apply',
        state: 'committed',
        receipt_json: '{ "journalId":"bundle-apply", "applied":[] }',
      })
      expect(JSON.parse(String(bundleJournal.prepared_artifacts_json))).toEqual({
        scene: 'resource-package',
        version: 2,
        artifacts: [],
      })
      for (const table of contentSourceTables) {
        const target = table === 'hosted_object_publications' ? 'content_publications' : table
        expect(sink.rows(target).length, `${table} -> ${target}`).toBeGreaterThan(0)
      }
      expect(
        input.bootUpgradeFacts!.facts.filter((fact) => fact.kind === 'skill-content'),
      ).toHaveLength(2)
      expect(sink.rows('skill_content_entries')).toHaveLength(3)
      expect(
        sink
          .rows('skills')
          .map((row) => [row.id, JSON.parse(String(row.content_ref_json)).kind])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual([
        ['other-skill', 'local-file'],
        ['skill', 'database-bytes'],
      ])
      expect(sink.rows('skill_versions')).toHaveLength(2) // supplied snapshot plus B's initial snapshot.

      const artifacts = [...sink.units.values()].flatMap((unit) => unit.artifacts)
      expect([...new Set(artifacts.map((receipt) => receipt.target.backend))].sort()).toEqual([
        'database-bytes',
        'inline',
        'local-file',
        'object',
      ])
      for (const table of ['node_run_outputs', 'review_comments', 'employee_reaction_artifacts'])
        expect(sink.rows(table)[0]!.content_inline_bytes).toEqual(contentBytes)
      expect(
        sink
          .rows('content_bytes')
          .some((row) => bytesDigest(row.bytes as Uint8Array).slice(7) === contentDigest),
      ).toBe(true)
      expect(artifacts.some((receipt) => receipt.publication === 'existing-ready')).toBe(true)
      expect(artifacts.some((receipt) => receipt.publication === 'requires-publication')).toBe(
        false,
      )

      expect(sink.rows('code_history_archives')).toHaveLength(13)
      for (const table of historySourceTables) {
        const archive = sink
          .rows('code_history_archives')
          .find((row) => row.source_table === table)!
        const original = sourceRows.get(table) ?? []
        expect(archive.row_count).toBe(original.length)
        expect(archive.root_digest).toBe(bytesDigest(archive.content_inline_bytes as Uint8Array))
        const payload = JSON.parse(
          Buffer.from(archive.content_inline_bytes as Uint8Array).toString(),
        )
        const index = sink
          .rows('code_history_id_index')
          .filter((row) => row.archive_id === archive.id)
        expect(index).toHaveLength(original.length)
        for (const row of index)
          expect(payload.records[Number(row.record_ordinal)].canonical).toEqual(
            original.find((source) => canonicalSchemaJson(source.key) === row.original_key_json)!
              .canonical,
          )
      }
      expect(
        [...sink.units.values()]
          .flatMap((unit) => unit.dispositions)
          .filter((row) => row.decision?.code === 'v2-code-history-adopted'),
      ).toHaveLength(3)
      expect(
        sink
          .rows('committed_event_family_cutovers')
          .find((row) => row.change_ref === 'integration-cutover'),
      ).toEqual({
        producer: 'task-execution',
        family: 'review',
        epoch: 77,
        changed_at: 456,
        change_ref: 'integration-cutover',
      })
      expect(summary.records).toContainEqual(
        expect.objectContaining({
          kind: 'writer-drain',
          payload: expect.objectContaining({
            activation: 'boot-equivalent',
            confirmedOsActive: true,
            next: expect.objectContaining({
              mode: 'os-active',
              legacyOpenMissionCount: 0,
              legacyAdmissionsEnabled: false,
            }),
          }),
        }),
      )
    } finally {
      await input.source.close()
    }
  })
})
