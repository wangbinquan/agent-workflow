import { describe, expect, test } from 'bun:test'
import type { WorkflowInput } from '@agent-workflow/shared'
import {
  assertWorkflowLaunchInputs,
  workflowLaunchInputIssues,
} from '../src/services/workflowLaunchInputs'

const defs: WorkflowInput[] = [
  { kind: 'text', key: 'topic', label: 'Topic', required: true, maxLength: 20 },
  {
    kind: 'files',
    key: 'docs',
    label: 'Docs',
    required: false,
    minCount: 2,
    maxCount: 3,
  },
  {
    kind: 'enum',
    key: 'mode',
    label: 'Mode',
    required: true,
    choices: ['fast', 'thorough'],
  },
  {
    kind: 'enum',
    key: 'tags',
    label: 'Tags',
    multiSelect: true,
    choices: ['api', 'ui', 'docs'],
  },
  {
    kind: 'git',
    key: 'range',
    label: 'Range',
    required: true,
    gitKind: 'commit-range',
  },
  {
    kind: 'upload',
    key: 'attachments',
    label: 'Attachments',
    targetDir: 'inputs/attachments',
    required: true,
    minCount: 2,
    maxCount: 2,
  },
]

function codes(inputs: Record<string, string>): string[] {
  return workflowLaunchInputIssues(defs, inputs).map((issue) => `${issue.key}:${issue.code}`)
}

describe('workflow launch input service gate', () => {
  test('accepts every picker wire format, including packed upload paths', () => {
    expect(() =>
      assertWorkflowLaunchInputs(defs, {
        topic: 'matrix',
        docs: 'docs/a.md\ndocs/b.md',
        mode: 'thorough',
        tags: '["api","docs"]',
        range: '{"kind":"commit-range","from":"main","to":"HEAD"}',
        attachments: 'inputs/attachments/a.md\ninputs/attachments/b.md',
      }),
    ).not.toThrow()
  })

  test('missing required values and count floors cannot degrade to empty input-node outputs', () => {
    expect(
      codes({
        topic: ' ',
        docs: 'docs/a.md',
        mode: '',
        tags: '',
        range: '',
        attachments: '',
      }),
    ).toEqual([
      'topic:required-input-missing',
      'docs:input-count-too-small',
      'mode:required-input-missing',
      'range:required-input-missing',
      'attachments:required-input-missing',
    ])
  })

  test('rejects unknown keys, invisible enum values, malformed multi-enum, and wrong git shapes', () => {
    const issues = workflowLaunchInputIssues(defs, {
      topic: 'matrix',
      docs: 'a\nb\nc\nd',
      mode: 'hidden',
      tags: 'not-json',
      range: '{"kind":"branch","ref":"main"}',
      attachments: 'a\nb\nc',
      stale: 'value',
    })
    expect(issues.map((issue) => `${issue.key}:${issue.code}`).sort()).toEqual(
      [
        'attachments:input-count-too-large',
        'docs:input-count-too-large',
        'mode:enum-value-invalid',
        'range:git-value-invalid',
        'stale:unknown-input',
        'tags:enum-value-invalid',
      ].sort(),
    )
  })

  test('multipart preflight skips upload values only; final validation still enforces them', () => {
    const nonUploadInputs = {
      topic: 'matrix',
      docs: 'docs/a.md\ndocs/b.md',
      mode: 'fast',
      tags: '[]',
      range: '{"kind":"commit-range","from":"main","to":"HEAD"}',
    }
    expect(() =>
      assertWorkflowLaunchInputs(defs, nonUploadInputs, { ignoreUploadInputs: true }),
    ).not.toThrow()
    expect(() => assertWorkflowLaunchInputs(defs, nonUploadInputs)).toThrow(
      /workflow launch inputs failed validation/,
    )
  })
})
