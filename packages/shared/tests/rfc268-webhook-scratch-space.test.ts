// RFC-268 — webhook 临时工作区的共享 wire 契约。
import { describe, expect, test } from 'bun:test'

import { webhookPayloadTemplateSchemaFor, type WebhookLaunchKind } from '../src'

const TEMPLATES: ReadonlyArray<{
  kind: WebhookLaunchKind
  payload: Record<string, unknown>
}> = [
  { kind: 'workflow', payload: { inputs: {} } },
  { kind: 'agent', payload: { description: '处理 {{event_type}}' } },
  { kind: 'workgroup', payload: { goal: '处理 {{event_type}}' } },
]

describe('RFC-268 · webhook scratch payload contract', () => {
  test('workflow / agent / workgroup 都接受 scratch:true；缺省仍是事件仓库', () => {
    for (const { kind, payload } of TEMPLATES) {
      const eventRepo = webhookPayloadTemplateSchemaFor(kind).parse(payload)
      expect(eventRepo.scratch).toBeUndefined()

      const scratch = webhookPayloadTemplateSchemaFor(kind).parse({ ...payload, scratch: true })
      expect(scratch.scratch).toBe(true)
    }
  })

  test('scratch:false 被拒绝，避免持久化双重默认值', () => {
    for (const { kind, payload } of TEMPLATES) {
      expect(
        webhookPayloadTemplateSchemaFor(kind).safeParse({ ...payload, scratch: false }).success,
      ).toBe(false)
    }
  })

  test('scratch 与远端分支 / 推送选项冲突（autoCommitPush=false 也必须拒绝）', () => {
    for (const { kind, payload } of TEMPLATES) {
      for (const conflict of [
        { workingBranch: 'automation/{{branch}}' },
        { autoCommitPush: true },
        { autoCommitPush: false },
      ]) {
        const result = webhookPayloadTemplateSchemaFor(kind).safeParse({
          ...payload,
          scratch: true,
          ...conflict,
        })
        expect(result.success).toBe(false)
        if (!result.success) {
          expect(
            result.error.issues.some((issue) => issue.message === 'scratch-remote-only-option'),
          ).toBe(true)
        }
      }
    }
  })

  test('scratch 不放宽事件仓库来源字段', () => {
    for (const { kind, payload } of TEMPLATES) {
      for (const source of [
        { repoUrl: 'https://example.invalid/repo.git' },
        { cachedRepoId: 'repo-1' },
        { repoGroupId: 'group-1' },
        { sourceTaskId: 'task-1' },
        { ref: 'main' },
      ]) {
        expect(
          webhookPayloadTemplateSchemaFor(kind).safeParse({
            ...payload,
            scratch: true,
            ...source,
          }).success,
        ).toBe(false)
      }
    }
  })
})
