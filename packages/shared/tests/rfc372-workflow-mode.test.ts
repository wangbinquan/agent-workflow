// RFC-372: format upgrades cannot opt existing tasks into a different human gate.
import { describe, expect, test } from 'bun:test'
import {
  ClarifyCrossAgentNodeSchema,
  ClarifyNodeSchema,
  WORKFLOW_SCHEMA_VERSION,
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  resolveClarifyInteractionMode,
} from '../src'

const mindmap = {
  categories: ['Scope', 'Dependencies'],
  instructions: 'Ask consequential questions first.',
}

describe('RFC-372 workflow mode and v7 format', () => {
  test('v1–v6 upgrade without changing nodes, templates, sessions or author input', () => {
    for (const version of [1, 2, 3, 4, 5, 6]) {
      const old = WorkflowDefinitionSchema.parse({
        $schema_version: version,
        nodes: [
          { id: 'self', kind: 'clarify', sessionMode: 'inline', clarifyMode: 'optional' },
          { id: 'cross', kind: 'clarify-cross-agent', sessionModeForQuestioner: 'isolated' },
        ],
        inputs: [],
        edges: [],
      })
      const savedBytes = JSON.stringify(old)
      const upgraded = migrateWorkflowDefinitionToLatest(old)
      expect(upgraded.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
      expect(upgraded.nodes).toEqual(old.nodes)
      expect(JSON.stringify(old)).toBe(savedBytes)
      for (const node of upgraded.nodes) {
        expect(resolveClarifyInteractionMode({ interactionMode: node.interactionMode })).toBe(
          'questions',
        )
        expect(node.mindmap).toBeUndefined()
      }
      expect(migrateWorkflowDefinitionToLatest(upgraded)).toBe(upgraded)
    }
  })
  test('both channel kinds require an explicit valid mindmap config', () => {
    for (const [schema, kind] of [
      [ClarifyNodeSchema, 'clarify'],
      [ClarifyCrossAgentNodeSchema, 'clarify-cross-agent'],
    ] as const) {
      expect(schema.safeParse({ id: 'gate', kind }).success).toBe(true)
      expect(schema.safeParse({ id: 'gate', kind, interactionMode: 'mindmap' }).success).toBe(false)
      expect(schema.safeParse({ id: 'gate', kind, interactionMode: 'unknown' }).success).toBe(false)
      const parsed = schema.parse({ id: 'gate', kind, interactionMode: 'mindmap', mindmap })
      expect(parsed.mindmap?.categories).toEqual(['Scope', 'Dependencies'])
      expect(parsed.mindmap?.instructions).toBe(mindmap.instructions)
      expect(
        schema.safeParse({ ...parsed, mindmap: { ...mindmap, categories: [''] } }).success,
      ).toBe(false)
      expect(resolveClarifyInteractionMode({ ...parsed, interactionMode: 'questions' })).toBe(
        'questions',
      )
    }
  })
  test('a v7 round trip retains category hints, never emits v6', () => {
    const definition = WorkflowDefinitionSchema.parse({
      $schema_version: 7,
      nodes: [{ id: 'gate', kind: 'clarify', interactionMode: 'mindmap', mindmap }],
    })
    const read = WorkflowDefinitionSchema.parse(JSON.parse(JSON.stringify(definition)))
    expect(migrateWorkflowDefinitionToLatest(read)).toEqual(definition)
    expect(WorkflowDefinitionSchema.safeParse({ ...definition, $schema_version: 8 }).success).toBe(
      false,
    )
  })
})
