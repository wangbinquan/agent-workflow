// RFC-020 T5: workflow validator rejects malformed kind: 'upload' inputs.

import { describe, expect, test } from 'bun:test'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { validateWorkflowDef } from '../src/services/workflow.validator'

function defWithUpload(overrides: Record<string, unknown>): WorkflowDefinition {
  return {
    $schema_version: 2,
    inputs: [
      {
        kind: 'upload',
        key: 'refs',
        label: 'refs',
        ...overrides,
      } as unknown as WorkflowDefinition['inputs'][number],
    ],
    nodes: [
      { id: 'in_refs', kind: 'input', inputKey: 'refs' } as WorkflowDefinition['nodes'][number],
    ],
    edges: [],
  }
}

describe('validateWorkflowDef upload inputs (RFC-020)', () => {
  test('happy path: valid targetDir is accepted', () => {
    const r = validateWorkflowDef(defWithUpload({ targetDir: 'inputs/refs' }), {
      agents: [],
      skills: [],
    })
    const codes = r.issues.map((i) => i.code)
    expect(codes).not.toContain('upload-input-target-dir-missing')
    expect(codes).not.toContain('upload-input-target-dir-invalid')
  })

  test('rejects missing targetDir', () => {
    const r = validateWorkflowDef(defWithUpload({}), { agents: [], skills: [] })
    const issue = r.issues.find((i) => i.code === 'upload-input-target-dir-missing')
    expect(issue).toBeDefined()
    expect(issue?.severity ?? 'error').toBe('error')
    expect(r.ok).toBe(false)
  })

  test('rejects targetDir with ".."', () => {
    const r = validateWorkflowDef(defWithUpload({ targetDir: '../escape' }), {
      agents: [],
      skills: [],
    })
    const issue = r.issues.find((i) => i.code === 'upload-input-target-dir-invalid')
    expect(issue).toBeDefined()
    expect(r.ok).toBe(false)
  })

  test('rejects absolute targetDir', () => {
    const r = validateWorkflowDef(defWithUpload({ targetDir: '/etc' }), {
      agents: [],
      skills: [],
    })
    const issue = r.issues.find((i) => i.code === 'upload-input-target-dir-invalid')
    expect(issue).toBeDefined()
  })

  test('rejects Windows drive-prefix targetDir', () => {
    const r = validateWorkflowDef(defWithUpload({ targetDir: 'C:\\Users\\foo' }), {
      agents: [],
      skills: [],
    })
    const issue = r.issues.find((i) => i.code === 'upload-input-target-dir-invalid')
    expect(issue).toBeDefined()
  })

  test('non-upload inputs are untouched', () => {
    const r = validateWorkflowDef(
      {
        $schema_version: 2,
        inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
        nodes: [
          {
            id: 'in_topic',
            kind: 'input',
            inputKey: 'topic',
          } as WorkflowDefinition['nodes'][number],
        ],
        edges: [],
      },
      { agents: [], skills: [] },
    )
    const codes = r.issues.map((i) => i.code)
    expect(codes).not.toContain('upload-input-target-dir-missing')
    expect(codes).not.toContain('upload-input-target-dir-invalid')
  })
})

// RFC-262: `onConflict` 与 targetDir 同为「写面 schema + 静态校验」双门——
// 靠别的路径进了库的定义要在画布校验面板里被指出来，而不是拖到启动才炸。
describe('validateWorkflowDef upload onConflict (RFC-262)', () => {
  const ctx = { agents: [], skills: [] }

  test('缺省不报（存量定义原样通过）', () => {
    const r = validateWorkflowDef(defWithUpload({ targetDir: 'inputs' }), ctx)
    expect(r.issues.map((i) => i.code)).not.toContain('upload-input-on-conflict-invalid')
  })

  test('两个合法值都不报', () => {
    for (const onConflict of ['rename', 'overwrite']) {
      const r = validateWorkflowDef(defWithUpload({ targetDir: 'inputs', onConflict }), ctx)
      expect(r.issues.map((i) => i.code)).not.toContain('upload-input-on-conflict-invalid')
    }
  })

  test('未知字符串 → upload-input-on-conflict-invalid（error，工作流不可用）', () => {
    const r = validateWorkflowDef(
      defWithUpload({ targetDir: 'inputs', onConflict: 'replace' }),
      ctx,
    )
    const issue = r.issues.find((i) => i.code === 'upload-input-on-conflict-invalid')
    expect(issue).toBeDefined()
    expect(issue?.severity ?? 'error').toBe('error')
    expect(r.ok).toBe(false)
  })

  test('非字符串同样被拒（readString 会静默吞掉它，所以读的是原值）', () => {
    const r = validateWorkflowDef(defWithUpload({ targetDir: 'inputs', onConflict: true }), ctx)
    expect(r.issues.find((i) => i.code === 'upload-input-on-conflict-invalid')).toBeDefined()
    expect(r.ok).toBe(false)
  })
})
