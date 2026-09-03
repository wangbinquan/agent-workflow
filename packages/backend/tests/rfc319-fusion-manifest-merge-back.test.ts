// RFC-319 B29 —— 融合的结果清单必须能穿过逐节点隔离边界。
//
// 2026-08-24 实测缺陷（`docs/audit-backlog.md` 有完整根因链）：merger 节点和其它
// agent 节点一样跑在**逐节点隔离工作树**里，产品契约要它把结果清单写进
// `.agent-workflow/fusion/result.json`，而平台自己的排除档把整个
// `.agent-workflow/` 写进了工作树的 git ignore，逐节点 merge-back 又是 git 驱动
// 的——于是清单永远回不到 `task.worktreePath`，`reconcileFusion` 每次都判
// `agent did not write the fusion result manifest`。**任何一次由真实 agent 执行的
// 融合都必然失败**，而融合是产品里唯一一条会改写托管技能正文并递增版本的链路。
//
// 为什么此前没有任何测试照出来：`fusion-engine.test.ts` 把清单**直接写进
// `task.worktreePath`** 并把任务行强制置 `done`，从不跨越隔离边界——它验的是
// reconcile 之后的逻辑，不是 agent → 框架这一段。
//
// 这条用例锁的就是那一段：融合启动时必须把清单路径登记进任务的
// **force-include 名册**（`tasks.platform_input_paths_json`），
// 那是被 ignore 的路径能被 merge-back 带回来的唯一逃生门
// （`services/portArtifacts.ts:535` `forcedPortPathsForTask`）。
//
// 端到端那一半由 `e2e/fusion-lifecycle.spec.ts` 用真实 agent 跑完整条链验证；
// 这里留一条快的、不依赖运行时的判据，让「谁把这行删了」当场变红。

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pjoin, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  PLATFORM_FUSION_MANIFEST,
  resolveEffectiveAccountPermissions,
} from '@agent-workflow/shared'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { fusions, memories, skills, tasks } from '../src/db/schema'
import {
  createFusion as createFusionWithAuthority,
  type FusionDeps,
} from '../src/modules/knowledge-evolution/application/fusionOrchestration'
import { forcedPortPathsForTask } from '../src/services/portArtifacts'
import { createRuntime } from '../src/services/runtimeRegistry'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'
import { composeSqliteMemoryCatalogOperations } from '../src/modules/memory/composition'
import { composeSqliteFusionOperations } from '../src/modules/knowledge-evolution/composition/fusion'
import {
  createManagedSkill,
  type SkillFsOptions,
} from '../src/modules/resource-catalog/infrastructure/legacy/skill'
import { createSqliteFusionEngineTaskOperations } from '../src/modules/task-execution/infrastructure/fusionEngineTaskOperations'
import { createSqliteTaskExecutionPersistence } from '../src/modules/task-execution/composition/taskExecutionPersistence'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'
import { runtimeRegistryPersistence } from './helpers/runtimeRegistryPersistence'
import {
  resourceScopeAuthority,
  TEST_RESOURCE_SCOPE_AUTHORIZATION,
} from './helpers/resourceScopeAuthority'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const VALID_OPENCODE_RUNTIME = 'rfc319-test-opencode'

type TestFusionDeps = FusionDeps & { readonly db: DbClient }

function createFusion(
  input: Parameters<typeof createFusionWithAuthority>[0],
  deps: TestFusionDeps,
  actor: Actor,
  launchInitiator: Parameters<typeof createFusionWithAuthority>[3],
) {
  return createFusionWithAuthority(
    input,
    deps,
    resourceScopeAuthority(deps.db, actor),
    launchInitiator,
  )
}

setDefaultTimeout(60_000)

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

/** Parks the task on a clarify round so the fusion stays `running` (see fusion-engine.test.ts). */
function makeClarifyStub(dir: string): string[] {
  const path = pjoin(dir, 'stub-opencode.ts')
  writeFileSync(
    path,
    `const argv = Bun.argv.slice(2)
if (argv[0] === '--version') { console.log('stub-opencode 1.14.99'); process.exit(0) }
if (argv[0] === 'run') {
  const nonce = /nonce="([^"]*)"/.exec(argv.join('\\n'))?.[1] ?? ''
  const open = nonce.length > 0 ? \`<workflow-clarify nonce="\${nonce}">\` : '<workflow-clarify>'
  const questions = '{"questions":[{"id":"q1","title":"Proceed?","kind":"single","options":[{"label":"yes"}]}]}'
  console.log(JSON.stringify({ type: 'text', ts: 0, text: \`\${open}\${questions}</workflow-clarify>\` }))
  process.exit(0)
}
process.exit(1)
`,
  )
  return [process.execPath, path]
}

interface Harness {
  db: DbClient
  appHome: string
  deps: TestFusionDeps
  cleanup: () => void
}

async function build(): Promise<Harness> {
  const tmp = mkdtempSync(pjoin(tmpdir(), 'aw-rfc319-fusion-manifest-'))
  const appHome = pjoin(tmp, 'home')
  const db = createInMemoryDb(MIGRATIONS)
  await createRuntime(runtimeRegistryPersistence(db), {
    name: VALID_OPENCODE_RUNTIME,
    protocol: 'opencode',
    model: 'openai/gpt-5.6',
  })
  const schedulerDriver = createTaskExecutionTestTopology({ db, driver: 'real' }).schedulerDriver
  const memoryCatalog = composeSqliteMemoryCatalogOperations({
    db,
    contexts: composeIdentityAccess(db).contexts,
    authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
  })
  return {
    db,
    appHome,
    deps: {
      db,
      operations: composeSqliteFusionOperations({
        db,
        appHome,
        memories: memoryCatalog,
        tasks: createSqliteFusionEngineTaskOperations({ db, appHome, schedulerDriver }),
      }),
      appHome,
      binaryOverride: makeClarifyStub(tmp),
      awaitScheduler: true,
      defaultRuntime: VALID_OPENCODE_RUNTIME,
    },
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

function approvedGlobalMemory(db: DbClient, title: string): string {
  const id = ulid()
  db.insert(memories)
    .values({
      id,
      scopeType: 'global',
      scopeId: null,
      title,
      bodyMd: `body of ${title}`,
      tags: '[]',
      status: 'approved',
      sourceKind: 'manual',
      createdAt: Date.now(),
      version: 1,
    })
    .run()
  return id
}

describe('RFC-319 —— 融合结果清单穿越隔离边界', () => {
  let h: Harness
  beforeEach(async () => (h = await build()))
  afterEach(() => h.cleanup())

  test('融合任务把结果清单登记进 force-include 名册（否则 merge-back 会按 ignore 丢掉它）', async () => {
    await createManagedSkill(h.db, { appHome: h.appHome } as SkillFsOptions, {
      name: 'lint',
      description: 'd',
      bodyMd: 'v1',
      frontmatterExtra: {},
    })
    const skillId = h.db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.name, 'lint'))
      .get()!.id
    const memoryId = approvedGlobalMemory(h.db, 'two spaces')

    const fusion = await createFusion(
      { skillId, memoryIds: [memoryId], intent: '' },
      h.deps,
      adminActor,
      'api',
    )
    const taskId = h.db
      .select({ currentTaskId: fusions.currentTaskId })
      .from(fusions)
      .where(eq(fusions.id, fusion.id))
      .get()!.currentTaskId
    expect(taskId, '融合没有关联任务 ⇒ 下面的判据无从谈起').not.toBeNull()

    const roster = h.db
      .select({ json: tasks.platformInputPathsJson, spaceKind: tasks.spaceKind })
      .from(tasks)
      .where(eq(tasks.id, taskId!))
      .get()!
    expect(roster.spaceKind, 'force-include 名册只对 internal 空间开放').toBe('internal')
    expect(
      roster.json === null ? [] : (JSON.parse(roster.json) as string[]),
      '融合任务没有登记结果清单路径。被 ignore 的路径要跨过逐节点隔离边界只有这一条' +
        '逃生门；名册为空 ⇒ 真实 agent 写下的清单会被 merge-back 静默丢弃，' +
        'reconcileFusion 随后判「agent did not write the fusion result manifest」',
    ).toContain(PLATFORM_FUSION_MANIFEST)

    expect(
      await forcedPortPathsForTask(
        createSqliteTaskExecutionPersistence(h.db).artifactPaths,
        taskId!,
      ),
      '名册的消费端（createNodeIso / snapshotNodeIsoFinal 的 force-include 清单）' +
        '必须真的看到这条路径——只写进任务行而消费端读不到，等于没登记',
    ).toContain(PLATFORM_FUSION_MANIFEST)
  })
})
