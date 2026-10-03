// RFC-370: real AW recovery rules consume logical content references and await close.
import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { resourceBundleApplies, skills, skillVersions } from '@/db/schema'
import type {
  ResourcePackageRecoveryEffects,
  ResourcePackageRecoveryEffectsFactory,
} from '@/modules/resource-catalog/application/package/recoveryContentEffects'
import {
  composePostgresqlResourcePackageApplyMaintenance,
  composeSqliteResourcePackageApplyMaintenance,
} from '@/modules/resource-catalog/composition/resourcePackageMaintenance'
import {
  selectedResourcePackageRecoveryEffects,
  withResourcePackageRecoveryEffects,
} from '@/modules/resource-catalog/infrastructure/recoveryContentEffects'
import {
  isSkillBootVerified,
  unmarkSkillBootVerified,
} from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { describeEachProvider } from './helpers/eachProvider'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

interface Model {
  calls: string[]
  existing: Set<string>
  hashes: Map<string, string>
  asynchronous?: boolean
  closeWait?: Promise<void>
  closeEntered?: () => void
  closeFailure?: { error: unknown }
}

class LogicalScope implements ResourcePackageRecoveryEffects {
  readonly #model: Model
  constructor(model: Model) {
    this.#model = model
    Object.freeze(this)
  }
  #result<T>(value: T): T | Promise<T> {
    return this.#model.asynchronous ? Promise.resolve(value) : value
  }
  exists(reference: string) {
    this.#model.calls.push(`exists:${reference}`)
    return this.#result(this.#model.existing.has(reference))
  }
  createDirectory(reference: string, mode?: number) {
    this.#model.calls.push(`mkdir:${reference}:${String(mode)}`)
    this.#model.existing.add(reference)
    return this.#result(undefined)
  }
  removeDirectory(reference: string) {
    this.#model.calls.push(`remove:${reference}`)
    this.#model.existing.delete(reference)
    this.#model.hashes.delete(reference)
    return this.#result(undefined)
  }
  move(source: string, target: string) {
    this.#model.calls.push(`move:${source}:${target}`)
    this.#model.existing.delete(source)
    this.#model.existing.add(target)
    const hash = this.#model.hashes.get(source)
    if (hash !== undefined) this.#model.hashes.set(target, hash)
    this.#model.hashes.delete(source)
    return this.#result(undefined)
  }
  cleanupOperation(reference: string, publication: string) {
    this.#model.calls.push(`cleanup:${reference}:${publication}`)
    this.#model.existing.delete(`${reference}.op-${publication}.staged`)
    return this.#result(undefined)
  }
  swapStaged(reference: string, publication: string) {
    this.#model.calls.push(`swap:${reference}:${publication}`)
    const hadPrevious = this.#model.existing.has(reference)
    const staged = `${reference}.op-${publication}.staged`
    const hash = this.#model.hashes.get(staged)
    if (hash !== undefined) this.#model.hashes.set(reference, hash)
    this.#model.existing.add(reference)
    return this.#result({ hadPrevious })
  }
  restoreBackup(reference: string, publication: string) {
    this.#model.calls.push(`restore:${reference}:${publication}`)
    return this.#result(true)
  }
  directoryChainState(root: string, reference: string) {
    this.#model.calls.push(`chain:${root}:${reference}`)
    return this.#result(
      this.#model.existing.has(reference) ? ('real-directory' as const) : ('missing' as const),
    )
  }
  hashRegularTree(reference: string) {
    this.#model.calls.push(`hash:${reference}`)
    const hash = this.#model.hashes.get(reference)
    if (hash === undefined) throw new Error(`logical-tree-missing:${reference}`)
    return this.#result(hash)
  }
  close() {
    this.#model.calls.push('close-entered')
    this.#model.closeEntered?.()
    const finish = () => {
      if (this.#model.closeFailure !== undefined) throw this.#model.closeFailure.error
      this.#model.calls.push('closed')
    }
    if (this.#model.closeWait !== undefined || this.#model.asynchronous)
      return Promise.resolve(this.#model.closeWait).then(finish)
    return finish()
  }
}

class LogicalFactory implements ResourcePackageRecoveryEffectsFactory {
  readonly #model: Model
  constructor(model: Model) {
    this.#model = model
    Object.freeze(this)
  }
  root(id: string) {
    return `logical:skills/${id}`
  }
  live(id: string) {
    return `${this.root(id)}/files`
  }
  version(id: string, version: number) {
    return `${this.root(id)}/versions/v${version}/files`
  }
  staged(reference: string, publication: string) {
    return `${reference}.op-${publication}.staged`
  }
  candidate(reference: string, publication: string) {
    return `${reference}.op-${publication}.candidate`
  }
  normalize(reference: string) {
    this.#model.calls.push(`normalize:${reference}`)
    return reference
  }
  parent(reference: string) {
    return reference.slice(0, reference.lastIndexOf('/'))
  }
  storedReference(reference: string) {
    return `logical:${reference}`
  }
  assertManaged(root: string, reference: string) {
    this.#model.calls.push(`managed:${root}:${reference}`)
  }
  acquire() {
    this.#model.calls.push('acquire')
    const scope = new LogicalScope(this.#model)
    return this.#model.asynchronous ? Promise.resolve(scope) : scope
  }
}

const model = (options: Partial<Model> = {}): Model => ({
  calls: [],
  existing: new Set(),
  hashes: new Map(),
  ...options,
})

for (const asynchronous of [false, true]) {
  test(`complete frozen prototype receivers await ${asynchronous ? 'async' : 'sync'} operations and close`, async () => {
    const closing = gate(),
      entered = gate()
    const state = model({ asynchronous, closeWait: closing.promise, closeEntered: entered.release })
    const factory = new LogicalFactory(state)
    expect(selectedResourcePackageRecoveryEffects(factory, 'unused:native-home')).toBe(factory)
    expect(Object.isFrozen(factory)).toBe(true)
    let returned = false
    const pending = withResourcePackageRecoveryEffects(factory, async (effects) => {
      expect(Object.isFrozen(effects)).toBe(true)
      await effects.createDirectory('logical:tree')
      expect(await effects.exists('logical:tree')).toBe(true)
      return 17
    }).then((result) => {
      returned = true
      return result
    })
    await entered.promise
    expect(returned).toBe(false)
    expect(state.calls).toEqual([
      'acquire',
      'mkdir:logical:tree:undefined',
      'exists:logical:tree',
      'close-entered',
    ])
    closing.release()
    expect(await pending).toBe(17)
    expect(state.calls.at(-1)).toBe('closed')
  })
}

test('single arbitrary failures and ordered body/close double failures keep their original values', async () => {
  const body = new Error('body-failed'),
    close = new Error('close-failed')
  for (const error of [undefined, null, 42, body]) {
    const state = model()
    const failure = await withResourcePackageRecoveryEffects(new LogicalFactory(state), () => {
      throw error
    }).then(
      () => ({ succeeded: true }),
      (value: unknown) => ({ error: value }),
    )
    expect(failure).toEqual({ error })
    expect(state.calls).toEqual(['acquire', 'close-entered', 'closed'])
  }
  await expect(
    withResourcePackageRecoveryEffects(
      new LogicalFactory(model({ closeFailure: { error: close } })),
      () => 1,
    ),
  ).rejects.toBe(close)
  const failure = await withResourcePackageRecoveryEffects(
    new LogicalFactory(model({ closeFailure: { error: close } })),
    () => {
      throw body
    },
  ).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([body, close])
})

test('incomplete selections never acquire a substitute and a usable incomplete scope still awaits close', async () => {
  for (const choice of [null, {}]) {
    expect(() =>
      selectedResourcePackageRecoveryEffects(
        choice as unknown as ResourcePackageRecoveryEffectsFactory,
        'unused:home',
      ),
    ).toThrow('resource-package-recovery-effects-factory-incomplete')
  }
  const closing = gate(),
    entered = gate()
  const complete = new LogicalFactory(model())
  const broken = Object.create(complete) as ResourcePackageRecoveryEffectsFactory
  Object.defineProperty(broken, 'acquire', {
    value: () => ({
      async close() {
        entered.release()
        await closing.promise
      },
    }),
  })
  let rejected = false
  const pending = withResourcePackageRecoveryEffects(broken, () => {
    throw new Error('body-must-not-run')
  }).then(
    () => ({ succeeded: true }),
    (error: unknown) => {
      rejected = true
      return { error }
    },
  )
  await entered.promise
  expect(rejected).toBe(false)
  closing.release()
  const result = await pending
  expect('error' in result && result.error instanceof Error && result.error.message).toBe(
    'resource-package-recovery-effects-scope-incomplete',
  )
  const acquireFailure = new Error('acquire-failed')
  const failAcquire = Object.create(complete) as ResourcePackageRecoveryEffectsFactory
  Object.defineProperty(failAcquire, 'acquire', {
    value: () => {
      throw acquireFailure
    },
  })
  await expect(withResourcePackageRecoveryEffects(failAcquire, () => 1)).rejects.toBe(
    acquireFailure,
  )
})

test('the native default retains the sorted relative-name/NUL/content/NUL digest for nested binary files', async () => {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc370-native-recovery-'))
  try {
    const factory = selectedResourcePackageRecoveryEffects(undefined, appHome)
    const root = factory.live('native-skill')
    mkdirSync(join(root, 'sub'), { recursive: true })
    const bytes = Buffer.from([0, 255, 13, 10])
    writeFileSync(join(root, 'z.txt'), 'tail')
    writeFileSync(join(root, 'sub', 'a.bin'), bytes)
    const expected = createHash('sha256')
      .update('sub/a.bin')
      .update('\x00')
      .update(bytes)
      .update('\x00')
      .update('z.txt')
      .update('\x00')
      .update('tail')
      .update('\x00')
      .digest('hex')
    expect(
      await withResourcePackageRecoveryEffects(factory, (effects) => effects.hashRegularTree(root)),
    ).toBe(expected)
    expect(expected).not.toBe(createHash('sha256').update(bytes).digest('hex'))
  } finally {
    rmSync(appHome, { recursive: true, force: true })
  }
})

const NOW = 10_000_000
const CONTENT_HASH = createHash('sha256').update('SKILL.md\x00v2\x00').digest('hex')

describeEachProvider('RFC-370 logical resource package recovery', (harness) => {
  const compose = (effectsFactory: ResourcePackageRecoveryEffectsFactory, legacy = false) =>
    harness.capabilities.isolation === 'exclusive' || legacy
      ? composeSqliteResourcePackageApplyMaintenance({
          db: harness.db,
          appHome: 'logical:aw-home',
          pluginsDir: 'logical:plugins',
          recoveryEffectsFactory: effectsFactory,
          activitySource: { activeApplyIds: () => [] },
          now: () => NOW,
        })
      : composePostgresqlResourcePackageApplyMaintenance({
          db: harness.db,
          appHome: 'logical:aw-home',
          pluginsDir: 'logical:plugins',
          recoveryEffectsFactory: effectsFactory,
          now: () => NOW,
        })

  for (const legacy of [false, true]) {
    for (const currentVersion of [2, 3, null, 1]) {
      test(`${legacy ? 'legacy' : 'modern'} receipt retains the AW generation decision for ${String(currentVersion)}`, async () => {
        const id = randomUUID(),
          journalId = randomUUID(),
          publishId = randomUUID()
        const closing = gate(),
          entered = gate()
        const state = model({
          asynchronous: true,
          ...(currentVersion === 2
            ? { closeWait: closing.promise, closeEntered: entered.release }
            : {}),
        })
        const factory = new LogicalFactory(state)
        const live = factory.live(id),
          version = factory.version(id, 2)
        const staged = factory.staged(live, publishId),
          candidate = factory.candidate(version, publishId)
        for (const reference of [live, version, staged, candidate]) {
          state.existing.add(reference)
          state.hashes.set(reference, CONTENT_HASH)
        }
        unmarkSkillBootVerified(id)
        try {
          if (currentVersion !== null) {
            await harness.db.insert(skills).values({
              id,
              name: 'logical-recovery',
              description: '',
              managedPath: `skills/${id}/files`,
              ownerUserId: null,
              visibility: 'public',
              schemaVersion: 1,
              contentVersion: currentVersion,
              aclRevision: 0,
              metaRevision: 0,
              reservationState: 'ready',
              versionState: 'snapshot-authoritative',
              createdAt: NOW,
              updatedAt: NOW,
            })
            await harness.db.insert(skillVersions).values({
              id: randomUUID(),
              skillId: id,
              versionIndex: 2,
              filesPath: `skills/${id}/versions/v2/files`,
              source: 'import',
              summary: null,
              fusionId: null,
              restoredFromVersion: null,
              authorUserId: null,
              contentHash: CONTENT_HASH,
              createdAt: NOW,
            })
          }
          const artifact = legacy
            ? {
                kind: 'skill-version-stage',
                staged: {
                  skillId: id,
                  skillName: 'logical-recovery',
                  opId: null,
                  publishId,
                  newVersion: 2,
                  newHash: CONTENT_HASH,
                  filesDir: live,
                  versionDir: version,
                  stagingDir: staged,
                  noop: null,
                },
              }
            : {
                kind: 'skill-version-stage',
                operationId: publishId,
                skillId: id,
                publishId,
                version: 2,
                stagingDirectory: staged,
                versionDirectory: version,
              }
          const applied = {
            resourceType: 'skill',
            resourceId: id,
            action: 'update',
            name: 'logical-recovery',
            ...(legacy ? { opId: publishId } : { operationId: publishId }),
          }
          await harness.db.insert(resourceBundleApplies).values({
            id: journalId,
            scope: 'package',
            key: journalId,
            actorUserId: 'logical-actor',
            state: 'committed',
            preparedArtifactsJson: JSON.stringify([artifact]),
            receiptJson: JSON.stringify({ journalId, applied: [applied] }),
            error: null,
            createdAt: 0,
            updatedAt: 0,
          })
          const pending = compose(factory, legacy).command.converge({ activeApplyIds: [] })
          if (currentVersion === 2) {
            await entered.promise
            expect(isSkillBootVerified(id)).toBe(false)
            expect(state.calls.includes('closed')).toBe(false)
            closing.release()
          }
          const result = await pending
          expect(result).toEqual({ failed: 0, rolledForward: currentVersion === 1 ? 0 : 1 })
          expect(isSkillBootVerified(id)).toBe(currentVersion === 2)
          expect(state.calls.filter((call) => call.startsWith('swap:'))).toEqual(
            currentVersion === 2 ? [`swap:${live}:${publishId}`] : [],
          )
          expect(state.calls.includes('acquire')).toBe(currentVersion !== 1)
          expect(state.calls.includes('closed')).toBe(currentVersion !== 1)
          expect(state.existing.has(live)).toBe(true)
          const row = await harness.db.select().from(skills).where(eq(skills.id, id)).get()
          expect(row?.contentVersion ?? null).toBe(currentVersion)
          expect(
            (
              await harness.db
                .select()
                .from(resourceBundleApplies)
                .where(eq(resourceBundleApplies.id, journalId))
                .get()
            )?.state,
          ).toBe('committed')
        } finally {
          closing.release()
          unmarkSkillBootVerified(id)
        }
      }, 20_000)
    }
  }

  for (const closeFailure of [false, true]) {
    test(`prepared compensation waits for selected close ${closeFailure ? 'failure' : 'ACK'} before journal settlement`, async () => {
      const closing = gate(),
        entered = gate(),
        id = randomUUID()
      const state = model({
        closeWait: closing.promise,
        closeEntered: entered.release,
        ...(closeFailure ? { closeFailure: { error: new Error('logical-close-failed') } } : {}),
      })
      await harness.db.insert(resourceBundleApplies).values({
        id,
        scope: 'package',
        key: id,
        actorUserId: 'logical-actor',
        state: 'prepared',
        preparedArtifactsJson: JSON.stringify([
          {
            kind: 'plugin-install',
            operationId: randomUUID(),
            pluginId: randomUUID(),
            generationId: randomUUID(),
            generationDirectory: 'logical:plugins/generation',
          },
        ]),
        receiptJson: null,
        error: null,
        createdAt: 0,
        updatedAt: 0,
      })
      const pending = compose(new LogicalFactory(state)).command.converge({ activeApplyIds: [] })
      try {
        await entered.promise
        expect(state.calls).toContain('remove:logical:plugins/generation')
        expect(
          (
            await harness.db
              .select()
              .from(resourceBundleApplies)
              .where(eq(resourceBundleApplies.id, id))
              .get()
          )?.state,
        ).toBe('prepared')
      } finally {
        closing.release()
      }
      expect(await pending).toEqual({ failed: closeFailure ? 0 : 1, rolledForward: 0 })
      expect(
        (
          await harness.db
            .select()
            .from(resourceBundleApplies)
            .where(eq(resourceBundleApplies.id, id))
            .get()
        )?.state,
      ).toBe(closeFailure ? 'prepared' : 'failed')
    }, 20_000)
  }

  test('the old full recovery override stays lazy and its new conflicting combination fails explicitly', async () => {
    const calls: string[] = []
    const artifacts = {
      async rollForward() {
        calls.push('forward')
      },
      async compensate() {
        calls.push('compensate')
      },
    }
    const input = {
      db: harness.db,
      get appHome(): string {
        throw new Error('old-override-must-stay-lazy')
      },
      pluginsDir: 'logical:plugins',
      artifacts,
      activitySource: { activeApplyIds: () => [] },
    }
    const existing = composeSqliteResourcePackageApplyMaintenance(input)
    expect(await existing.command.converge({ activeApplyIds: [] })).toEqual({
      failed: 0,
      rolledForward: 0,
    })
    expect(calls).toEqual([])
    expect(() =>
      composeSqliteResourcePackageApplyMaintenance({
        db: harness.db,
        appHome: 'logical:home',
        pluginsDir: input.pluginsDir,
        artifacts,
        activitySource: input.activitySource,
        recoveryEffectsFactory: new LogicalFactory(model()),
      }),
    ).toThrow('resource-package-recovery-selections-conflict')
  }, 20_000)
})
