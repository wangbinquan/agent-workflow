// Q-3: real frozen rows and native target; filesystem journal/pointer use the V3 fixture.
// Process stop and engine backup remain ports; T19 supplies the real deployment boundary.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { composeBootUpgradeEnvironment } from '@/bootstrap/conversionRules'
import { epochConversionInput } from '@/bootstrap/epochMigration'
import { createEpochSwitchApplication } from '@/modules/system-operations/application/epochSwitch/application'
import { createDryRunSink } from '@/modules/system-operations/infrastructure/epochSwitch/dryRunSink'
import { createMigrationMetaStore } from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { readEpochTargetEvidence } from '@/modules/system-operations/infrastructure/epochSwitch/installationProbe'
import { createTargetGenerationHandle } from '@/modules/system-operations/infrastructure/epochSwitch/targetGeneration'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { planConversion } from '@/platform/persistence/migration/conversion/plan'
import { installConversionTarget } from '@/platform/persistence/migration/target/install'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { seedRequiredRows, seedSimpleTask } from './rfc395V2/integrationFixtures'
import { frozenValues } from './rfc395V2/contentFixtures'
import type { V3Harness } from './rfc395V3Harness'
import { makeSwitchFixture, fixtureDigest } from './rfc395V3SwitchFixture'

export async function q3SwitchFixture(h: V3Harness, restore = false) {
  await h.source.install()
  await seedRequiredRows(h.source)
  await seedSimpleTask(h.source, 'q3-retained-task', 'done')
  await h.source.write('maintenance_state', [
    { key: 'q3-byte-proof', value: ' { "原文": "retained" }\r\n', updated_at: 123 },
  ])
  // Identical public identities belong to different retained configuration owners.
  const retainedConfigurations = [
    { table: 'digital_employees', draft: ' { "legacy-development": true }\r\n' },
    { table: 'employee_definitions', draft: ' { "employee-os": true }\n' },
  ]
  for (const entry of retainedConfigurations)
    await h.source.write(entry.table, [
      frozenValues(entry.table, {
        id: 'q3-shared-employee-id',
        name: 'same retained name',
        draft_json: entry.draft,
        created_at: 23,
        updated_at: 29,
      }),
    ])
  const input = await h.input()
  const f = makeSwitchFixture()
  const connection = { ...h.target, async close() {} }
  const frozen = {
    reader: input.source,
    preflight: input.preflight,
    preUpgrade: null,
    watermark: input.preflight.watermark,
    evidenceRoot: null,
    async close() {},
  }
  f.deps.source = {
    async discover() {
      return frozen
    },
    async freeze() {
      await input.source.assertUnchanged(input.preflight)
      return frozen
    },
  }
  const installation = f.deps.installation
  f.deps.installation = async () => {
    const result = await installation()
    return {
      ...result,
      facts: { ...result.facts, provider: h.sourceProvider },
      source:
        h.sourceProvider === 'sqlite'
          ? result.source
          : { kind: 'postgresql-database' as const, profileRef: 'env:SOURCE_URL' },
    }
  }
  f.deps.targetContractDigest = h.head.contract.contract.digest
  f.deps.targetPlanDigest = (provider) => h.head[provider].digest
  f.deps.targetEvidence = (id) => readEpochTargetEvidence(connection, id)
  const backup = f.deps.backup.create
  f.deps.backup.create = async (request) => ({
    ...(await backup(request)),
    kind: restore
      ? 'immutable-backup-source'
      : h.sourceProvider === 'sqlite'
        ? 'sqlite-vacuum'
        : 'postgresql-logical',
  })
  f.deps.conversionPlan = (request) => planConversion(epochConversionInput(request))
  f.deps.conversion = {
    bootUpgradeEnvironment: composeBootUpgradeEnvironment({
      async open() {
        return null
      },
    }),
    async dryRun(request) {
      const sink = createDryRunSink()
      await runConversion(epochConversionInput(request), sink)
      return sink.result
    },
    run: (request, sink) => runConversion(epochConversionInput(request), sink),
  }
  const open = (generationId: string) =>
    createTargetGenerationHandle({
      target: connection,
      generationId,
      registry: persistenceSchema,
      head: h.head,
      catalogCache: h.catalogCache,
      now: () => f.control.clock,
      receiptStorage: 'meta-only',
      faults: f.deps.faults,
    })
  f.deps.target = {
    async preflight({ location }) {
      return {
        provider: h.targetProvider,
        location,
        fingerprint: 'q3-independent-native-target',
        empty: true,
        postgresqlMajor: null,
        encoding: 'UTF8',
        collation: 'C',
        canCreate: true,
        availableBytes: null,
        blocks: [],
      }
    },
    async create(request) {
      await installConversionTarget(connection, {
        head: h.head,
        metaTables: h.metaTables,
        generationId: request.generationId,
        now: request.now,
      })
      await createMigrationMetaStore({ target: connection, registry: persistenceSchema }).insert(
        'generations',
        {
          generationId: request.generationId,
          schemaEpoch: 2,
          role: request.role,
          state: 'prepared',
          provider: request.provider,
          operationId: request.operationId,
          runId: request.runId,
          sourceGenerationId: request.sourceGenerationId,
          contractDigest: h.head.contract.contract.digest,
          planDigest: h.head[request.provider].digest,
          activationReceiptDigest: null,
          createdAt: request.now,
          activatedAt: null,
          retiredAt: null,
        },
      )
      return open(request.generationId)
    },
    async open({ generationId }) {
      if (!(await readEpochTargetEvidence(connection, generationId)))
        throw new Error('v3-target-generation-missing')
      return open(generationId)
    },
    async discard() {
      throw new Error('Q3 phase suite never discards its native target')
    },
  }
  if (restore) {
    const root = join(f.root, 'backup')
    mkdirSync(join(root, 'skills'), { recursive: true })
    writeFileSync(join(root, 'skills/proof'), Buffer.from([0xef, 0xbb, 0xbf, 0, 255]))
    writeFileSync(join(root, 'config.json'), '{"restored":true}\n')
    mkdirSync(join(f.root, 'skills'), { recursive: true })
    writeFileSync(join(f.root, 'skills/original'), 'retained original')
    writeFileSync(join(f.root, 'config.json'), '{"installed":true}\n')
    f.deps.unpackBackup = async () => ({
      sourceKind: h.sourceProvider === 'sqlite' ? 'sqlite-backup' : 'logical-backup',
      root,
      digest: fixtureDigest,
    })
  }
  return {
    ...f,
    retainedConfigurations,
    reopen: () => createEpochSwitchApplication(f.deps),
    initialPlan: () =>
      restore
        ? createEpochSwitchApplication(f.deps).restoreBackup({
            artifact: 'q3-backup',
            restoreConfig: true,
            target: {
              provider: h.targetProvider,
              ...(h.targetProvider === 'postgresql' ? { urlEnv: 'TARGET_URL' } : {}),
            },
          })
        : createEpochSwitchApplication(f.deps).plan({
            target: {
              provider: h.targetProvider,
              ...(h.targetProvider === 'postgresql' ? { urlEnv: 'TARGET_URL' } : {}),
            },
          }),
    async rows(table: string) {
      return connection.execute(
        `SELECT * FROM ${h.targetProvider === 'postgresql' ? 'agent_workflow.' : ''}${table}`,
      )
    },
    async generations() {
      return connection.execute(`SELECT * FROM ${metaTableName(h.targetProvider, 'generations')}`)
    },
    assertSourceUnchanged: () => input.source.assertUnchanged(input.preflight),
  }
}
