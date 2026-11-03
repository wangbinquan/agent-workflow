// RFC-370 §10 V20 — memory→skill fusion on a hosted skill store.
//
// Why these tests exist: the fusion orchestration seeded its engine workspace
// from `appHome/skills/<id>/versions/v<n>/files`, read the agent's proposal
// back from a local Git working copy and applied it by copying that directory
// over the skill. On a hosted deployment the skill lives in the database binding
// and the engine task's workspace in its own volume, so `createFusion` always
// failed with `fusion-skill-unversioned` and nothing after it could run.
//
// Here the skill is stored in the DATABASE binding and the engine task port is
// a fake (no filesystem, no Git, no runtime), which is exactly what the
// orchestration may assume now: the seed comes from Resource Catalog, the
// proposal is collected through Task Execution and kept as a candidate tree,
// approval versions the candidate through Resource Catalog, a re-run seeds
// base + overlay, and every settled engine workspace is released.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { beforeEach, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { resolveEffectiveAccountPermissions, type TaskStatus } from '@agent-workflow/shared'
import type { Actor } from '../src/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  approveFusion,
  cancelFusion,
  createFusion,
  reconcileFusion,
  rejectFusion,
  type FusionDeps,
} from '../src/modules/knowledge-evolution/application/fusionOrchestration'
import { composeFusionOperationsFor } from '../src/modules/knowledge-evolution/composition/fusion'
import { composeFusionResourceSeedParticipant } from '../src/modules/resource-catalog/composition/fusionResourceSeed'
import type {
  FusionEngineTaskLaunch,
  FusionEngineTaskOperations,
} from '../src/modules/knowledge-evolution/public/participants'
import type { FusionEngineTaskResult } from '../src/modules/knowledge-evolution/public/types'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'
import {
  composeMemoryCatalogOperations,
  composeSkillMemoryFusionParticipantFactory,
} from '../src/modules/memory/composition'

import { selectSkillContentDependencies } from '../src/modules/resource-catalog/composition/skillContentBinding'
import { composeSkillVersionCommitParticipantFactory } from '../src/modules/resource-catalog/composition/skillVersionCommit'
import { createDatabaseSkillContent } from '../src/modules/resource-catalog/infrastructure/databaseSkillContent'
import { createManagedSkill } from '../src/modules/resource-catalog/infrastructure/legacy/skill'
import { describeEachProvider } from './helpers/eachProvider'
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import { composeSkillApplyRecoveryScene } from '../src/modules/resource-catalog/composition/skillApplyMaintenance'
import {
  resourceScopeAuthority,
  TEST_RESOURCE_SCOPE_AUTHORIZATION,
} from './helpers/resourceScopeAuthority'

const enc = (text: string) => new TextEncoder().encode(text)
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

const adminActor: Actor = {
  user: {
    id: '__system__',
    username: '__system__',
    displayName: 'System',
    role: 'admin',
    status: 'active',
  },
  source: 'daemon',
  permissions: resolveEffectiveAccountPermissions({ role: 'admin', additionalPermissions: [] }),
}

/** The engine task port as KE sees it; nothing here touches a filesystem. */
function fakeEngineTasks() {
  const launches: FusionEngineTaskLaunch[] = []
  const released: string[] = []
  const collected: string[] = []
  const status = new Map<string, TaskStatus>()
  const results = new Map<string, FusionEngineTaskResult>()
  const tasks: FusionEngineTaskOperations = {
    async launch(command) {
      launches.push(command)
      status.set(command.taskId, 'awaiting_human')
    },
    async load(taskId) {
      const current = status.get(taskId)
      return current === undefined
        ? null
        : {
            status: current,
            errorSummary: null,
            worktreePath: `cs-workspace:${taskId}/fusion`,
            baseCommit: 'a'.repeat(40),
          }
    },
    async collect(taskId) {
      collected.push(taskId)
      return results.get(taskId) ?? null
    },
    async release(taskId) {
      released.push(taskId)
    },
    async cancel(taskId) {
      status.set(taskId, 'canceled')
    },
  }
  return { tasks, launches, released, collected, status, results }
}

interface Harness {
  db: PersistenceDb
  deps: FusionDeps
  engine: ReturnType<typeof fakeEngineTasks>
  skillId: string
  memoryId: string
  candidateTrees: () => Promise<string[]>
  versionTree: (version: number) => Promise<Record<string, string>>
}

describeEachProvider(
  'RFC-370 §10 V20 fusion orchestration on the database skill binding',
  (harness) => {
    let h: Harness
    // RFC-401 T5：注入一次「提交之后、发布 live 时失败」。
    let failNextPublish = false
    beforeEach(async () => {
      failNextPublish = false
      const appHome = mkdtempSync(join(tmpdir(), 'aw-v20-fusion-'))
      const db = harness.db
      const stored = createDatabaseSkillContent({ db })
      const binding = {
        ...stored,
        versionContent: {
          ...stored.versionContent,
          async publish(...args: Parameters<typeof stored.versionContent.publish>) {
            if (failNextPublish) {
              failNextPublish = false
              throw new Error('live publish interrupted')
            }
            await stored.versionContent.publish(...args)
          },
        },
      }
      const skill = await createManagedSkill(db, selectSkillContentDependencies(binding, appHome), {
        name: 'lint',
        description: 'd',
        bodyMd: 'SNAPSHOT-BODY',
        frontmatterExtra: {},
      })
      // Nothing of the skill may live on the local disk.
      rmSync(appHome, { recursive: true, force: true })
      const memoryId = ulid()
      const { memories } = tablesOf(db),
        { skillContentEntries } = tablesOf(db)
      await insertOne(db, memories, {
        id: memoryId,
        scopeType: 'global',
        scopeId: null,
        title: 'two spaces',
        bodyMd: 'indent with two spaces',
        tags: '[]',
        status: 'approved',
        sourceKind: 'manual',
        createdAt: Date.now(),
        version: 1,
      })
      const engine = fakeEngineTasks()
      const operations = composeFusionOperationsFor({
        resourceSeed: composeFusionResourceSeedParticipant(),
        memoryMembership: composeSkillMemoryFusionParticipantFactory(),
        skillVersionCommit: composeSkillVersionCommitParticipantFactory({ skillContent: binding }),
        db,
        appHome,
        memories: composeMemoryCatalogOperations({
          db,
          contexts: composeIdentityAccess(db).contexts,
          authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
        }),
        tasks: engine.tasks,
      })
      const trees = async (prefix: string) => {
        return [
          ...new Set(
            (
              await db
                .select({ tree: skillContentEntries.tree })
                .from(skillContentEntries)
                .where(eq(skillContentEntries.skillId, skill.id))
            ).map((row) => row.tree),
          ),
        ].filter((tree) => tree.startsWith(prefix))
      }
      h = {
        db,
        deps: { operations },
        engine,
        skillId: skill.id,
        memoryId,
        candidateTrees: () => trees('candidate:'),
        versionTree: async (version) =>
          Object.fromEntries(
            (await operations.skillTrees.readVersionTree({ skillId: skill.id, version }))!.map(
              (entry) => [entry.path, dec(entry.content)],
            ),
          ),
      }
    })

    const launch = () =>
      createFusion(
        { skillId: h.skillId, memoryIds: [h.memoryId], intent: 'tidy up' },
        h.deps,
        resourceScopeAuthority(h.db, adminActor),
        'api',
      )

    function settleWithProposal(
      taskId: string,
      body: string,
      manifest?: FusionEngineTaskResult['manifest'],
    ) {
      h.engine.status.set(taskId, 'done')
      h.engine.results.set(taskId, {
        diff: `diff --git a/SKILL.md b/SKILL.md\n+${body}`,
        manifest: manifest ?? {
          kind: 'file',
          text: JSON.stringify({
            incorporatedMemoryIds: [h.memoryId],
            skipped: [],
            changelog: 'Integrated the two-space rule.',
          }),
        },
        files: [
          { path: 'SKILL.md', content: enc(`---\nname: lint\ndescription: d\n---\n${body}`) },
          { path: 'assets/rule.bin', content: new Uint8Array([0, 1, 255]) },
        ],
      })
    }

    async function row(id: string) {
      const { fusions } = tablesOf(h.db)
      return (await h.db.select().from(fusions).where(eq(fusions.id, id)))[0]!
    }

    test('createFusion on the database skill binding seeds the engine task from the v1 snapshot bytes', async () => {
      const fusion = await launch()
      expect(fusion.status).toBe('running')
      expect(h.engine.launches).toHaveLength(1)
      const command = h.engine.launches[0]!
      expect(command).toMatchObject({
        fusionId: fusion.id,
        iteration: 1,
        taskId: fusion.currentTaskId,
      })
      expect(command.seed.overlay).toBeNull()
      expect(dec(command.seed.base.find((entry) => entry.path === 'SKILL.md')!.content)).toContain(
        'SNAPSHOT-BODY',
      )
    })

    test('a hosted skill without its version snapshot still fails closed (no live fallback)', async () => {
      const { skillContentEntries } = tablesOf(h.db)
      await h.db
        .delete(skillContentEntries)
        .where(
          and(
            eq(skillContentEntries.skillId, h.skillId),
            eq(skillContentEntries.tree, 'version:1'),
          ),
        )
      await expect(launch()).rejects.toMatchObject({ code: 'fusion-skill-unversioned' })
      expect(h.engine.launches).toHaveLength(0)
    })

    test('reconcile keeps the proposal as a candidate tree, then approval versions it in the database store', async () => {
      const fusion = await launch()
      const taskId = fusion.currentTaskId!
      settleWithProposal(taskId, 'fused body (2 spaces)')
      await reconcileFusion(h.deps, fusion.id)
      const proposed = await row(fusion.id)
      expect(proposed.status).toBe('awaiting_approval')
      expect(proposed.proposedWorktreePath).toMatch(/^skill-candidate:[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(proposed.proposedDiff).toContain('fused body')
      expect(await h.candidateTrees()).toHaveLength(1)
      // The settled engine workspace is given back once its proposal is captured.
      expect(h.engine.released).toEqual([taskId])

      const done = await approveFusion(h.deps, fusion.id, adminActor)
      expect(done.status).toBe('done')
      expect(done.appliedSkillVersion).toBe(2)
      expect(await h.versionTree(2)).toMatchObject({
        'SKILL.md': expect.stringContaining('fused body (2 spaces)'),
        'assets/rule.bin': dec(new Uint8Array([0, 1, 255])),
      })
      const { memories } = tablesOf(h.db),
        { skills } = tablesOf(h.db)
      expect(
        (await h.db.select().from(skills).where(eq(skills.id, h.skillId)))[0]!.contentVersion,
      ).toBe(2)
      expect(
        (await h.db.select().from(memories).where(eq(memories.id, h.memoryId)))[0],
      ).toMatchObject({
        status: 'fused',
        fusedIntoSkillVersion: 2,
        fusedFusionId: fusion.id,
      })
      expect(await h.candidateTrees()).toEqual([])
    })

    // proposal §5 第 12 项：版本、记忆标记与 applying → done 同一事务；提交之后发布 live 失败时，融合仍是 done，与持久的
    // 版本行一致，approve 照常返回；发布与候选清理由 AtomicApply 恢复前滚。此前这里把融合记为 failed 而版本已提交。
    test('a live publish failure after commit leaves the fusion done; recovery publishes the version', async () => {
      const fusion = await launch()
      settleWithProposal(fusion.currentTaskId!, 'fused body (2 spaces)')
      await reconcileFusion(h.deps, fusion.id)
      failNextPublish = true
      const done = await approveFusion(h.deps, fusion.id, adminActor)
      expect(done).toMatchObject({ status: 'done', appliedSkillVersion: 2 })
      const { skills, memories, skillApplyJournal, skillOperationLocks } = tablesOf(h.db)
      expect(
        (await h.db.select().from(skills).where(eq(skills.id, h.skillId)))[0]!.contentVersion,
      ).toBe(2)
      expect(
        (await h.db.select().from(memories).where(eq(memories.id, h.memoryId)))[0],
      ).toMatchObject({ status: 'fused', fusedIntoSkillVersion: 2 })
      const journal = (
        await h.db.select().from(skillApplyJournal).where(eq(skillApplyJournal.skillId, h.skillId))
      ).find((entry) => entry.operation === 'version')!
      expect(journal.state).toBe('committed')
      // 尾部未完成：锁仍归这条 journal，候选树还在。
      expect((await h.db.select().from(skillOperationLocks)).map((lock) => lock.opId)).toEqual([
        journal.id,
      ])
      expect(await h.candidateTrees()).toHaveLength(1)
      const recovered = await createAtomicApplyRecovery([
        composeSkillApplyRecoveryScene({ db: h.db, appHome: tmpdir() }),
      ]).converge({ skill: [] })
      expect(recovered).toEqual({ failed: 0, rolledForward: 1 })
      expect(await h.db.select().from(skillOperationLocks)).toEqual([])
      expect(await h.candidateTrees()).toEqual([])
      const { skillContentEntries } = tablesOf(h.db)
      const live = await h.db
        .select()
        .from(skillContentEntries)
        .where(
          and(eq(skillContentEntries.skillId, h.skillId), eq(skillContentEntries.tree, 'live')),
        )
      expect(live.map((entry) => entry.path).sort()).toEqual(['SKILL.md', 'assets/rule.bin'])
    })

    test('a re-run seeds the current version as baseline with the prior proposal as its overlay', async () => {
      const fusion = await launch()
      settleWithProposal(fusion.currentTaskId!, 'first attempt')
      await reconcileFusion(h.deps, fusion.id)
      const rerun = await rejectFusion(h.deps, fusion.id, 'shorter please', adminActor, 'api')
      expect(rerun.iteration).toBe(2)
      const command = h.engine.launches[1]!
      expect(command).toMatchObject({
        fusionId: fusion.id,
        iteration: 2,
        taskId: rerun.currentTaskId,
      })
      expect(dec(command.seed.base.find((entry) => entry.path === 'SKILL.md')!.content)).toContain(
        'SNAPSHOT-BODY',
      )
      expect(
        dec(command.seed.overlay!.find((entry) => entry.path === 'SKILL.md')!.content),
      ).toContain('first attempt')
      expect((await row(fusion.id)).proposedWorktreePath).toBeNull()
      expect(await h.candidateTrees()).toEqual([])
    })

    test('a manifest-less result fails the fusion and still releases the engine workspace', async () => {
      const fusion = await launch()
      const taskId = fusion.currentTaskId!
      settleWithProposal(taskId, 'whatever', { kind: 'missing' })
      await reconcileFusion(h.deps, fusion.id)
      expect(await row(fusion.id)).toMatchObject({
        status: 'failed',
        error: 'agent did not write the fusion result manifest',
      })
      expect(h.engine.released).toEqual([taskId])
      expect(await h.candidateTrees()).toEqual([])
    })

    test('cancel releases the engine workspace and drops a pending candidate', async () => {
      const fusion = await launch()
      settleWithProposal(fusion.currentTaskId!, 'pending decision')
      await reconcileFusion(h.deps, fusion.id)
      expect(await h.candidateTrees()).toHaveLength(1)
      h.engine.released.length = 0
      const canceled = await cancelFusion(h.deps, fusion.id, adminActor)
      expect(canceled.status).toBe('canceled')
      expect(h.engine.released).toEqual([fusion.currentTaskId!])
      expect(await h.candidateTrees()).toEqual([])
    })

    test('a proposal recorded before V20 (a local work directory) is collected again when approved', async () => {
      const fusion = await launch()
      const taskId = fusion.currentTaskId!
      settleWithProposal(taskId, 'legacy proposal')
      const { fusions } = tablesOf(h.db)
      await h.db
        .update(fusions)
        .set({
          status: 'awaiting_approval',
          proposedWorktreePath: '/home/aw/fusions/legacy/iter1/work',
          proposedDiff: 'diff',
          incorporatedMemoryIdsJson: JSON.stringify([h.memoryId]),
          skippedJson: '[]',
          changelog: 'legacy',
        })
        .where(eq(fusions.id, fusion.id))
      const done = await approveFusion(h.deps, fusion.id, adminActor)
      expect(done.status).toBe('done')
      expect(h.engine.collected).toContain(taskId)
      expect((await h.versionTree(2))['SKILL.md']).toContain('legacy proposal')
    })
  },
)

test('the orchestration has no filesystem, Git or Source Control dependency of its own (source lock)', () => {
  const source = readFileSync(
    join(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'knowledge-evolution',
      'application',
      'fusionOrchestration.ts',
    ),
    'utf8',
  )
  expect(source).not.toMatch(/from 'node:(?:fs|path)'/)
  expect(source).not.toContain("from '@/util/git'")
  expect(source).not.toContain('@/modules/source-control')
})
