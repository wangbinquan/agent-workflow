// RFC-310 PR-4 —— AgentInputManifestV1 测试工厂（digest 自动回填）。

import {
  agentInputManifestV1Schema,
  computeAgentInputDigest,
  type AgentInputManifestV1,
} from '../../src/modules/development-automation/domain/agentInputManifest'

export const TEST_NONCE = 'nonce-0123456789abcdef'

type ManifestDraft = Omit<AgentInputManifestV1, 'inputDigest'>

export function draftManifest(overrides: Partial<ManifestDraft> = {}): ManifestDraft {
  return {
    schemaVersion: 1,
    actionRunRef: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    capabilityId: 'change.implement',
    capabilityContractVersion: 1,
    templateRevision: 1,
    missionRevision: 3,
    baseHeadSha: 'a'.repeat(40),
    requirementBundle: {
      bundleId: 'bundle-1',
      manifestDigest: 'b'.repeat(64),
      mountPath: '.agent-workflow/inputs/requirements/bundle-1',
      fileCount: 2,
      totalBytes: 1234,
    },
    repositoryUploads: null,
    pipelineBundle: null,
    feedbackSnapshot: null,
    verificationEvidence: null,
    writablePathClasses: ['module:app'],
    protectedRoots: [{ rootId: 'platform', workspacePath: '.agent-workflow' }],
    protocol: {
      nonce: TEST_NONCE,
      port: 'agent-result',
      outcomeSchemaId: 'change.implement#output@1',
    },
    ...overrides,
  }
}

/** 合法 manifest：inputDigest 按内容回填后过 strict schema。 */
export function makeManifest(overrides: Partial<ManifestDraft> = {}): AgentInputManifestV1 {
  const draft = draftManifest(overrides)
  const inputDigest = computeAgentInputDigest(draft)
  return agentInputManifestV1Schema.parse({ ...draft, inputDigest })
}
