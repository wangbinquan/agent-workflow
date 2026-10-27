// research.md's 89 non-terminal tasks are a synthetic recovery population, not copied user data.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import {
  integrationInput,
  convertIntegration,
  assertTaskDtos,
  assertClarifyReplay,
  assertRunOracle,
  type ExpectedRun,
} from './helpers/rfc395V2/integration'
import { seedRequiredRows, seedSimpleTask, nodeSlot } from './helpers/rfc395V2/integrationFixtures'
import { runValues } from './helpers/rfc395V2/runFixtures'
import { question, answer, roundRow } from './helpers/rfc395V2/collabFixtures'

// Full frozen-source conversion and restart take about 8 s per CI-scaled case; allow 25 s.
setDefaultTimeout(25000)

describeV2Providers('RFC-395 V2 research recovery population', (h) => {
  test('21 awaiting_human + 8 awaiting_review + 60 interrupted retain histories, DTOs and selections', async () => {
    await h.install()
    await seedRequiredRows(h)
    const runs: ExpectedRun[] = []
    for (const [status, count] of [
      ['awaiting_human', 21],
      ['awaiting_review', 8],
      ['interrupted', 60],
    ] as const)
      for (let index = 0; index < count; index++) {
        const id = `${status}-${String(index).padStart(2, '0')}`
        const kind =
          status === 'awaiting_human'
            ? 'clarify'
            : status === 'awaiting_review'
              ? 'review'
              : 'script'
        await seedSimpleTask(h, id, status, {
          workflow_snapshot: JSON.stringify({
            $schema_version: 7,
            nodes: [{ id: 'ordinary', kind }],
            edges: [],
            inputs: [],
          }),
          started_at: 1000,
        })
        const allNull = status === 'interrupted' && index === 0
        for (const attempt of [0, 1]) {
          const runId = `${id}-${attempt}`
          await h.write('node_runs', [
            runValues(runId, {
              task_id: id,
              seq: allNull ? null : attempt + 1,
              status: attempt === 0 ? 'failed' : status,
              retry_index: attempt,
              review_iteration: status === 'awaiting_review' ? attempt : 0,
              rerun_cause: attempt
                ? status === 'awaiting_review'
                  ? 'review-rerun'
                  : 'retry-node'
                : null,
              started_at: 1100 + attempt * 100,
              finished_at: attempt === 0 ? 1150 : null,
              error_message: attempt === 0 ? 'original attempt stopped' : null,
              pre_snapshot: `checkpoint-${id}-${attempt}`,
              consumed_upstream_runs_json: attempt === 0 ? null : '{}',
            }),
          ])
          runs.push({
            id: runId,
            taskId: id,
            slot: nodeSlot(),
            seq: allNull ? attempt - 1 : attempt + 1,
            container: null,
            scope: '',
            iteration: 0,
          })
        }
        if (status === 'awaiting_human')
          await h.write('clarify_rounds', [
            roundRow(`round-${id}`, id, {
              asking_node_id: 'ordinary',
              asking_node_run_id: `${id}-1`,
              intermediary_node_id: 'ordinary',
              intermediary_node_run_id: `${id}-1`,
              status: 'awaiting_human',
              answered_at: null,
              questions_json: JSON.stringify([question(), question('q2')]),
              answers_json: JSON.stringify([answer()]),
              draft_answers_json: '{"q2":{"customText":"pending human input"}}',
            }),
          ])
      }
    const input = await integrationInput(h)
    try {
      const result = await convertIntegration(input)
      expect(result.summary.blocks).toEqual([])
      expect(result.summary.historyOnly).toEqual([])
      expect(result.sink.rows('tasks')).toHaveLength(89)
      expect(result.sink.rows('node_runs')).toHaveLength(178)
      expect(result.sink.rows('clarify_rounds')).toHaveLength(21)
      for (const [status, count] of [
        ['awaiting_human', 21],
        ['awaiting_review', 8],
        ['interrupted', 60],
      ] as const)
        expect(result.sink.rows('tasks').filter((row) => row.status === status)).toHaveLength(count)
      assertTaskDtos(result)
      assertClarifyReplay(result)
      expect(await assertRunOracle(result, runs)).toBe(0)
      expect(
        result.sink
          .rows('node_run_selections')
          .every((row) => String(row.selected_run_id).endsWith('-1')),
      ).toBe(true)
      expect(result.sink.rows('node_run_repo_checkpoints')).toHaveLength(178)
      expect(
        result.sink
          .rows('node_runs')
          .filter((row) => row.task_id === 'interrupted-00')
          .map((row) => row.seq)
          .sort(),
      ).toEqual([-1, 0])
    } finally {
      await input.source.close()
    }
  })
})
