// Deterministic protocol fixture, not model-quality evidence. All product state remains real.
import { writeFileSync } from 'node:fs'
import { readScenarioAnswers } from './mindmapDesignScenario'
import {
  parseInvocation,
  parseFlags,
  requireEnvelopeOpen,
  emitTextEvent,
  emitClarifyEvent,
  envelope,
} from './skeleton'

type ObjectValue = Record<string, unknown>
function objectAfter(text: string, marker: string): ObjectValue {
  const offset = marker ? text.lastIndexOf(marker) + marker.length : 0
  const start = text.indexOf('{', offset)
  let depth = 0,
    quoted = false,
    escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1)) as ObjectValue
  }
  throw new Error(`graph fixture input missing:${marker}`)
}
function proposed(input: ObjectValue, additional: boolean) {
  const source = (input.document ?? (input.materials as ObjectValue)?.document) as ObjectValue
  if (!source?.id || !source.caseId)
    throw new Error('graph fixture has no platform design identity')
  const sources = source.sources as ObjectValue[]
  const sourceIds = sources
    .filter((s) => s.kind === 'material')
    .slice(0, 1)
    .map((s) => s.id)
  const goal = (source.goals as string[])[0] ?? 'Development request'
  const document = {
    ...source,
    title: goal.split('\n')[0]!.slice(0, 180),
    elements: [
      {
        id: 'requirement',
        revision: 1,
        kind: 'requirement',
        label: 'Business requirement',
        description: goal,
        sourceIds,
        obligationIds: ['acceptance'],
      },
      ...(additional
        ? [
            {
              id: 'exception-rule',
              revision: 1,
              kind: 'constraint',
              label: 'Exception rule',
              description: 'Resolve the newly supplied exception',
              expression: 'priority is explicit',
              sourceIds,
            },
          ]
        : []),
    ],
    concerns: [
      {
        id: 'main',
        revision: 1,
        statement: goal.slice(0, 2000),
        purpose: 'implement',
        priority: 'required',
        disposition: 'addressed',
        resolutionIds: ['requirement'],
        sourceIds,
      },
      ...(additional
        ? [
            {
              id: 'exceptions',
              revision: 1,
              statement: 'New exception and priority concern',
              purpose: 'verify',
              priority: 'required',
              disposition: 'addressed',
              resolutionIds: ['exception-rule'],
              sourceIds,
            },
          ]
        : []),
    ],
    models: [
      {
        id: 'flow',
        revision: 1,
        kind: 'flow',
        label: 'Business flow',
        elementIds: ['requirement'],
        relationIds: [],
        sourceIds,
      },
      ...(additional
        ? [
            {
              id: 'rules',
              revision: 1,
              kind: 'decision-table',
              label: 'Exception rules',
              sourceIds,
              inputFields: ['priority'],
              rows: [
                {
                  id: 'normal',
                  ruleId: 'exception-rule',
                  priority: 1,
                  conditions: [],
                  output: { accepted: true },
                  assertionRefs: ['acceptance'],
                },
              ],
              resolution: 'unique',
            },
          ]
        : []),
    ],
    relations: [],
    obligations: [
      {
        id: 'acceptance',
        revision: 1,
        statement: 'Observe the requested behavior on the exact candidate',
        elementIds: ['requirement'],
        concernIds: ['main'],
        verification: {
          kind: 'manual',
          instructions: 'Read generated behavior and inspect the candidate',
          owner: null,
          when: null,
        },
      },
    ],
  }
  const candidate = (
    id: string,
    title: string,
    kind: string,
    modelId: string,
    elementId: string,
    concernId: string,
  ) => ({
    id,
    title,
    purpose: 'clarification',
    capabilityRef: { id: kind, version: 1 },
    modelIds: [modelId],
    elementIds: [elementId],
    relationIds: [],
    sourceIds,
    coverage: [{ concernId, contribution: 1, explanation: title }],
    readingCost: 1,
    generationCost: 1,
    rationale: title,
    limitations: ['Protocol fixture; not quality evidence'],
    replaces: [],
  })
  return {
    document,
    candidates: [
      candidate('overview', 'Business flow', 'flow', 'flow', 'requirement', 'main'),
      ...(additional
        ? [
            candidate(
              'exceptions-view',
              'Exception rules',
              'decision-table',
              'rules',
              'exception-rule',
              'exceptions',
            ),
          ]
        : []),
    ],
  }
}
export function run(argv: readonly string[]) {
  const call = parseInvocation(argv, 'stub-graph-development')
  if (call.kind === 'version') {
    process.stdout.write('1.0.0\n')
    return
  }
  const prompt = call.prompt
  if (!prompt.includes('INPUT_JSON') && prompt.includes('"outputSchema"')) {
    if (prompt.includes('rfc396-cancelable-call')) Bun.sleepSync(3000)
    const input = objectAfter(prompt, '')
    emitTextEvent(
      JSON.stringify({
        ...proposed(input, true),
        explanation: 'The new constraint needs a separate rules view; keep the pinned overview.',
      }),
    )
    return
  }
  const open = requireEnvelopeOpen(prompt, 'stub-graph-development')
  const input = objectAfter(prompt, '\nINPUT_JSON\n'),
    materials = input.materials as ObjectValue
  if (parseFlags(argv, ['--agent'])['--agent']?.includes('review-material')) {
    emitTextEvent(envelope(open.output, [['basis-document', String(materials.reviewDocumentPath)]]))
    return
  }
  if (materials.basis) {
    writeFileSync('graph-result.js', 'export const result = () => "implemented";\n')
    writeFileSync(
      'graph-result.test.js',
      'import { result } from "./graph-result.js";\nif (result() !== "implemented") throw new Error("graph-result-test");\n// graph-result-test\n',
    )
    emitTextEvent(
      envelope(open.output, [
        [
          'agent-result',
          JSON.stringify({
            summary: 'Generated candidate and tests',
            result: {
              traceProposals: [
                {
                  elementId: 'requirement',
                  obligationId: 'acceptance',
                  path: 'graph-result.js',
                  symbol: 'result',
                  testRef: 'graph-result.test.js#graph-result-test',
                  reason: 'Candidate file and executable test',
                },
              ],
              testRefs: ['graph-result.test.js#graph-result-test'],
              limitations: [],
              deliveryContent: {
                commitMessage: 'Implement graph fixture',
                title: 'Graph fixture',
                description: 'Deterministic protocol fixture',
              },
            },
          }),
        ],
      ]),
    )
    return
  }
  if (prompt.includes('\nCOMMITTED_DESIGN_JSON\n')) {
    const result = objectAfter(prompt, '\nCOMMITTED_DESIGN_JSON\n')
    if (readScenarioAnswers(prompt).size === 0) {
      const document = (result.result as ObjectValue).document as ObjectValue
      emitClarifyEvent(
        open.clarify,
        JSON.stringify({
          questions: [
            {
              id: 'exception',
              title: 'How should exceptions be handled?',
              description: 'Keep responsibility unknown if undecided.',
              kind: 'single',
              options: [
                { label: 'Keep it explicit', description: 'Retain the provisional decision' },
                { label: 'Defer the change', description: 'Preserve current behavior' },
              ],
              mindmap: { categoryPath: ['约束与验收'] },
              artifactAnchor: {
                artifactRef: document.id,
                elementIds: ['requirement'],
                relationIds: [],
                viewId: 'overview',
              },
            },
          ],
        }),
      )
      return
    }
    emitTextEvent(envelope(open.output, [['agent-result', JSON.stringify(result)]]))
    return
  }
  const result = JSON.stringify({
    summary: 'Committed design before clarification',
    result: proposed(input, false),
  })
  emitTextEvent(
    envelope(open.output, [
      ['design-model', result],
      ['agent-result', result],
    ]),
  )
}
