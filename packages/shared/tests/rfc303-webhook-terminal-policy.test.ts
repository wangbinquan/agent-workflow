// RFC-303 — terminal-control trigger policy is an opt-in closed contract.
// This test intentionally locks both the public default and every conflicting
// eventTypes combination so a future schema refactor cannot silently turn
// terminal control back into a terminal launch.
import { describe, expect, test } from 'bun:test'

import {
  CreateWebhookTriggerSchema,
  UpdateWebhookTriggerSchema,
  WEBHOOK_TRIGGER_TERMINAL_POLICY_CONFLICT,
  WebhookTriggerSchema,
  webhookTriggerTerminalPolicyIssue,
} from '../src'

const base = {
  name: 'MR review',
  endpointId: 'endpoint-1',
  repoScope: { kind: 'all' as const },
  eventTypes: ['mr_opened'] as const,
  launchKind: 'agent' as const,
  launchRefId: 'agent-1',
  launchPayload: { description: 'review' },
}

describe('RFC-303 trigger terminal policy', () => {
  test('create defaults cancelOnMrTerminal to false and wire requires the projected boolean', () => {
    const parsed = CreateWebhookTriggerSchema.parse(base)
    expect(parsed.cancelOnMrTerminal).toBe(false)

    const wire = {
      id: 'trigger-1',
      name: 'MR review',
      endpointId: 'endpoint-1',
      ownerUserId: 'user-1',
      enabled: true,
      repoScope: { kind: 'all' as const },
      eventTypes: ['mr_opened'] as const,
      branchFilter: null,
      commandPrefix: null,
      ignoreUsernames: [],
      launchKind: 'agent' as const,
      launchRefId: 'agent-1',
      launchPayload: { description: 'review' },
      migrationError: null,
      maxConsecutiveFires: 3,
      autoRegisterRepos: true,
      cancelOnMrTerminal: false,
      lastFiredAt: null,
      lastStatus: null,
      lastError: null,
      lastTaskId: null,
      consecutiveFailures: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    expect(WebhookTriggerSchema.parse(wire).cancelOnMrTerminal).toBe(false)
  })

  test('enabled policy requires mr_opened and rejects both terminal launch types', () => {
    const cases = [
      ['mr_updated'],
      ['mr_closed'],
      ['mr_merged'],
      ['mr_opened', 'mr_closed'],
      ['mr_opened', 'mr_merged'],
      ['mr_opened', 'mr_closed', 'mr_merged'],
    ] as const

    for (const eventTypes of cases) {
      const result = CreateWebhookTriggerSchema.safeParse({
        ...base,
        eventTypes: [...eventTypes],
        cancelOnMrTerminal: true,
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['cancelOnMrTerminal'],
            message: WEBHOOK_TRIGGER_TERMINAL_POLICY_CONFLICT,
          }),
        )
      }
    }
  })

  test('opened plus non-terminal events is legal and deduplicated', () => {
    const parsed = CreateWebhookTriggerSchema.parse({
      ...base,
      eventTypes: ['mr_opened', 'mr_updated', 'note', 'mr_opened'],
      cancelOnMrTerminal: true,
    })
    expect(parsed.eventTypes).toEqual(['mr_opened', 'mr_updated', 'note'])
    expect(parsed.cancelOnMrTerminal).toBe(true)
  })

  test('partial update checks a complete pair locally and exposes a merge helper for service CAS', () => {
    expect(
      UpdateWebhookTriggerSchema.safeParse({
        eventTypes: ['mr_opened', 'mr_closed'],
        cancelOnMrTerminal: true,
      }).success,
    ).toBe(false)
    expect(UpdateWebhookTriggerSchema.parse({ cancelOnMrTerminal: true })).toEqual({
      cancelOnMrTerminal: true,
    })
    expect(
      webhookTriggerTerminalPolicyIssue({
        cancelOnMrTerminal: true,
        eventTypes: ['mr_opened', 'mr_updated'],
      }),
    ).toBeNull()
    expect(
      webhookTriggerTerminalPolicyIssue({
        cancelOnMrTerminal: true,
        eventTypes: ['mr_opened', 'mr_merged'],
      }),
    ).toBe(WEBHOOK_TRIGGER_TERMINAL_POLICY_CONFLICT)
  })

  test('legacy false policy keeps terminal launch combinations unchanged', () => {
    for (const eventTypes of [['mr_closed'], ['mr_merged'], ['mr_opened', 'mr_closed']] as const) {
      expect(
        CreateWebhookTriggerSchema.safeParse({
          ...base,
          eventTypes: [...eventTypes],
          cancelOnMrTerminal: false,
        }).success,
      ).toBe(true)
    }
  })
})
