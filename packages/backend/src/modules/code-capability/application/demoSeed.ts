import { DEMO_RESOURCE_ID_PREFIX } from '@agent-workflow/shared'

import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { lookupStageContract } from '../domain/capabilityRegistry'
import type {
  CodeCapabilityDemoSeedAggregate,
  CodeCapabilityDemoSeedPersistence,
} from './ports/demoSeedPersistence'

const DEMO_TEMPLATE_ID = `${DEMO_RESOURCE_ID_PREFIX}template-mr-review`
const DEMO_NOTE = '示例数据，可以安全删除；删除后不会再次生成。 / Sample data — safe to delete.'
const DEMO_AT = 1_700_000_000_000

export interface CodeCapabilityDemoSeedReceipt {
  readonly capabilityTemplateId: string
  readonly workItemId: string | null
  readonly roundId: string | null
  readonly stageIds: readonly string[]
}

export interface CodeCapabilityDemoSeedParticipant {
  /**
   * Ensure the Code Capability sample template.
   *
   * Stable ids plus provider-side conflict-ignore semantics make retries safe;
   * rows occupying those ids are never overwritten.
   */
  ensure(input: { readonly agentId: string }): Promise<CodeCapabilityDemoSeedReceipt>
}

function aggregateFor(agentId: string): CodeCapabilityDemoSeedAggregate {
  const contract = lookupStageContract('mr-review')
  const template = {
    id: DEMO_TEMPLATE_ID,
    name: '[demo] MR review template',
    description: `The whole configuration for one capability: scripts, hooks, parameters, and which agent fills each AI slot. ${DEMO_NOTE}`,
    capability: 'mr-review',
    scriptsJson: JSON.stringify({
      collect: {
        language: 'bash',
        script: [
          '#!/usr/bin/env bash',
          '# [demo] Sample collect script.',
          '# Real ones ask the code host what changed; this one just reports a',
          '# fixed shape so the sample runs nowhere and needs nothing.',
          'set -euo pipefail',
          'echo \'{"packages": []}\'',
        ].join('\n'),
      },
    }),
    hooksJson: JSON.stringify([
      {
        stage: 'review-shard',
        phase: 'pre',
        language: 'bash',
        script: [
          '#!/usr/bin/env bash',
          '# [demo] Runs before each sharded review.',
          '#',
          '# It returns only the contract-declared extraContext key.',
          'set -euo pipefail',
          'echo \'{"extraContext": "Prefer concrete, reproducible findings."}\'',
        ].join('\n'),
        blocking: true,
        stageContractVer: contract?.version ?? 1,
      },
    ]),
    paramSchemaJson: JSON.stringify([
      { name: 'maxFindings', kind: 'number', required: false },
      { name: 'skipDraft', kind: 'boolean', required: false },
    ]),
    paramDefaultsJson: JSON.stringify({ maxFindings: 20, skipDraft: true }),
    agentBySlotJson: JSON.stringify({ reviewer: agentId }),
    promptBySlotJson: JSON.stringify({
      reviewer: 'Review the diff. Report only findings you can point at a line for.',
    }),
    paramsJson: JSON.stringify({ maxFindings: 10 }),
    stageContractVer: contract?.version ?? 1,
    ownerUserId: SYSTEM_USER_ID,
    visibility: 'public' as const,
    builtin: false,
    aclRevision: 0,
    upstreamId: null,
    upstreamVersion: null,
    baseDigest: null,
    baseSnapshotJson: null,
    createdAt: DEMO_AT,
    updatedAt: DEMO_AT,
  }
  return { template }
}

export function createCodeCapabilityDemoSeedParticipant(
  persistence: CodeCapabilityDemoSeedPersistence,
): CodeCapabilityDemoSeedParticipant {
  return Object.freeze({
    async ensure(input: { readonly agentId: string }) {
      const aggregate = aggregateFor(input.agentId)
      await persistence.ensure(aggregate)
      return Object.freeze({
        capabilityTemplateId: aggregate.template.id,
        workItemId: null,
        roundId: null,
        stageIds: Object.freeze([]),
      })
    },
  })
}
