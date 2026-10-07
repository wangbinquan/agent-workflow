// RFC-370: bootstrap chooses complete purpose pairs before any staging/program effect.
import { describe, expect, test } from 'bun:test'
import { composeDevelopmentPurposeRoot } from '@/server'
import type { AdapterConfigurationReference } from '@/modules/integration/public/participants'
import {
  MemoryPurposeContent,
  PurposeEffects,
  unusedPurposeEffect,
} from './helpers/developmentPurpose'

function choices() {
  const content = new MemoryPurposeContent()
  const configuration: AdapterConfigurationReference = {
    kind: 'development-adapter-configuration',
    reference: {},
  }
  const effects = new PurposeEffects(content.namespace, { bind: unusedPurposeEffect })
  const binding = { effects, configurationFor: () => configuration }
  return {
    content,
    effects,
    requirement: { ...binding, staging: content.staging, documentCommands: content.documents },
    pipeline: {
      ...binding,
      staging: { collect: content.staging, trigger: content.staging, rerun: content.staging },
    },
    approval: { ...binding, staging: content.staging },
  }
}

describe('RFC-370 complete purpose root selection', () => {
  test('every purpose and content receiver keeps its exact selected identity', () => {
    const c = choices()
    const selection = { requirement: c.requirement, pipeline: c.pipeline, approval: c.approval }
    const root = composeDevelopmentPurposeRoot({
      appHome: 'unused-selected-home',
      selection,
      evidenceArtifacts: c.content.evidence,
      evidenceDocumentCommands: { writeDocument: unusedPurposeEffect },
    })
    expect(root.requirement).toBe(c.requirement)
    expect(root.pipeline).toBe(c.pipeline)
    expect(root.approval).toBe(c.approval)
    expect(root.evidenceArtifacts).toBe(c.content.evidence)
    expect(root.requirement.documentCommands).toBe(c.content.documents)
    expect(c.content.calls).toEqual([])
    expect(c.effects.calls).toEqual([])
  })

  for (const [purpose, members] of [
    ['requirement', ['acquire', 'questionsWriteback', 'answersCollect']],
    ['pipeline', ['collect', 'trigger', 'rerun']],
    ['approval', ['submit', 'lookup', 'observe']],
  ] as const) {
    for (const member of members) {
      test(`${purpose} missing ${member} fails before allocation without completing the family`, () => {
        const c = choices(),
          incomplete = Object.create(c.effects) as PurposeEffects
        Object.defineProperty(incomplete, member, { value: undefined })
        const selection =
          purpose === 'requirement'
            ? { requirement: { ...c.requirement, effects: incomplete } }
            : purpose === 'pipeline'
              ? { pipeline: { ...c.pipeline, effects: incomplete } }
              : { approval: { ...c.approval, effects: incomplete } }
        expect(() =>
          composeDevelopmentPurposeRoot({
            appHome: 'unused-selected-home',
            selection,
            evidenceArtifacts: c.content.evidence,
          }),
        ).toThrow('development-purpose-effects-incomplete:' + member)
        expect(c.content.calls).toEqual([])
        expect(c.effects.calls).toEqual([])
      })
    }
  }

  test('selected content/program namespaces and the required document writer are checked before effects', () => {
    const c = choices(),
      other = new MemoryPurposeContent()
    expect(() =>
      composeDevelopmentPurposeRoot({
        appHome: 'unused-selected-home',
        selection: { requirement: { ...c.requirement, staging: other.staging } },
        evidenceArtifacts: c.content.evidence,
      }),
    ).toThrow('development-purpose-staging-namespace-mismatch')
    expect(() =>
      composeDevelopmentPurposeRoot({
        appHome: 'unused-selected-home',
        selection: {
          pipeline: { ...c.pipeline, staging: { ...c.pipeline.staging, trigger: other.staging } },
        },
        evidenceArtifacts: c.content.evidence,
      }),
    ).toThrow('development-purpose-staging-namespace-mismatch')
    expect(() =>
      composeDevelopmentPurposeRoot({
        appHome: 'unused-selected-home',
        selection: { approval: { ...c.approval, staging: other.staging } },
        evidenceArtifacts: c.content.evidence,
      }),
    ).toThrow('development-purpose-staging-namespace-mismatch')
    const missingWriter = {
      ...c.requirement,
      documentCommands: {},
    } as unknown as typeof c.requirement
    expect(() =>
      composeDevelopmentPurposeRoot({
        appHome: 'unused-selected-home',
        selection: { requirement: missingWriter },
        evidenceArtifacts: c.content.evidence,
        evidenceDocumentCommands: c.content.documents,
      }),
    ).toThrow('development-purpose-document-commands-incomplete')
    expect(c.content.calls).toEqual([])
    expect(other.calls).toEqual([])
    expect(c.effects.calls).toEqual([])
  })
})
