// RFC-359 —— 资源包里**引用解析**的 fail-closed 判据，在统一 apply 引擎上、两个 provider 各问一遍。
//
// # 这份文件是一次退役的对账（plan §5dy）
//
// 这些判据原本锁在 `services/bundle/refs.ts` 上（`rfc271-builtin-resolve` 的两组单测），
// 而那一层属于**通用 bundle 引擎**、随资源包 apply 合一退役。统一引擎里同一件事由
// `resolveIdentityReference` / `resolveAgentSkillReference` 做
// （`postgresqlResourcePackageMutationArms.ts`）。删掉旧层之前，把它的 fail-closed 形状
// 在**用户真会走的那条路**上重问一遍——而且是两个引擎都问，旧的那组只跑 SQLite。
//
// 「fail-closed」在这里的含义很具体：引用解析不出来时**必须抛**，不能留悬空引用、
// 不能静默降级成「按名字猜一个」。下面每一条都同时断言**错误码**与**零副作用**
// （一行都没写进去）——只断言抛错会放过「写了一半才抛」。
//
// 覆盖验收条款：AC-15b（服务端重算，客户端传来的只是意向）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）
//
// # 覆盖的验收条款
//
// **AC-15b**：服务端在 commit 时**重算**判据，客户端传来的只是意向——这四例都是
// 「客户端把一个解析不出来的引用塞进包里」，服务端一律自己重算并拒绝。
// 原锚点在 `rfc271-builtin-resolve` 那两组单测上，随 `services/bundle/refs.ts` 退役搬到这里
// （plan §5dy）。
//
// # 实测结论：活着那条路**拦得比退役那层更早**
//
// 旧单测是直接喂 `resolveIdentityRef`，所以它看到的是 apply 期的码
// （`bundle-builtin-missing` / `bundle-ref-invalid`）。走完整路径之后，这四种坏引用里：
//   · 缺 built-in ⇒ **preview 期**就报 `package-builtin-missing`（连 apply 都进不去）；
//   · `agent.skills` 里塞 built-in、`local:` 指错类型 ⇒ **parse 期**的 bundle schema 就拒了
//     （`package-invalid`），根本到不了引用解析层。
// 也就是说不变量不但还在，而且前移了一道门。判据因此锁「**被哪一道门拦下**」这件事本身
// （逐例写死实测到的码），而不是锁某一层的内部码——后者会把「拦得更早」误判成回归。

import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { agents, mcps, users } from '@/db/schema'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { encodeZip } from '@/util/zip'
import { describeEachProvider } from './helpers/eachProvider'
import { commitResourcePackageForTest } from './helpers/resourcePackageApply'
import { buildPackagePreview } from './helpers/resourcePackageProvider'
import { removeTempDirSync } from './fixtures/tempDir'

const OWNER = 'w14-refs-owner'
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
const roots: string[] = []

interface OpSpec {
  readonly opId: string
  readonly kind: string
  readonly slug: string
  readonly payload: Record<string, unknown>
}

const agentPayload = (
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name,
  description: '',
  outputs: [],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '',
  ...extra,
})

/**
 * `manifest.builtins` 必须与 bundle 里实际出现的 `builtin:` 引用**逐项对齐**（parse 期的判据），
 * 所以夹具要把用到的 built-in 一并声明出来——这条判据本身不是这里要测的，别让它先把包挡在门外。
 */
function packageOf(
  ops: readonly OpSpec[],
  rootSlug: string,
  builtins: readonly { type: 'agent' | 'workflow'; name: string }[] = [],
): Uint8Array {
  const resourceLines = ops
    .map(
      (op) =>
        `  - slug: ${op.slug}\n    type: ${op.kind.split('-')[0]}\n    name: ${String(op.payload.name)}`,
    )
    .join('\n')
  const root = ops.find((op) => op.slug === rootSlug)
  if (root === undefined) throw new Error('fixture root missing')
  return encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: ${rootSlug}
  type: ${root.kind.split('-')[0]}
  name: ${String(root.payload.name)}
resources:
${resourceLines}
requirements: {}
secrets: []
danglingCallRefs: []
builtins:
${builtins.length === 0 ? '  []' : builtins.map((b) => `  - type: ${b.type}\n    name: ${JSON.stringify(b.name)}`).join('\n')}
`),
    },
    {
      path: 'bundle.json',
      bytes: utf8(JSON.stringify({ bundleVersion: 1, ops, rootRef: `local:${rootSlug}` })),
    },
  ])
}

afterEach(() => {
  while (roots.length > 0) removeTempDirSync(roots.pop()!)
})

describeEachProvider('RFC-359 —— 资源包引用解析的 fail-closed（统一引擎）', (harness) => {
  async function fixture() {
    const db = harness.db
    await db.insert(users).values({
      id: OWNER,
      username: OWNER,
      displayName: 'Refs Owner',
      role: 'user',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w14-refs-'))
    roots.push(appHome)
    const box = createSecretBoxFromKey(randomBytes(32))
    const actor = buildActor({
      user: {
        id: OWNER,
        username: OWNER,
        displayName: 'Refs Owner',
        role: 'user',
        status: 'active',
      },
      source: 'daemon',
    })
    return {
      db,
      /**
       * 走**整条用户路径**：parse → preview → commit。三道门里任意一道拒绝都算 fail-closed，
       * 所以捕获范围必须盖住三段——只包 commit 会漏掉「更早被挡住」这种**更好**的结果。
       */
      async commitExpectingFailure(bytes: Uint8Array): Promise<{ code?: string }> {
        try {
          const pkg = await parseResourcePackage(bytes)
          const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
          await commitResourcePackageForTest({ db, appHome, box }, actor, {
            pkg,
            previewToken: preview.previewToken,
            decisions: preview.entries.map((entry) => ({
              localSlug: entry.localSlug,
              action: 'new' as const,
            })),
          })
          return {}
        } catch (error) {
          return error as { code?: string }
        }
      },
    }
  }

  test('① 本实例没有同名 built-in ⇒ 抛 `bundle-builtin-missing`，一行都不写', async () => {
    const f = await fixture()
    const error = await f.commitExpectingFailure(
      packageOf(
        [
          {
            opId: 'op-1',
            kind: 'agent-create',
            slug: 'agent-lead',
            payload: agentPayload('lead', { dependsOn: ['builtin:agent/__nope__'] }),
          },
        ],
        'agent-lead',
        [{ type: 'agent', name: '__nope__' }],
      ),
    )
    // preview 期的环境前提检查先拦下：连 apply 都不会开始。
    expect(error.code).toBe('package-builtin-missing')
    expect(await f.db.select().from(agents)).toEqual([])
  })

  test('② 词法层放行的怪名字被「查不到」挡住——不是路径穿越，也不是静默放行', async () => {
    const f = await fixture()
    for (const name of ['../../etc/passwd', 'a/b', ' ']) {
      const error = await f.commitExpectingFailure(
        packageOf(
          [
            {
              opId: 'op-1',
              kind: 'agent-create',
              slug: 'agent-lead',
              payload: agentPayload('lead', { dependsOn: [`builtin:agent/${name}`] }),
            },
          ],
          'agent-lead',
          [{ type: 'agent', name }],
        ),
      )
      // 两种收场都算 fail-closed：解不开（`bundle-ref-invalid`）或解开了但查不到
      // （`bundle-builtin-missing`）。**不允许**的是第三种：当成某个真资源放过去。
      // 解不开（parse 期 schema 拒）或解开了但本机没有（preview 期前提检查拒），
      // 两种都是 fail-closed；**不允许**的第三种是「当成某个真资源放过去」。
      expect({ name, code: error.code }).toEqual({
        name,
        code: name === ' ' ? 'package-invalid' : 'package-builtin-missing',
      })
      expect(await f.db.select().from(agents)).toEqual([])
    }
  })

  test('③ `agent.skills` 是专属域：built-in 引用不得被当成 managed skill 收下', async () => {
    const f = await fixture()
    const error = await f.commitExpectingFailure(
      packageOf(
        [
          {
            opId: 'op-1',
            kind: 'agent-create',
            slug: 'agent-lead',
            payload: agentPayload('lead', { skills: ['builtin:agent/__skill_merger__'] }),
          },
        ],
        'agent-lead',
        [{ type: 'agent', name: '__skill_merger__' }],
      ),
    )
    // `agent.skills` 的 wire 形态由 bundle schema 自己收窄，`builtin:` 在词法层就不合法。
    expect(error.code).toBe('package-invalid')
    expect(await f.db.select().from(agents)).toEqual([])
  })

  test('④ `local:` 的二道门：slug 存在但声明类型与槽位不符 ⇒ 不给预铸 id', async () => {
    const f = await fixture()
    const error = await f.commitExpectingFailure(
      packageOf(
        [
          {
            opId: 'op-1',
            kind: 'agent-create',
            slug: 'agent-lead',
            // `mcp-tools` 在包里存在，但它是 MCP；把它当 agent 依赖引用必须解不开。
            payload: agentPayload('lead', { dependsOn: ['local:mcp-tools'] }),
          },
          {
            opId: 'op-2',
            kind: 'mcp-create',
            slug: 'mcp-tools',
            payload: { name: 'tools', description: '', transport: 'stdio', command: 'x', args: [] },
          },
        ],
        'agent-lead',
      ),
    )
    // 同理：`dependsOn` 的槽位声明了它接受什么类型，类型不符在 parse 期就被拒。
    expect(error.code).toBe('package-invalid')
    expect(await f.db.select().from(agents)).toEqual([])
    expect(await f.db.select().from(mcps)).toEqual([])
  })
})
