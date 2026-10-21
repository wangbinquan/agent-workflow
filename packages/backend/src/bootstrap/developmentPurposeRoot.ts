// RFC-392: select one development purpose binding for all application participants.
import type {
  ApprovalAdapterBinding,
  RequirementAdapterBinding,
} from '@/modules/integration/public/participants'
import { createLocalDevelopmentAdapterEffects } from '@/modules/integration/composition/developmentAdapterProgram'
import type { EvidenceStagingFactory } from '@/modules/development-automation/public/types'
import {
  createLocalEvidenceArtifactPort,
  createLocalEvidenceStagingFactory,
  createLocalEvidenceStagingNamespace,
  createFileEvidenceDocumentCommands,
} from '@/modules/development-automation/composition/evidenceStaging'
import { assertEvidenceStagingFactory } from '@/modules/development-automation/public/participants'
import { join } from 'node:path'
import {
  type EvidenceDocumentCommands,
  type EvidenceArtifactPort,
} from '@/modules/development-automation/composition'
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

/** Bootstrap selects each whole purpose pair once and forwards it to every subcomposition. */
export function composeDevelopmentPurposeRoot(input: {
  readonly appHome: string
  readonly selection?: DevelopmentPurposeSelection
  readonly evidenceArtifacts?: EvidenceArtifactPort
  readonly evidenceDocumentCommands?: EvidenceDocumentCommands
}): SelectedDevelopmentPurposeRoot {
  let evidence = input.evidenceArtifacts
  const artifacts = (): EvidenceArtifactPort =>
    (evidence ??= createLocalEvidenceArtifactPort(input.appHome))
  const content = createLocalEvidenceStagingNamespace(artifacts)
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
  const requirement = input.selection?.requirement ?? {
    ...nativeBinding('AW_REQUIREMENT_MOCK_URL'),
    effects: native.requirement,
    staging: createLocalEvidenceStagingFactory(content, {
      kind: 'requirement',
      root: join(input.appHome, 'evidence', 'staging'),
    }),
    get documentCommands() {
      return (
        input.evidenceDocumentCommands ??
        createFileEvidenceDocumentCommands({
          evidence: artifacts(),
          stagingRoot: join(input.appHome, 'evidence', 'staging'),
        })
      )
    },
  }
  const pipeline = input.selection?.pipeline ?? {
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
  }
  const approval = input.selection?.approval ?? {
    ...nativeBinding('AW_APPROVAL_MOCK_URL'),
    effects: native.approval,
    staging: createLocalEvidenceStagingFactory(content, {
      kind: 'temporary',
      prefix: 'aw-approval-adapter-',
    }),
  }
  assertPurposePair(
    requirement,
    ['acquire', 'questionsWriteback', 'answersCollect'],
    [requirement.staging],
  )
  // The selected writer is checked without evaluating the default native writer early.
  if (
    input.selection?.requirement !== undefined &&
    typeof requirement.documentCommands?.writeDocument !== 'function'
  ) {
    throw new Error('development-purpose-document-commands-incomplete')
  }
  assertPurposePair(
    pipeline,
    ['collect', 'trigger', 'rerun'],
    [pipeline.staging.collect, pipeline.staging.trigger, pipeline.staging.rerun],
  )
  assertPurposePair(approval, ['submit', 'lookup', 'observe'], [approval.staging])
  return {
    requirement,
    pipeline,
    approval,
    get evidenceArtifacts() {
      return artifacts()
    },
  }
}
