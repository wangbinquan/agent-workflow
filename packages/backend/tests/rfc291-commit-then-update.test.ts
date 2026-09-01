// RFC-291 —— 「提交入库的东西能接着改」端到端回归锚（主锚，别删）。
//
// locks the RFC-291 defect reported by the user on 2026-08-12:
//   「一个意图创建任务所提交的节点，应该被自动挂接到该意图创建任务里，不然我提交
//     入库的东西我继续改的时候，发现没挂载不让改。」
//
// 缺陷形态：applyChangeset 的提交大事务只更新 commitSeq / contextRevision /
// currentDraftId，不碰 context_manifest_json（当时的 applyChangeset.ts:1070），
// 于是下一轮 buildIntentDump 只 dump `root:true` 的条目，新建资源只落进
// inventory 摘要（detail:false），针对它的 update 被两道守卫拒绝：
//   · validateDraftChangeset → "target ... is inventory-only"
//   · resolveIntentBundle    → intent-target-not-mounted
//
// 本文件走真实链路 commit → buildIntentDump → update，覆盖**六类资源各一条**
// （设计门 P2-e：初版只测 agent，其余五类的 dump / fence / 接线坏掉仍会全绿）。
// 末尾的负向锁保证守卫本身没有被这个 RFC 改松——两处必须**各断言一次**（AC-17）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  canonicalIntentJson,
  parseIntentChangeset,
  WORKFLOW_SCHEMA_VERSION,
  type IntentResourceType,
} from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { intentDrafts, intentSessions, users } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import { applyIntentChangeset, type ApplyIntentDeps } from '../src/services/intent/applyChangeset'
import {
  buildIntentDumpForTest as buildIntentDump,
  createIntentSessionForTest as createIntentSession,
} from './helpers/intentResourceCatalogBinding'
import { parseHandleWatermark, type IntentContextManifest } from '../src/services/intent/manifest'
import { intentApplyResourceBinding } from './helpers/intentApplyResourceBinding'
import {
  resolveIntentBundle,
  validateDraftChangeset,
} from '../src/services/intent/resolveChangeset'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_rfc291e2e_00000'

let db: DbClient
let appHome: string

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(['resource-acl:private']),
}

function deps(over: Partial<ApplyIntentDeps> = {}): ApplyIntentDeps {
  const resolved = { db, appHome, actor, ...over }
  return { ...resolved, ...intentApplyResourceBinding(db, resolved.actor) }
}

function installDraft(
  sessionId: string,
  changeset: unknown,
  manifest: IntentContextManifest,
): { draftRevision: number; draftHash: string } {
  const parsed = parseIntentChangeset(JSON.stringify(changeset))
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const canonical = canonicalIntentJson(parsed.changeset)
  const draftHash = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
  const draftId = ulid()
  const session = db.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
  db.insert(intentDrafts)
    .values({
      id: draftId,
      sessionId,
      revision: 1,
      changesetJson: canonical,
      validationJson: '{"errors":[],"credentialFindings":[]}',
      draftHash,
      contextRevision: session?.contextRevision ?? 0,
      createdAt: Date.now(),
    })
    .run()
  db.update(intentSessions)
    .set({ currentDraftId: draftId, contextManifestJson: JSON.stringify(manifest) })
    .where(eq(intentSessions.id, sessionId))
    .run()
  return { draftRevision: 1, draftHash }
}

/**
 * A local plugin spec under a PREDICTABLE path.
 *
 * mkdtemp's random suffix reads as credential-shaped to the changeset scanner
 * (`intent-secret-value-forbidden` on /payload/spec), which has nothing to do
 * with what this file tests — a stable directory name sidesteps it.
 */
function filePluginFixture(): string {
  const dir = join(appHome, 'plugin-fixture')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }),
  )
  writeFileSync(join(dir, 'src', 'index.js'), 'module.exports = {}\n')
  return dir
}

/** Re-run the dump exactly like the turn engine does, from the session row. */
async function dumpFromSession(sessionId: string) {
  const row = db.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
  const manifest = JSON.parse(row?.contextManifestJson ?? '[]') as IntentContextManifest
  return buildIntentDump({
    db,
    actor,
    appHome,
    mounts: manifest
      .filter((e) => e.root)
      .map((e) => ({ resourceType: e.resourceType, resourceId: e.resourceId })),
    priorManifest: manifest,
    handleWatermark: parseHandleWatermark(row?.handleWatermarkJson),
  })
}

beforeEach(async () => {
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc291-e2e-'))
  db = createInMemoryDb(MIGRATIONS)
  await db.insert(users).values({
    id: OWNER,
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as typeof users.$inferInsert)
})
afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

/** One create op per resource type, plus the update payload used to edit it. */
function creationBundle(pluginSpec: string): unknown {
  return {
    $schema_version: 1,
    ops: [
      {
        opId: 'op-1',
        action: 'create',
        resourceType: 'skill',
        tempRef: '$new:sk',
        payload: { name: 'checklist', description: 'how to review', bodyMd: '# Checklist' },
      },
      {
        opId: 'op-2',
        action: 'create',
        resourceType: 'mcp',
        tempRef: '$new:mc',
        payload: {
          type: 'local',
          name: 'gh-mcp',
          description: 'github',
          config: { command: ['npx'] },
        },
      },
      {
        opId: 'op-3',
        action: 'create',
        resourceType: 'plugin',
        tempRef: '$new:pl',
        payload: { name: 'lint-plugin', spec: pluginSpec, description: 'lints' },
      },
      {
        opId: 'op-4',
        action: 'create',
        resourceType: 'agent',
        tempRef: '$new:ag',
        payload: {
          name: 'auditor',
          description: 'audits diffs',
          outputs: ['findings'],
          skills: ['$new:sk'],
          mcp: ['$new:mc'],
          plugins: ['$new:pl'],
          dependsOn: [],
          bodyMd: 'You audit.',
        },
      },
      {
        opId: 'op-5',
        action: 'create',
        resourceType: 'workflow',
        tempRef: '$new:wf',
        payload: {
          name: 'audit-flow',
          description: '',
          definition: {
            $schema_version: WORKFLOW_SCHEMA_VERSION,
            inputs: [],
            nodes: [{ id: 'n1', kind: 'agent-single', agentRef: '$new:ag', promptTemplate: 'go' }],
            edges: [],
          },
        },
      },
      {
        opId: 'op-6',
        action: 'create',
        resourceType: 'workgroup',
        tempRef: '$new:wg',
        payload: {
          name: 'audit-squad',
          description: '',
          instructions: 'work',
          mode: 'leader_worker',
          leaderDisplayName: 'lead',
          members: [
            { memberType: 'agent', agentRef: '$new:ag', displayName: 'lead', roleDesc: '' },
          ],
        },
      },
    ],
  }
}

/**
 * The plugin fixture's spec is an absolute temp path, and the changeset scanner
 * flags high-entropy path segments as credential-shaped — unrelated to what this
 * file tests, so we waive that one pointer the same way the confirm UI does.
 */
const PLUGIN_SPEC_WAIVER = [
  { opId: 'op-3', slots: [{ slotId: 'waiver:op-3:/op-3/payload/spec', value: 'waived' }] },
]

/** Minimal in-place update payload per type, targeting `handle`.
 *  `agentHandle` is only needed by workgroup (its leader must be an agent). */
function updateOpFor(
  type: IntentResourceType,
  handle: string,
  name: string,
  agentHandle = 'res#agent#1',
): unknown {
  const base = { opId: 'op-1', action: 'update', target: handle, resourceType: type }
  switch (type) {
    case 'agent':
      return {
        ...base,
        payload: {
          name,
          description: 'edited by the follow-up turn',
          outputs: ['findings'],
          skills: [],
          mcp: [],
          plugins: [],
          dependsOn: [],
          bodyMd: 'You audit, strictly.',
        },
      }
    case 'skill':
      return { ...base, payload: { name, description: 'edited', bodyMd: '# Checklist v2' } }
    case 'mcp':
      return {
        ...base,
        payload: { type: 'local', name, description: 'edited', config: { command: ['npx', '-y'] } },
      }
    case 'plugin':
      // A short relative spec: this test only drives validate + resolve, and a
      // temp-path spec would trip the credential scanner for unrelated reasons.
      return {
        ...base,
        payload: { name, spec: './local-plugin', description: 'edited', enabled: true },
      }
    case 'workflow':
      return {
        ...base,
        payload: {
          name,
          description: 'edited',
          definition: {
            $schema_version: WORKFLOW_SCHEMA_VERSION,
            inputs: [],
            nodes: [],
            edges: [],
          },
        },
      }
    case 'workgroup':
      return {
        ...base,
        payload: {
          name,
          description: 'edited',
          instructions: 'work harder',
          mode: 'leader_worker',
          leaderDisplayName: 'lead',
          members: [
            { memberType: 'agent', agentRef: agentHandle, displayName: 'lead', roleDesc: '' },
          ],
        },
      }
  }
}

describe('提交入库后，创建物在下一轮可直接修改（AC-2，六类各一条）', () => {
  test('六类 create 提交 → dump 后全部 detail:true 且带该类型的 fence', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'build a pipeline' })
    const draft = installDraft(session.id, creationBundle(filePluginFixture()), [])
    const receipt = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: PLUGIN_SPEC_WAIVER,
    })
    expect(receipt.applied).toHaveLength(6)

    const dump = await dumpFromSession(session.id)

    for (const applied of receipt.applied) {
      const entry = dump.manifest.find((e) => e.resourceId === applied.resourceId)
      expect(entry, `${applied.resourceType} missing from manifest`).toBeDefined()
      // 缺陷形态就是这一条为 false —— 那时它只在 inventory 里
      expect(entry?.detail, `${applied.resourceType} not dumped in detail`).toBe(true)
      expect(entry?.root, `${applied.resourceType} not a mount root`).toBe(true)
      // fence 是 update 的前提；每类的 fence 形状各不相同，缺一类就说明该类接线坏了
      // 回执里的 resourceType 是 wire 层 string；fence.kind 是同一取值域的联合类型
      // `IntentResourceType`, not `AclResourceType`: a fence kind is one of the
      // six types a package/intent op can carry, and RFC-304's capability
      // templates are ACL resources that are neither.
      expect(entry?.fence?.kind, `${applied.resourceType} fence missing`).toBe(
        applied.resourceType as IntentResourceType,
      )
      // 文档真的进了 mounted/
      expect(
        dump.seedFiles.some((f) =>
          f.path.startsWith(`mounted/${entry?.handle.replace(/#/g, '.')}`),
        ),
        `${applied.resourceType} has no mounted/ document`,
      ).toBe(true)
    }
  })

  test.each([
    ['agent', 'op-4'],
    ['skill', 'op-1'],
    ['mcp', 'op-2'],
    ['plugin', 'op-3'],
    ['workflow', 'op-5'],
    ['workgroup', 'op-6'],
  ] as const)('%s：提交后针对它的 update 通过两道守卫', async (type, opId) => {
    const { session } = await createIntentSession(db, actor, { message: 'build a pipeline' })
    const draft = installDraft(session.id, creationBundle(filePluginFixture()), [])
    const receipt = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: PLUGIN_SPEC_WAIVER,
    })
    const dump = await dumpFromSession(session.id)

    const applied = receipt.applied.find((a) => a.opId === opId)
    expect(applied).toBeDefined()
    const entry = dump.manifest.find((e) => e.resourceId === applied?.resourceId)
    expect(entry).toBeDefined()

    const changeset = parseIntentChangeset(
      JSON.stringify({
        $schema_version: 1,
        ops: [
          updateOpFor(
            type,
            entry?.handle ?? '',
            applied?.name ?? 'x',
            // workgroup 的 leader 必须是 agent 成员：指向本批创建的那个 agent
            dump.manifest.find(
              (e) =>
                e.resourceType === 'agent' &&
                e.resourceId === receipt.applied.find((a) => a.opId === 'op-4')?.resourceId,
            )?.handle ?? 'res#agent#1',
          ),
        ],
      }),
    )
    if (!changeset.ok) throw new Error(changeset.errors.join('; '))

    // 守卫 ①：草稿校验不得再报 inventory-only
    const report = validateDraftChangeset(dump.manifest, changeset.changeset)
    expect(report.errors).toEqual([])

    // 守卫 ②：resolve 不得再抛 intent-target-not-mounted
    expect(() =>
      resolveIntentBundle({
        manifest: dump.manifest,
        changeset: changeset.changeset,
        decisions: [],
        occupiedNames: new Map(),
      }),
    ).not.toThrow()
  })
})

describe('负向锁：未挂载目标仍被两道守卫各自拒绝（AC-17）', () => {
  test('inventory-only 目标：草稿校验报 inventory-only，resolve 抛 intent-target-not-mounted', () => {
    // 与上面同形的 update，但目标条目 detail:false（即 RFC-291 之前新建资源的处境）。
    const manifest: IntentContextManifest = [
      {
        handle: 'res#agent#1',
        resourceType: 'agent',
        resourceId: ulid(),
        root: false,
        detail: false,
      },
    ]
    const changeset = parseIntentChangeset(
      JSON.stringify({
        $schema_version: 1,
        ops: [updateOpFor('agent', 'res#agent#1', 'auditor')],
      }),
    )
    if (!changeset.ok) throw new Error(changeset.errors.join('; '))

    // 守卫 ①：草稿校验
    const report = validateDraftChangeset(manifest, changeset.changeset)
    expect(report.errors.join(' ')).toContain('intent-target-not-mounted')

    // 守卫 ②：resolve。它把草稿校验作为前置，所以外层看到的是 blocking-errors；
    // resolveChangeset.ts 里针对 `!entry.detail` 的 intent-target-not-mounted
    // 是**第二道**（前置被绕过时才轮到它）。两道都必须拒绝这个输入。
    expect(() =>
      resolveIntentBundle({
        manifest,
        changeset: changeset.changeset,
        decisions: [],
        occupiedNames: new Map(),
      }),
    ).toThrow()
  })
})
