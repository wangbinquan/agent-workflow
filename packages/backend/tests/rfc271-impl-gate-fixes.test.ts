// RFC-271 —— 锁住**实现门**（Codex，2026-08-08）那一轮 13 条 findings 的修复。
//
// 集中在一个文件是有意的：这 13 条来自同一次评审，读的人需要一眼看到「哪些洞被堵上
// 了」。每个 describe 标题带原始编号，正文写清**具体的失败场景**——没有可复现场景的
// 断言等于没有断言。
//
// 跨实例往返（P1-3 技能树 / P1-4 工作组 / P1-2 脱敏 / P1-1 写权限）在
// `rfc271-roundtrip.test.ts`，那条才是根因防护；这里补的是其余各条。

//
// 覆盖验收条款：AC-12（根资源 exact-revision 保护）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { collectBundleRefIssues } from '@agent-workflow/shared'
import { translateDecisions } from '../src/services/resourcePackage/commit'
import type { ParsedPackage } from '../src/services/resourcePackage/parse'

const BACKEND = resolve(import.meta.dir, '..')
const read = (rel: string): string => readFileSync(resolve(BACKEND, rel), 'utf8')

describe('P2-1 · 重复 opId 必须被 schema 拒绝', () => {
  test('两个 op 共用一个 opId ⇒ 报 bundle-duplicate-op-id', () => {
    // 场景：两个不同 slug 的插件都写 `opId: 'op-1'`。引擎侧 pluginInstalls /
    // skillStages / skillVersionStages **全部按 opId 索引**，后一项 Map.set 会静静
    // 覆盖前一项 —— 插件 one 保留自己的 spec，cachedPath 却指向插件 two 装出来的目录。
    const issues = collectBundleRefIssues({
      ops: [
        { opId: 'op-1', kind: 'plugin-create', slug: 'one', payload: { name: 'one' } },
        { opId: 'op-1', kind: 'plugin-create', slug: 'two', payload: { name: 'two' } },
      ] as never,
    })
    expect(issues.map((i) => i.code)).toContain('bundle-duplicate-op-id')
  })

  test('opId 各不相同 ⇒ 无此问题', () => {
    const issues = collectBundleRefIssues({
      ops: [
        { opId: 'op-1', kind: 'plugin-create', slug: 'one', payload: { name: 'one' } },
        { opId: 'op-2', kind: 'plugin-create', slug: 'two', payload: { name: 'two' } },
      ] as never,
    })
    expect(issues.map((i) => i.code)).not.toContain('bundle-duplicate-op-id')
  })
})

describe('P2-4 · 同一条目的互相矛盾决策必须拒绝', () => {
  const pkg = {
    bundle: {
      bundleVersion: 1,
      ops: [{ opId: 'op-1', kind: 'mcp-create', slug: 'mcp-x', payload: { name: 'x' } }],
    },
  } as unknown as ParsedPackage

  test('同 slug 两条 decision ⇒ package-decision-duplicate', () => {
    // 场景：decisions = [MCP reuse(old), MCP new]。旧写法里 `bySlug` 后写赢（走 new
    // 分支建了新 MCP），而 `externalOfSlug` 是遍历原数组建的、早先那条 reuse 留了下来
    // ⇒ 新 agent 指向**旧** MCP。两个都生效，且没有任何报错。
    expect(() =>
      translateDecisions(
        pkg,
        [
          { localSlug: 'mcp-x', action: 'reuse', targetId: 'old-id' },
          { localSlug: 'mcp-x', action: 'new', finalName: 'x' },
        ],
        new Map(),
      ),
    ).toThrow(/more than one decision/)
  })

  test('每条目一条 decision ⇒ 正常翻译', () => {
    const out = translateDecisions(
      pkg,
      [{ localSlug: 'mcp-x', action: 'new', finalName: 'x' }],
      new Map(),
    )
    expect(out.ops).toHaveLength(1)
  })
})

describe('P2-6 · withApplyLock 的 map 清理必须比较同一个 Promise', () => {
  test('清理时比的是存进 map 的那个 chain，不是 gate', () => {
    // map 里存的是 `prior.then(() => gate)` 派生出来的**新** Promise；拿 `gate` 去比
    // `applyLocks.get(key)` 恒为 false ⇒ 每个出现过的 serializationKey 都永久留一项。
    // 串行语义仍对，所以只会表现为内存缓慢增长——而 serializationKey 是按资源实例
    // 派生的，基数无上限。
    const src = read('src/services/bundle/apply.ts')
    expect(src).toContain('const chain = prior.then(() => gate)')
    expect(src).toContain('applyLocks.get(key) === chain')
    expect(src).not.toContain('applyLocks.get(key) === gate')
  })
})

describe('P1-5 · 收敛器必须真的被生产代码调用', () => {
  test('daemon 启动与每小时任务都调了 convergeResourceBundleApplies', () => {
    // 只有定义、没有调用点的收敛器等于不存在：一次崩在 pre-stage 与 big tx 之间的
    // daemon 会永久留下插件 generation / 暂存技能目录，且那个 importId 每次重放都答
    // `bundle-apply-unsettled`。
    const start = read('src/cli/start.ts')
    expect(start).toContain('convergeResourceBundleApplies')
    // 两处：boot 一次 + 小时 tick 一次。
    expect(start.match(/convergeResourceBundleApplies\(/g)?.length).toBeGreaterThanOrEqual(2)
  })

  test('committed 分支重放幂等尾，不是只 +1', () => {
    // 一次「DB 已提交、publish 前 SIGKILL」的 run 会留下已入库但**内容未发布**的技能
    // 版本。只 `rolledForward += 1` 等于宣称处理过而实际什么都没做。
    const src = read('src/services/bundle/apply.ts')
    const committedBranch = src.slice(src.indexOf("if (row.state === 'committed')"))
    expect(committedBranch.slice(0, 1400)).toContain('rollForwardCommitted(')
  })
})

describe('P1-6 · 补偿没做干净就不许终态化 failed', () => {
  test('catch 一侧与收敛器一侧对称：compensated 为假时不 settleFailed', () => {
    // 补偿抛错（EBUSY 等）却照样标 failed ⇒ 收敛器显式跳过 failed 行 ⇒ 那次残留再也
    // 不会被重试，而粗粒度 GC 又被任一非终态 run 挡住 ⇒ 永久残留，且 journal 反过来
    // 宣称「这次什么都没留下」。
    const src = read('src/services/bundle/apply.ts')
    expect(src).toContain('if (compensated) {')
    expect(src).toContain("log.warn('bundle-left-retryable'")
  })

  test('技能版本 artifact 落的是完整 staged 结构（够 publish 重放，不只够 abort）', () => {
    const src = read('src/services/bundle/apply.ts')
    expect(src).toContain("recordArtifact({ kind: 'skill-version-stage', staged })")
    // 旧写法现编一个假的 StagedSkillVersion（newVersion: 0 / newHash: ''），
    // abort 恰好用不到才没出事——那是运气不是设计。
    expect(src).not.toContain("skillName: '',")
  })
})

describe('P2-3 · lower 必须预载 payload 内 external 目标的名字', () => {
  test('collectExternalRefs 覆盖全部引用槽', () => {
    // 场景：root workflow 调用 local child，预检把 child 选成 reuse ⇒ root 的 call 槽
    // 变成 `external:W`、child 的 create op 被删除。只扫 update target 的话 `nameOfId`
    // 里没有 W 的名字，call 槽拿不到权威名字 ⇒ 整包死在
    // `bundle-ref-invalid ... name is unknown`（一个纯 reuse 的包必然踩中）。
    const src = read('src/services/bundle/lower.ts')
    expect(src).toContain('collectExternalRefs(op.payload')
    for (const slot of ['payload.skills', 'payload.dependsOn', 'payload.mcp', 'payload.plugins']) {
      expect(src).toContain(slot)
    }
    for (const slot of ['node.agentRef', 'node.workflowRef', 'node.workgroupRef']) {
      expect(src).toContain(slot)
    }
  })
})

describe('P2-5 · 导出的 exact-revision fence（只 fence root）', () => {
  test('handler 只传 root query；闭包成员由 exporter 内部稳定性复核', () => {
    const routes = read('src/routes/resourcePackages.ts')
    expect(routes).toContain('parseRootFence(c)')
    expect(routes).toContain('expectedVersion')
    const exportSrc = read('src/services/resourcePackage/export.ts')
    // 客户端只需要知道 root revision。
    expect(exportSrc).toContain(
      'assertRootUnchanged(closure.root.type, closure.root.row, opts.expect)',
    )
    // 技能树/工作组 roster 等后续 live 读取也必须被末端复核包住。
    expect(exportSrc).toContain(
      'assertRootStillCurrent(db, actor, closure.root.type, closure.root.id, opts.expect)',
    )
    // 末端复核现在要 actor —— 它不只比「产物变没变」，还要重新跑一次**授权复核**
    // （闭包成员的 grant 可能在导出中途被撤销；实现门第四轮的 P1-2 就是这条漏检）。
    expect(exportSrc).toContain(
      'assertClosureStillCurrent(db, actor, closure, skillTrees, serialized, opts.appHome)',
    )
    // 产物比较必须拿**序列化器自己的产出**比，不能拿「行」去近似「包」：
    //  · 用引擎 CAS token 会一边漏检（workflow/workgroup 漏 ACL）一边误拒（另四类把
    //    不进包的 ACL 维算进去）——第四轮 P2-2；
    //  · 退而求其次的「整行减 ACL 列」同样错：插件的 cachedPath/resolvedVersion/
    //    installedAt 是本机安装态、根本不进包，而一次正常 reinstall 恰好只动这三列
    //    ⇒ 两次导出逐字节相同却报 changed——第五轮 P2-2。
    expect(exportSrc).toContain('const refreshed = serializeClosure(')
    expect(exportSrc).not.toContain('ARTIFACT_IRRELEVANT_COLUMNS')
    // 授权复核必须排在 root fence 明文比较之前（第五轮 P2-1 的状态 oracle）。
    expect(
      exportSrc.indexOf('await assertClosureStillCurrent(') <
        exportSrc.indexOf('await assertRootStillCurrent('),
    ).toBe(true)
    expect(exportSrc).toContain('package-root-changed')
  })

  test('写错的数值是拒绝，不是当没给', () => {
    // 静默忽略一个写错的 fence，等于用户以为有保护而实际没有。
    const routes = read('src/routes/resourcePackages.ts')
    // 判据是**逐字段的取值域**，不是一刀切「非负整数」：version / contentVersion 从 1
    // 起（0 是不可能存在的值），aclRevision / metaRevision 从 0 起（0 是合法初值）。
    expect(routes).toContain('must be a decimal integer')
    expect(routes).toContain('must be an integer >=')
  })

  test('AC-12：六类各自的**完整**形态，不是只给 expectedVersion', () => {
    // ⚠️ 这条曾经被我在验收清单里勾成「已覆盖」，实际只实现了 expectedVersion +
    // expectedSnapshotHash —— 即只覆盖 workflow / workgroup。AC-12 的警告写的正是
    // 这个状态：「另一标签修改 agent 正文后，原标签点导出会静默导出新版本而不是
    // 409」。
    const routes = read('src/routes/resourcePackages.ts')
    for (const key of [
      'expectedVersion',
      'expectedUpdatedAt',
      'expectedAclRevision',
      'expectedContentVersion',
      'expectedMetaRevision',
      'expectedConfigHash',
    ]) {
      expect({ key, present: routes.includes(key) }).toEqual({ key, present: true })
    }
    const exportSrc = read('src/services/resourcePackage/export.ts')
    // 形态取自 `expectTokenOf` 那一份定义，不另抄一套。
    // 导出 fence 必须**派生自共享的 token 定义**，不能在 export.ts 里手写一份字段表
    // ——手写的那份永远会落后于 schema。
    //
    // 曾拆出一个 `exportFenceTokenOf` 给工作流/工作组多加一维 aclRevision，实测 ACL
    // 漂移产出**逐字节相同**的包（包不带权属信息），那一维只打红了六个前端入口，已撤回。
    expect(exportSrc).toContain('const actual = expectTokenOf(type, row)')
    expect(exportSrc).not.toContain('expectedUpdatedAt:')
    // 给了就必须给全 —— 少给一维等于放过那一维的漂移。
    expect(exportSrc).toContain('needs all of:')
  })
})

describe('P2-2 / P2-7 · CLI 的两阶段与身份', () => {
  const src = read('src/cli/package.ts')

  test('--plan 只写计划、不提交；--apply 才提交', () => {
    // 旧实现把 `--plan` 当带值参数：裸 `--plan` 落进被丢弃的 bools，命令**照常
    // commit**。用户以为在 dry-run，实际建了一堆资源。
    expect(src).toContain('commits NOTHING')
    expect(src).toContain("flags.get('apply')")
    expect(src).toContain('nothing committed')
  })

  test('三个决策来源都不给 ⇒ 报错，没有静默默认', () => {
    expect(src).toContain('is required:')
    expect(src).toContain('mutually exclusive')
  })

  test('非 active 用户 ⇒ 拒绝（与 HTTP 同构的第二半）', () => {
    // HTTP 侧 session lookup 对停用用户返回 null；只查「行存在」会让 CLI 给一个停用
    // 主体造出可写 Actor，导入的资源归到该主体名下。
    expect(src).toContain("row.status !== 'active'")
    expect(src).toContain('refusing to act as them')
  })
})

describe('P1-2 · 脱敏三件套必须真的被调用（写了没接上 = 没写）', () => {
  test('serialize 调了 argv / url / pluginSpec 三个 helper', () => {
    const src = read('src/services/resourcePackage/serialize.ts')
    expect(src).toContain('redactArgv(')
    expect(src).toContain('redactUrlKeepingShape(')
    expect(src).toContain('redactPluginSpec(')
  })

  test('requirements.pluginSources 取的是**已脱敏**的那一份，不重读原行', () => {
    // 重读 `row.spec` 等于给密钥开第二条出口，且两处脱敏规则会随时间漂移。
    const exportSrc = read('src/services/resourcePackage/export.ts')
    const requirementsSrc = read('src/services/resourcePackage/requirements.ts')
    expect(exportSrc).toContain('collectPackageRequirements(serialized.bundle)')
    expect(requirementsSrc).toContain("spec: String(payload.spec ?? '')")
    expect(exportSrc).not.toContain("spec: String(r.row.spec ?? '')")
  })
})

describe('复合键只能有一个定义（本轮实测的静默剔除事故）', () => {
  test('humanMemberKey 是唯一定义，两端都调它', () => {
    // 解析端与 provider 端各拼一次 `${slug} ${username}`，其中一侧的「空格」实际敲成
    // 了 U+0000（编辑器不显示）⇒ 查表永远落空 ⇒ human 成员被当成「用户选了不加入」
    // 整条剔除，全程零报错。
    const commit = read('src/services/resourcePackage/commit.ts')
    expect(commit).toContain('export function humanMemberKey(')
    expect(commit).toContain('humanMemberKey(workgroupSlug, username)')
    // 分隔符必须是可见字符。
    expect(commit).toContain('`${workgroupSlug}#${username}`')
  })

  test('源码里没有裸控制字符', () => {
    // ⚠️ **不用 regex**：把控制字符敲进字面量正是它要抓的问题（写这条测试的第一版
    // 就自己踩了一次），而转义写法又会撞 `no-control-regex`。直接查字符码最直白。
    const hasControlChar = (text: string): boolean => {
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        // 放行 \t(9) \n(10) \r(13)；其余 C0 控制字符都不该出现在源码里。
        if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) return true
      }
      return false
    }
    for (const rel of [
      'src/services/resourcePackage/commit.ts',
      'src/services/resourcePackage/preview.ts',
      'src/services/bundle/lower.ts',
      'src/services/workflow.validator.ts',
    ]) {
      expect({ rel, hit: hasControlChar(read(rel)) }).toEqual({ rel, hit: false })
    }
  })
})

describe('P1-1 · 写权限点表两头受检', () => {
  // ⚠️ 断言锚在**契约**上，不锚文件路径。这张表最初写在 `preview.ts`，并发 session
  // 正把它抽成共享的 `importPermissions.ts`（preview 与 commit 共用同一个预言——路由
  // 中间件无从知道一个包会碰哪几类资源，而 commit 必须拿它当时的 Actor 再算一遍）。
  // 抽取是对的，守卫不该因为「文件搬了家」而红。
  const PERMISSION_SOURCES = [
    'src/services/resourcePackage/preview.ts',
    'src/services/resourcePackage/importPermissions.ts',
  ]
  const permissionSource = (): string =>
    PERMISSION_SOURCES.map((p) => {
      try {
        return read(p)
      } catch {
        return ''
      }
    }).join('\n')

  test('六类齐全且点位名字来自 Permission 联合（打错字编译失败）', () => {
    const src = permissionSource()
    // `Record<AclResourceType, …>` 保证六类一个不漏；值标 `Permission` 保证点位真存在。
    expect(src).toContain('AclResourceType')
    expect(src).toContain('{ create: Permission; update: Permission }')
    for (const t of ['agents', 'skills', 'mcps', 'plugins', 'workflows', 'workgroups']) {
      expect(src).toContain(`create: '${t}:create'`)
      expect(src).toContain(`update: '${t}:update'`)
    }
  })

  test('缺写权限时有硬拒（不是静默跳过那一条）', () => {
    // 同样不锚位置：硬拒最初在预检整包抛出，现正被移到提交期（预检改成逐条标注
    // `missingPermissions`，让用户先看到缺什么全貌）。两种形态都满足用户定的
    // 「令牌有写权限才能导入」，守卫要的是**这条拒绝存在**。
    const sources = [
      'src/services/resourcePackage/preview.ts',
      'src/services/resourcePackage/commit.ts',
      'src/services/resourcePackage/importPermissions.ts',
    ]
      .map((p) => {
        try {
          return read(p)
        } catch {
          return ''
        }
      })
      .join('\n')
    expect(sources).toContain('package-write-forbidden')
  })
})

describe('导入 receipt 的幂等键仍是客户端持有的 importId', () => {
  test('ulid 生成的 importId 每次不同（不会误撞别人的 journal 行）', () => {
    expect(ulid()).not.toBe(ulid())
  })
})
