// RFC-490 (design §2.1): the built-in graph-development agents are immutable once
// published. At boot an installed copy is compared with the shipped text byte for byte
// (`builtinCatalog`: `graph-builtin-agent-content-conflict`), so any schema change that
// leaks into one of these prompts stops every existing install from starting.
//
// RFC-490 widened the clarify decision status with "deferred" and "not-applicable". The
// design schema printed in the designer and clarifier prompts embeds that status, and the
// first implementation changed both prompts without anyone touching them. The digests
// below are the texts shipped in v0.19.3 (taken from a clean export of that tag); the
// document schema itself accepts the new values, because a skipped answer is imported as
// a human source.
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { GraphElementSchema, GraphSourceSchema } from '@agent-workflow/shared'
import {
  GRAPH_BUILTIN_AGENTS,
  GRAPH_BUILTIN_IDS,
  graphOutputInstructions,
} from '@/modules/development-automation/application/graph-development/builtinResources'
import { graphToolResultSchema } from '@/modules/development-automation/application/graph-development/toolContracts'
import { toInputJsonSchema } from '@/util/zodJsonSchema'

const PUBLISHED: Record<string, string> = {
  [GRAPH_BUILTIN_IDS.designer]: '66cf9ae4f1fbd4c95735ff1624ab6ee4e4cc78da9c72652b77fc38caecd5fa76',
  [GRAPH_BUILTIN_IDS.clarifier]: '8a9dd8868c5f49188fc24f2883d475e787defdabbd687991c7e835d1eb6baa01',
  [GRAPH_BUILTIN_IDS.reviewer]: '66a60ad2bc521bccfc524a8cf22fc3e9c469f1d531fc5fbaef4df0321633caf0',
  [GRAPH_BUILTIN_IDS.implementer]:
    '3529c3428be9041339bbaeefbe24dfc02a6e987ea53cc085d17ebdb45eea59a9',
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

describe('RFC-490 published graph prompts', () => {
  test('every built-in agent prompt is byte for byte what v0.19.3 installed', () => {
    expect(
      Object.fromEntries(
        GRAPH_BUILTIN_AGENTS.map((agent) => [agent.id, sha256(agent.definition.bodyMd)]),
      ),
    ).toEqual(PUBLISHED)
  })

  test('the printed design schema keeps its two published statuses; validation accepts four', () => {
    const printed = graphOutputInstructions('design-and-clarify')
    // Once on the imported clarify source, once on the decision element.
    expect(printed.match(/"enum":\["decided","provisional"\]/g)).toHaveLength(2)
    expect(printed).not.toContain('not-applicable')
    const validated = JSON.stringify(toInputJsonSchema(graphToolResultSchema('design-and-clarify')))
    expect(
      validated.match(/"enum":\["decided","provisional","deferred","not-applicable"\]/g),
    ).toHaveLength(2)
    // Narrowing those two enums is the only difference between what is printed and what
    // is enforced.
    expect(
      validated.replaceAll(
        '"enum":["decided","provisional","deferred","not-applicable"]',
        '"enum":["decided","provisional"]',
      ),
    ).toBe(printed.split('\n')[1]!)
    // Prompts without a clarify decision are printed exactly as they are enforced.
    for (const item of ['implement-change', 'review-design'] as const)
      expect(graphOutputInstructions(item).split('\n')[1]).toBe(
        JSON.stringify(toInputJsonSchema(graphToolResultSchema(item))),
      )
  })

  test('a skipped answer is a valid human source, and a decision element may carry it', () => {
    for (const status of ['not-applicable', 'deferred'] as const) {
      const decision = { status, rationale: 'Single region only' }
      expect(
        GraphSourceSchema.parse({
          id: 'source-1',
          kind: 'clarify',
          taskId: 'task-1',
          roundId: 'round-1',
          questionId: 'q1',
          confirmedBasis: null,
          // Nothing was chosen or written: the status is the whole answer.
          originalAnswer: '',
          answer: { selectedOptionIndices: [], selectedOptionLabels: [], customText: '' },
          decision,
        }),
      ).toMatchObject({ decision })
      expect(
        GraphElementSchema.parse({
          id: 'decision-1',
          revision: 1,
          label: 'Cross-region replication',
          description: '',
          sourceIds: ['source-1'],
          kind: 'decision',
          decision,
        }),
      ).toMatchObject({ decision })
    }
  })
})
