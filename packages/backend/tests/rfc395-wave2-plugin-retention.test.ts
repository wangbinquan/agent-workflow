// RFC-395 X4/P: resource-package retention consumes target plugin envelopes and
// keeps unfinished generations visible inside the caller's transaction.
import { expect, test } from 'bun:test'
import { createHostedResourcePackagePluginRetention } from '@/modules/resource-catalog/infrastructure/crewstation/pluginRetention'
import { resourcePackageArtifactCodecs } from '@/modules/resource-catalog/infrastructure/resourcePackageArtifactCodec'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider } from './helpers/eachProvider'

function journal(id: string, state: 'prepared' | 'applying' | 'committed' | 'failed') {
  return {
    id,
    scope: 'plugin-retention',
    key: id,
    actorUserId: 'owner',
    state,
    preparedArtifactsJson: resourcePackageArtifactCodecs.encode([
      {
        kind: 'plugin-install',
        operationId: `operation-${id}`,
        pluginId: `plugin-${id}`,
        generationId: `generation-${id}`,
        generationDirectory: `cs-plugin:plugin-${id}/generation-${id}`,
      },
      {
        kind: 'skill-stage',
        operationId: `skill-operation-${id}`,
        skillId: `skill-${id}`,
        stagingDirectory: `skills/${id}/staging`,
        targetDirectory: `skills/${id}/files`,
      },
    ]),
    createdAt: 1,
    updatedAt: 1,
  }
}

describeEachProvider('RFC-395 target resource-package plugin retention', (h) => {
  test('retains target generation directories only for unfinished plugin installs', async () => {
    const { resourceBundleApplies } = tablesOf(h.db)
    for (const state of ['prepared', 'applying', 'committed', 'failed'] as const)
      await h.db.insert(resourceBundleApplies).values(journal(state, state))
    expect([...(await createHostedResourcePackagePluginRetention(h.db)())].sort()).toEqual([
      'cs-plugin:plugin-applying/generation-applying',
      'cs-plugin:plugin-prepared/generation-prepared',
    ])
  })

  test('uses the supplied transaction to retain an uncommitted generation', async () => {
    const retain = createHostedResourcePackagePluginRetention(h.db)
    expect(await retain()).toEqual([])
    await expect(
      h.session.transaction(async (tx) => {
        const { resourceBundleApplies } = tablesOf(tx)
        await tx.insert(resourceBundleApplies).values(journal('in-transaction', 'prepared'))
        expect(await retain(tx)).toEqual([
          'cs-plugin:plugin-in-transaction/generation-in-transaction',
        ])
        throw new Error('rollback retention fixture')
      }),
    ).rejects.toThrow('rollback retention fixture')
    expect(await retain()).toEqual([])
  })
})
