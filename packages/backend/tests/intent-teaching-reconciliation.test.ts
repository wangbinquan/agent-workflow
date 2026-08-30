// RFC-348 D2 — platform ⇔ intent field reconciliation (design §1.4).
//
// Rule 1: every entry compares ONE level of key names in both directions
//         (renamed / excluded / intent-only are the only escape hatches).
// Rule 2: every OBJECT node in the six platform create-schema trees — and in
//         the six intent payload trees — is claimed by exactly one entry, sits
//         inside an excluded (intent-only) subtree, or is listed as uncovered
//         with a reason. Exactly one of the three.
// Rule 3: the checks themselves are proven live by injecting drift.
//
// The baselines below are today's trees; a platform field the intent contract
// never learned (the RFC-348 `branchPorts` incident) fails rule 1, a new nested
// object fails rule 2.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  CreateAgentSchema,
  CreateWorkgroupSchema,
  IntentAgentPayloadSchema,
  McpRemoteConfigSchema,
  WorkgroupMemberInputSchema,
} from '@agent-workflow/shared'
import {
  DEFAULT_RECONCILIATION_INPUT,
  INTENT_PAYLOAD_SCHEMAS,
  INTENT_PLATFORM_FIELD_RECONCILIATION,
  PLATFORM_CREATE_SCHEMAS,
  RECONCILIATION_UNCOVERED_INTENT_OBJECTS,
  RECONCILIATION_UNCOVERED_PLATFORM_OBJECTS,
  checkKeyReconciliation,
  checkObjectCoverage,
  reconcile,
  walkObjectNodes,
  type ReconciliationEntry,
} from '../src/modules/intent/domain/teaching/reconciliation'

const entryById = (id: string): ReconciliationEntry => {
  const entry = INTENT_PLATFORM_FIELD_RECONCILIATION.find((e) => e.id === id)
  if (entry === undefined) throw new Error(`no entry ${id}`)
  return entry
}

const PLATFORM_OBJECT_BASELINE: Record<string, string[]> = {
  agent: ['', 'inputs[]', 'skills[]<managed>', 'skills[]<project>'],
  skill: [''],
  mcp: ['<local>', '<local>.config', '<remote>', '<remote>.config', '<remote>.config.oauth'],
  plugin: [''],
  workflow: [
    '',
    'definition',
    'definition.inputs[]',
    'definition.nodes[]',
    'definition.nodes[].position',
    'definition.edges[]',
    'definition.edges[].source',
    'definition.edges[].target',
    'definition.outputs[]',
    'definition.outputs[].bind',
  ],
  workgroup: ['', 'members[]', 'switches'],
}

const INTENT_OBJECT_BASELINE: Record<string, string[]> = {
  agent: ['', 'inputs[]', 'skills[]'],
  skill: ['', 'files[]'],
  mcp: ['<local>', '<local>.config', '<remote>', '<remote>.config', '<remote>.config.oauth'],
  plugin: [''],
  workflow: ['', 'definition', 'definition.nodes[]'],
  workgroup: ['', 'members[]<agent>', 'members[]<human>', 'switches'],
}

describe('RFC-348 — platform ⇔ intent reconciliation', () => {
  test("today's schemas reconcile with zero violations", () => {
    expect(reconcile()).toEqual([])
  })

  test('table shape baselines: 29 entries, 24 platform / 18 intent object nodes, 9 tree-external pairs', () => {
    expect(INTENT_PLATFORM_FIELD_RECONCILIATION.length).toBe(29)
    expect(new Set(INTENT_PLATFORM_FIELD_RECONCILIATION.map((e) => e.id)).size).toBe(29)
    const external = INTENT_PLATFORM_FIELD_RECONCILIATION.filter(
      (e) => e.platform.paths.length === 0,
    )
    expect(external.map((e) => e.id).sort()).toEqual(
      [
        'workflow.inputs[upload]',
        'workflow.nodes[review]',
        'workflow.nodes[clarify]',
        'workflow.nodes[clarify-cross-agent]',
        'workflow.nodes[wrapper-fanout]',
        'workflow.nodes[call-workflow]',
        'workflow.nodes[call-workgroup]',
        'workflow.nodes[script]',
        'workflow.nodes[code-host-call]',
      ].sort(),
    )
    let platformTotal = 0
    for (const [type, schema] of Object.entries(PLATFORM_CREATE_SCHEMAS)) {
      const paths = walkObjectNodes(schema)
        .map((n) => n.path)
        .sort()
      expect(paths, `platform ${type}`).toEqual([...(PLATFORM_OBJECT_BASELINE[type] ?? [])].sort())
      platformTotal += paths.length
    }
    expect(platformTotal).toBe(24)
    let intentTotal = 0
    for (const [type, schema] of Object.entries(INTENT_PAYLOAD_SCHEMAS)) {
      const paths = walkObjectNodes(schema)
        .map((n) => n.path)
        .sort()
      expect(paths, `intent ${type}`).toEqual([...(INTENT_OBJECT_BASELINE[type] ?? [])].sort())
      intentTotal += paths.length
    }
    expect(intentTotal).toBe(18)
    expect(Object.keys(RECONCILIATION_UNCOVERED_PLATFORM_OBJECTS)).toEqual([
      'agent.skills[]<managed>',
    ])
    expect(Object.keys(RECONCILIATION_UNCOVERED_INTENT_OBJECTS)).toEqual([])
  })

  test('the RFC-348 drifts are now paired: branchPorts, oauth, timeoutMs, permission, runtime', () => {
    const agentRoot = entryById('agent.root')
    for (const key of ['branchPorts', 'permission', 'runtime']) {
      expect(
        Object.keys((agentRoot.platform.schema as z.ZodObject<z.ZodRawShape>).shape),
      ).toContain(key)
    }
    expect(entryById('mcp.remote.config.oauth').platform.paths).toEqual(['<remote>.config.oauth'])
    expect(entryById('mcp.local.config').platform.paths).toEqual(['<local>.config'])
  })

  describe('rule 1 reverse checks (a copy of the schema with drift injected must be reported)', () => {
    test('top-level platform key', () => {
      const entry = entryById('agent.root')
      const mutated: ReconciliationEntry = {
        ...entry,
        platform: { ...entry.platform, schema: CreateAgentSchema.extend({ zzzFake: z.string() }) },
      }
      expect(checkKeyReconciliation([mutated]).join('\n')).toContain("platform key 'zzzFake'")
    })
    test('nested platform key', () => {
      const entry = entryById('mcp.remote.config')
      const mutated: ReconciliationEntry = {
        ...entry,
        platform: {
          ...entry.platform,
          schema: McpRemoteConfigSchema.extend({ zzzFake: z.string() }),
        },
      }
      expect(checkKeyReconciliation([mutated]).join('\n')).toContain("platform key 'zzzFake'")
    })
    test('variant key (platform member object vs both intent variants)', () => {
      const entry = entryById('workgroup.members[]')
      const mutated: ReconciliationEntry = {
        ...entry,
        platform: {
          ...entry.platform,
          schema: WorkgroupMemberInputSchema.innerType().extend({ zzzFake: z.string() }),
        },
      }
      const report = checkKeyReconciliation([mutated])
      expect(report.some((line) => line.startsWith('workgroup.members[]<agent>'))).toBe(true)
      expect(report.some((line) => line.startsWith('workgroup.members[]<human>'))).toBe(true)
    })
    test('intent-side key without a platform counterpart', () => {
      const entry = entryById('agent.root')
      const mutated: ReconciliationEntry = {
        ...entry,
        intent: { paths: [''], schema: IntentAgentPayloadSchema.extend({ zzzFake: z.string() }) },
      }
      expect(checkKeyReconciliation([mutated]).join('\n')).toContain("intent key 'zzzFake'")
    })
    test('a bogus rename / exclusion is itself reported', () => {
      const entry = entryById('plugin.root')
      const mutated: ReconciliationEntry = { ...entry, excluded: { zzzFake: 'nope' } }
      expect(checkKeyReconciliation([mutated]).join('\n')).toContain(
        "excluded key 'zzzFake' is not a platform key",
      )
    })
  })

  describe('rule 2 reverse checks (object coverage ratchet)', () => {
    test('an unregistered nested platform object is reported', () => {
      const report = checkObjectCoverage({
        ...DEFAULT_RECONCILIATION_INPUT,
        platformSchemas: {
          ...PLATFORM_CREATE_SCHEMAS,
          agent: CreateAgentSchema.extend({ retryPolicy: z.object({ max: z.number() }) }),
        },
      })
      expect(report.join('\n')).toContain("platform object 'agent.retryPolicy' is not claimed")
    })
    test('an unregistered nested intent object is reported', () => {
      const report = checkObjectCoverage({
        ...DEFAULT_RECONCILIATION_INPUT,
        intentSchemas: {
          ...INTENT_PAYLOAD_SCHEMAS,
          agent: IntentAgentPayloadSchema.extend({ retryPolicy: z.object({ max: z.number() }) }),
        },
      })
      expect(report.join('\n')).toContain("intent object 'agent.retryPolicy' is not claimed")
    })
    test('removing a real entry leaves its object unclaimed', () => {
      const report = checkObjectCoverage({
        ...DEFAULT_RECONCILIATION_INPUT,
        entries: INTENT_PLATFORM_FIELD_RECONCILIATION.filter((e) => e.id !== 'workgroup.switches'),
      })
      expect(report.join('\n')).toContain("platform object 'workgroup.switches' is not claimed")
    })
    test('claiming an object twice, or listing a claimed object as uncovered, is reported', () => {
      const duplicate: ReconciliationEntry = {
        ...entryById('agent.inputs[]'),
        id: 'agent.inputs[]#dup',
      }
      const twice = checkObjectCoverage({
        ...DEFAULT_RECONCILIATION_INPUT,
        entries: [...INTENT_PLATFORM_FIELD_RECONCILIATION, duplicate],
      })
      expect(twice.join('\n')).toContain("'agent.inputs[]' is claimed by several entries")
      const listed = checkObjectCoverage({
        ...DEFAULT_RECONCILIATION_INPUT,
        uncoveredPlatform: {
          ...RECONCILIATION_UNCOVERED_PLATFORM_OBJECTS,
          'workgroup.switches': 'bogus',
        },
      })
      expect(listed.join('\n')).toContain("'workgroup.switches' is claimed more than one way")
    })
    test('the walker sees through effects / optional / default and labels union options', () => {
      const paths = walkObjectNodes(CreateWorkgroupSchema).map((n) => n.path)
      expect(paths).toContain('')
      expect(paths).toContain('members[]')
      expect(walkObjectNodes(IntentAgentPayloadSchema).map((n) => n.path)).toContain('skills[]')
    })
  })
})
