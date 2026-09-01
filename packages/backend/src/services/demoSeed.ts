// RFC-307 / RFC-349 — provider-neutral, never-fatal first-run demo orchestration.
// Each bounded context owns its rows. This file owns only the durable marker
// and the sample description; it never receives a database client.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { DEMO_RESOURCE_ID_PREFIX } from '@agent-workflow/shared'

import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { CodeCapabilityDemoSeedParticipant } from '@/modules/code-capability/composition/demoSeed'
import type { DemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/public/participants'
import { Paths } from '@/util/paths'
import { createLogger } from '@/util/log'

const log = createLogger('demo-seed')

export const DEMO_AGENT_ID = `${DEMO_RESOURCE_ID_PREFIX}reviewer`
export const DEMO_TEMPLATE_ID = `${DEMO_RESOURCE_ID_PREFIX}template-mr-review`
export const DEMO_ENDPOINT_ID = `${DEMO_RESOURCE_ID_PREFIX}endpoint`
export const DEMO_WORK_ITEM_ID = `${DEMO_RESOURCE_ID_PREFIX}work-item`
export const DEMO_ROUND_ID = `${DEMO_RESOURCE_ID_PREFIX}round`
export const DEMO_WORKFLOW_REVIEW_ID = `${DEMO_RESOURCE_ID_PREFIX}workflow-review`
export const DEMO_WORKFLOW_FANOUT_ID = `${DEMO_RESOURCE_ID_PREFIX}workflow-fanout`

const DEMO_NOTE = '示例数据，可以安全删除；删除后不会再次生成。 / Sample data — safe to delete.'
const DEMO_AT = 1_700_000_000_000

export interface DemoSeedResult {
  seeded: boolean
  reason?: 'already-offered' | 'error'
}

export interface DemoSeedParticipants {
  readonly resourceCatalog: DemoResourceCatalogSeedParticipant
  readonly codeCapability: CodeCapabilityDemoSeedParticipant
}

function resourceCatalogSeedInput() {
  return Object.freeze({
    marker: Object.freeze({
      kind: 'initial-demo-offer' as const,
      ownerUserId: SYSTEM_USER_ID,
      offeredAt: DEMO_AT,
    }),
    agent: Object.freeze({
      id: DEMO_AGENT_ID,
      name: '[demo] reviewer',
      description: `Sample reviewer used by the demo binding and workflows. ${DEMO_NOTE}`,
      outputs: Object.freeze(['findings']),
      syncOutputsOnIterate: true,
      readonly: true,
      bodyMd: ['You review a merge request diff and report findings.', '', `> ${DEMO_NOTE}`].join(
        '\n',
      ),
    }),
    workflows: Object.freeze([
      Object.freeze({
        id: DEMO_WORKFLOW_REVIEW_ID,
        name: '[demo] Review a change',
        description: `The readable half of what mr-review does, as an ordinary workflow. ${DEMO_NOTE}`,
        definition: {
          $schema_version: 2 as const,
          inputs: [{ kind: 'text' as const, key: 'diff', label: 'Diff to review', required: true }],
          nodes: [
            { id: 'in_diff', kind: 'input' as const, inputKey: 'diff' },
            {
              id: 'review',
              kind: 'agent-single' as const,
              agentId: DEMO_AGENT_ID,
              agentName: '[demo] reviewer',
              promptTemplate: 'Review this change and list findings.\n\n{{diff}}',
            },
            {
              id: 'out_findings',
              kind: 'output' as const,
              ports: [{ name: 'findings', bind: { nodeId: 'review', portName: 'findings' } }],
            },
          ],
          edges: [
            {
              id: 'e_in',
              source: { nodeId: 'in_diff', portName: 'diff' },
              target: { nodeId: 'review', portName: 'diff' },
            },
            {
              id: 'e_out',
              source: { nodeId: 'review', portName: 'findings' },
              target: { nodeId: 'out_findings', portName: 'findings' },
            },
          ],
          outputs: [{ name: 'findings', bind: { nodeId: 'review', portName: 'findings' } }],
        },
      }),
      Object.freeze({
        id: DEMO_WORKFLOW_FANOUT_ID,
        name: '[demo] Review, then ask',
        description: `Adds the platform's other human touchpoint — asking a question. ${DEMO_NOTE}`,
        definition: {
          $schema_version: 2 as const,
          inputs: [{ kind: 'text' as const, key: 'diff', label: 'Diff to review', required: true }],
          nodes: [
            { id: 'in_diff', kind: 'input' as const, inputKey: 'diff' },
            {
              id: 'review',
              kind: 'agent-single' as const,
              agentId: DEMO_AGENT_ID,
              agentName: '[demo] reviewer',
              promptTemplate: 'Review this change. Ask if anything is unclear.\n\n{{diff}}',
            },
            { id: 'ask', kind: 'clarify' as const, title: 'Anything unclear?' },
            {
              id: 'out_findings',
              kind: 'output' as const,
              ports: [{ name: 'findings', bind: { nodeId: 'review', portName: 'findings' } }],
            },
          ],
          edges: [
            {
              id: 'e_in',
              source: { nodeId: 'in_diff', portName: 'diff' },
              target: { nodeId: 'review', portName: 'diff' },
            },
            {
              id: 'e_ask',
              source: { nodeId: 'review', portName: '__clarify__' },
              target: { nodeId: 'ask', portName: 'questions' },
            },
            {
              id: 'e_ans',
              source: { nodeId: 'ask', portName: 'answers' },
              target: { nodeId: 'review', portName: '__clarify_response__' },
            },
            {
              id: 'e_out',
              source: { nodeId: 'review', portName: 'findings' },
              target: { nodeId: 'out_findings', portName: 'findings' },
            },
          ],
          outputs: [{ name: 'findings', bind: { nodeId: 'review', portName: 'findings' } }],
        },
      }),
    ]),
  })
}

/** Seed once per install. Failure is non-fatal and leaves the marker absent so
 * the next start retries the complete owner-native sequence. */
export async function seedDemoContent(participants: DemoSeedParticipants): Promise<DemoSeedResult> {
  if (existsSync(Paths.demoSeedMarker)) return { seeded: false, reason: 'already-offered' }

  try {
    const resourceReceipt = await participants.resourceCatalog.seed(resourceCatalogSeedInput())
    for (const warning of resourceReceipt.occupiedIdWarnings) {
      log.warn('demo resource id already occupied; sample skipped', { ...warning })
    }
    await participants.codeCapability.ensure({ agentId: DEMO_AGENT_ID })
  } catch (error: unknown) {
    log.warn('demo content seed failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { seeded: false, reason: 'error' }
  }

  mkdirSync(dirname(Paths.demoSeedMarker), { recursive: true })
  writeFileSync(Paths.demoSeedMarker, `${String(Date.now())}\n`, { mode: 0o600 })
  return { seeded: true }
}
