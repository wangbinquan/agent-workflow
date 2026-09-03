// Regression: platform-owned workflow snapshots used to reach the task canvas
// without canonical positions. Complex digital-employee hosts then fell back to
// the legacy index grid, where cards and long review branches crowded/covered
// one another. Built-ins are presentation-owned by the platform, so every read
// gets the shared deterministic layout; ordinary user workflow geometry stays
// byte-for-byte untouched.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  DEFAULT_NODE_SIZE_BY_KIND,
  WorkflowDefinitionSchema,
  type WorkgroupRuntimeConfig,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import {
  synthesizeDigitalEmployeeHostSnapshot,
  synthesizeDigitalEmployeeScriptHostSnapshot,
  synthesizeReviewedDigitalEmployeeHostSnapshot,
} from '@/modules/task-execution/domain/digitalEmployeeHost'
import { createInMemoryDb } from '@/db/client'
import { workflows } from '@/db/schema'
import { composeSqliteFusionPersistence } from '@/modules/knowledge-evolution/composition/fusion'
import { buildAgentHostSnapshot } from '@/services/agentLaunch'
import { synthesizeCodeRoundSnapshot } from '@/services/codeRoundContract'
import { seedFusionResources } from '@/modules/knowledge-evolution/application/fusionOrchestration'
import { buildDynamicWorkflowGenerateSnapshot } from '@/services/orchestratorAgent'
import { layoutBuiltinWorkflowSnapshotJson, projectWorkflowSnapshotForRead } from '@/services/task'
import { buildWorkgroupHostSnapshot } from '@/services/workgroup/launch'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function withoutGeometry(definition: WorkflowDefinition): unknown {
  return {
    ...definition,
    nodes: definition.nodes.map(({ position: _position, ...node }) => node),
  }
}

function expectNoNodeOverlap(definition: WorkflowDefinition): void {
  for (const [index, left] of definition.nodes.entries()) {
    expect(left.position, `node ${left.id} must have a canonical position`).toBeDefined()
    if (left.position === undefined) continue
    const leftSize = DEFAULT_NODE_SIZE_BY_KIND[left.kind]
    for (const right of definition.nodes.slice(index + 1)) {
      expect(right.position, `node ${right.id} must have a canonical position`).toBeDefined()
      if (right.position === undefined) continue
      const rightSize = DEFAULT_NODE_SIZE_BY_KIND[right.kind]
      const separated =
        left.position.x + leftSize.width <= right.position.x ||
        right.position.x + rightSize.width <= left.position.x ||
        left.position.y + leftSize.height <= right.position.y ||
        right.position.y + rightSize.height <= left.position.y
      expect(separated, `${left.id} overlaps ${right.id}`).toBe(true)
    }
  }
}

function reviewedHost(): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse(
    synthesizeReviewedDigitalEmployeeHostSnapshot({
      planAgentId: 'builtin-plan-agent',
      planAgentName: 'Implementation planning',
      implementationAgentId: 'builtin-implementation-agent',
      implementationAgentName: 'Implementation',
      artifactPort: 'analysis-plan',
      documentPath: '.agent-workflow/reviews/implementation-plan.md',
      reviewTitle: '实现方案评审',
      reviewDescription: '批准后才开始修改代码。',
    }),
  )
}

const workgroupConfig: WorkgroupRuntimeConfig = {
  workgroupId: 'wg-1',
  workgroupName: 'Built-in host group',
  mode: 'leader_worker',
  leaderMemberId: 'leader',
  switches: { shareOutputs: true, directMessages: false, blackboard: false },
  maxRounds: 3,
  completionGate: false,
  instructions: 'Coordinate the work.',
  goal: 'Finish the task.',
  members: [
    {
      id: 'leader',
      memberType: 'agent',
      agentId: 'agent-leader',
      agentName: 'leader-agent',
      userId: null,
      displayName: 'Leader',
      roleDesc: 'Lead',
    },
    {
      id: 'member',
      memberType: 'agent',
      agentId: 'agent-member',
      agentName: 'member-agent',
      userId: null,
      displayName: 'Member',
      roleDesc: 'Implement',
    },
  ],
}

describe('built-in workflow automatic layout', () => {
  test('legacy built-in task snapshots get deterministic non-overlapping display geometry', () => {
    const original = reviewedHost()
    expect(original.nodes.every((node) => node.position === undefined)).toBe(true)
    const first = projectWorkflowSnapshotForRead(original, true)
    const laidOut = WorkflowDefinitionSchema.parse(first)

    expect(first).not.toBe(original)
    expectNoNodeOverlap(laidOut)
    expect(withoutGeometry(laidOut)).toEqual(withoutGeometry(original))
    // Fixed-root layout is idempotent: repeated route serialization neither
    // drifts coordinates nor allocates another definition object.
    expect(projectWorkflowSnapshotForRead(first, true)).toBe(first)
  })

  test('invalid snapshots stay untouched and historical extensions survive layout', () => {
    const invalid = { nodes: [] }
    expect(projectWorkflowSnapshotForRead(invalid, true)).toBe(invalid)

    const extended = {
      ...reviewedHost(),
      migrationMarker: 'legacy-built-in',
    }
    const laidOut = projectWorkflowSnapshotForRead(extended, true) as typeof extended
    expect(laidOut.migrationMarker).toBe('legacy-built-in')
    expectNoNodeOverlap(WorkflowDefinitionSchema.parse(laidOut))
  })

  test('ordinary workflow snapshots retain authored geometry exactly', () => {
    const original = reviewedHost()
    expect(projectWorkflowSnapshotForRead(original, false)).toBe(original)
  })

  test('the task-freeze boundary covers every platform built-in host shape', () => {
    const snapshots: ReadonlyArray<readonly [string, string]> = [
      [
        'single agent',
        JSON.stringify(buildAgentHostSnapshot({ id: 'agent-1', name: 'Agent 1' }, true)),
      ],
      ['workgroup', JSON.stringify(buildWorkgroupHostSnapshot(workgroupConfig))],
      ['dynamic-workflow orchestrator', JSON.stringify(buildDynamicWorkflowGenerateSnapshot())],
      [
        'code round',
        synthesizeCodeRoundSnapshot({ capability: 'review', roundSeq: 1, title: 'Review' }),
      ],
      [
        'digital employee agent',
        JSON.stringify(
          synthesizeDigitalEmployeeHostSnapshot({ agentId: 'agent-2', agentName: 'Agent 2' }),
        ),
      ],
      ['digital employee reviewed agent', JSON.stringify(reviewedHost())],
      [
        'digital employee program',
        JSON.stringify(
          synthesizeDigitalEmployeeScriptHostSnapshot({
            inputPort: 'contract_input',
            language: 'bash',
            script: 'printf ok',
            dependencies: [],
            env: {},
            readonly: true,
          }),
        ),
      ],
    ]

    for (const [name, snapshot] of snapshots) {
      const laidOut = WorkflowDefinitionSchema.parse(
        JSON.parse(layoutBuiltinWorkflowSnapshotJson(snapshot)),
      )
      expect(laidOut.nodes.length, `${name} must exercise a real host node`).toBeGreaterThan(0)
      expectNoNodeOverlap(laidOut)
    }
  })

  test('the persisted built-in seeder lays out new rows and repairs legacy geometry once', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const fusion = composeSqliteFusionPersistence({ db, appHome: '/tmp' })
    await seedFusionResources(fusion)
    const first = db.select().from(workflows).where(eq(workflows.builtin, true)).get()!
    const firstDefinition = WorkflowDefinitionSchema.parse(JSON.parse(first.definition))
    expectNoNodeOverlap(firstDefinition)

    const legacyDefinition = {
      ...firstDefinition,
      nodes: firstDefinition.nodes.map((node) => ({ ...node, position: { x: 0, y: 0 } })),
    }
    db.update(workflows)
      .set({ definition: JSON.stringify(legacyDefinition) })
      .where(eq(workflows.id, first.id))
      .run()

    await seedFusionResources(fusion)
    const repaired = db.select().from(workflows).where(eq(workflows.id, first.id)).get()!
    expect(repaired.version).toBe(first.version + 1)
    expectNoNodeOverlap(WorkflowDefinitionSchema.parse(JSON.parse(repaired.definition)))

    await seedFusionResources(fusion)
    expect(db.select().from(workflows).where(eq(workflows.id, first.id)).get()!.version).toBe(
      repaired.version,
    )
  })
})
