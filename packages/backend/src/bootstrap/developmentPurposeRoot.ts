// RFC-392: select one development purpose binding for all application participants.
// RFC-431: every deployment selects all three purposes; the standalone ones are composed here.
import type {
  ApprovalAdapterBinding,
  RequirementAdapterBinding,
} from '@/modules/integration/public/participants'
import { createLocalDevelopmentAdapterEffects } from '@/modules/integration/composition/developmentAdapterProgram'
import type { EvidenceStagingFactory } from '@/modules/development-automation/public/types'
import {
  createLocalEvidenceStagingFactory,
  createLocalEvidenceStagingNamespace,
  createFileEvidenceDocumentCommandsOnFirstWrite,
} from '@/modules/development-automation/composition/evidenceStaging'
import { assertEvidenceStagingFactory } from '@/modules/development-automation/public/participants'
import { join } from 'node:path'
import { type EvidenceArtifactPort } from '@/modules/development-automation/composition'
import type {
  RequirementPurposeSelection,
  PipelinePurposeSelection,
  DevelopmentPurposeSelection,
  SelectedDevelopmentPurposeRoot,
} from '@/modules/development-automation/composition'

function assertPurposePair(
  selection: RequirementPurposeSelection | PipelinePurposeSelection | ApprovalAdapterBinding,
  names: readonly string[],
  factories: readonly EvidenceStagingFactory[],
): void {
  if (typeof selection?.configurationFor !== 'function') {
    throw new Error('development-purpose-configuration-binding-incomplete')
  }
  const effects = selection.effects
  if (
    typeof effects?.programs?.bind !== 'function' ||
    effects.namespace?.kind !== 'evidence-staging-namespace'
  ) {
    throw new Error('development-purpose-program-binding-incomplete')
  }
  const members = effects as unknown as Record<string, unknown>
  for (const name of names) {
    if (typeof members[name] !== 'function') {
      throw new Error(`development-purpose-effects-incomplete:${name}`)
    }
  }
  for (const factory of factories) {
    assertEvidenceStagingFactory(factory)
    if (factory.namespace.reference !== effects.namespace?.reference) {
      throw new Error('development-purpose-staging-namespace-mismatch')
    }
  }
}

/**
 * RFC-431: the standalone purposes — the local adapter programs, staging into the selected evidence store.
 * Nothing here touches the disk: the evidence store and the requirement document writer open on first use.
 */
export function composeLocalDevelopmentPurposes(input: {
  readonly appHome: string
  readonly evidenceArtifacts: EvidenceArtifactPort
}): DevelopmentPurposeSelection {
  const content = createLocalEvidenceStagingNamespace(input.evidenceArtifacts)
  const native = createLocalDevelopmentAdapterEffects({
    namespace: content.namespace,
    resolveStaging: (reference) => content.resolve(reference),
  })
  const nativeBinding = (mockKey: string) => {
    const secretSource = Object.freeze({ ...process.env })
    const mockUrl = process.env[mockKey]
    return {
      configurationFor(content: Parameters<RequirementAdapterBinding['configurationFor']>[0]) {
        return native.configurationFor({
          adapterContent: content,
          secretSource,
          ...(mockUrl === undefined ? {} : { extraEnv: { [mockKey]: mockUrl } }),
        })
      },
    }
  }
  const stagingRoot = join(input.appHome, 'evidence', 'staging')
  return {
    requirement: {
      ...nativeBinding('AW_REQUIREMENT_MOCK_URL'),
      effects: native.requirement,
      staging: createLocalEvidenceStagingFactory(content, {
        kind: 'requirement',
        root: stagingRoot,
      }),
      documentCommands: createFileEvidenceDocumentCommandsOnFirstWrite({
        evidence: input.evidenceArtifacts,
        stagingRoot,
      }),
    },
    pipeline: {
      ...nativeBinding('AW_PIPELINE_MOCK_URL'),
      effects: native.pipeline,
      staging: {
        collect: createLocalEvidenceStagingFactory(content, {
          kind: 'temporary',
          prefix: 'aw-pipeline-sink-',
        }),
        trigger: createLocalEvidenceStagingFactory(content, {
          kind: 'temporary',
          prefix: 'aw-pipeline-trigger-',
        }),
        rerun: createLocalEvidenceStagingFactory(content, {
          kind: 'temporary',
          prefix: 'aw-pipeline-rerun-',
        }),
      },
    },
    approval: {
      ...nativeBinding('AW_APPROVAL_MOCK_URL'),
      effects: native.approval,
      staging: createLocalEvidenceStagingFactory(content, {
        kind: 'temporary',
        prefix: 'aw-approval-adapter-',
      }),
    },
  }
}

/** Bootstrap checks each selected purpose pair once and forwards it to every subcomposition. */
export function composeDevelopmentPurposeRoot(input: {
  readonly selection: DevelopmentPurposeSelection
  readonly evidenceArtifacts: EvidenceArtifactPort
}): SelectedDevelopmentPurposeRoot {
  const { requirement, pipeline, approval } = input.selection
  assertPurposePair(
    requirement,
    ['acquire', 'questionsWriteback', 'answersCollect'],
    [requirement.staging],
  )
  if (typeof requirement.documentCommands?.writeDocument !== 'function') {
    throw new Error('development-purpose-document-commands-incomplete')
  }
  assertPurposePair(
    pipeline,
    ['collect', 'trigger', 'rerun'],
    [pipeline.staging.collect, pipeline.staging.trigger, pipeline.staging.rerun],
  )
  assertPurposePair(approval, ['submit', 'lookup', 'observe'], [approval.staging])
  return { requirement, pipeline, approval, evidenceArtifacts: input.evidenceArtifacts }
}
