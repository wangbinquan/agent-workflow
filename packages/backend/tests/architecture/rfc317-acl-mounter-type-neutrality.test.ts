// RFC-317 T29（ACL-04）—— 通用 ACL 端点挂载器必须**不认识**任何一类具体资源。
//
// `routes/resourceAcl.ts` 是 commons-manifest 里 `core: true` 的内核
// （`resourceacl-ts`），13 类 ACL 资源的 `GET/PUT /:id/acl` 全部由它挂载。
// ACL-04 抓到的形态：它在写完之后按 `cfg.type === 'workflow'` / `'workgroup'` 分叉
// 各发一条 WS 广播——而 `afterUpdate` 这个「每类资源自己决定写完还要做什么」的钩子
// **当时就已经存在**，那两条分支纯属没走它。代价是第三类资源想发广播就只能回来
// 再加一条 if，且这个服务全部资源的挂载器凭空认识了其中两类。
//
// 本守卫钉住反转后的事实：挂载器里**一个** AclResourceType 取值都不出现。
// 词汇表直接 import 生产常量 `ACL_RESOURCE_TYPES`，不手抄——手抄一份就等于把
// 「有哪些资源类型」写两遍，新增一类时这里不会红，而是安静地放过它。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ACL_RESOURCE_TYPES } from '@agent-workflow/shared'

import { mintedVocabulary, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const MOUNTER = 'packages/backend/src/routes/resourceAcl.ts'

const unitOf = (rel: string): SourceUnit =>
  sourceUnit(rel, readFileSync(resolve(REPO_ROOT, rel), 'utf8'))

const mounterUnit = unitOf(MOUNTER)

describe('RFC-317 T29（ACL-04）—— 通用 ACL 挂载器的资源类型中立性', () => {
  test('语料非空：词汇表与挂载器都读得到（任一为空则本守卫零预言力）', () => {
    expect(
      ACL_RESOURCE_TYPES.length,
      'ACL_RESOURCE_TYPES 读不到取值——常量被改名或换了形态，此时下面那条' +
        '「挂载器不点名任何类型」会因为词汇表为空而必然绿',
    ).toBeGreaterThanOrEqual(6)
    expect(mounterUnit.text.length).toBeGreaterThan(2_000)
  })

  test('挂载器里不出现任何 AclResourceType 取值', () => {
    expect(
      mintedVocabulary(mounterUnit, ACL_RESOURCE_TYPES),
      '通用 ACL 端点挂载器点名了具体资源类型。「这类资源 ACL 改完之后还要做什么」' +
        '属于该资源自己的挂载配置（`afterUpdate`），不属于服务全部 13 类的这段代码；' +
        '一旦它认识某一类，第三类要做同样的事就只能回来再加一条分支',
    ).toEqual([])
  })
})

describe('RFC-317 T29 自变异 —— 判据的两条边界', () => {
  test('真的落一条类型分叉会被抓到', () => {
    const offending = sourceUnit(
      'probe.ts',
      `if (cfg.type === 'workflow') {\n  broadcast({ type: 'workflow.acl.updated' })\n}\n`,
    )
    expect(mintedVocabulary(offending, ACL_RESOURCE_TYPES).length).toBeGreaterThanOrEqual(1)
  })

  test('注释里提到类型名**不算**违规（AST 判据，不被散文满足）', () => {
    // 这条不是假想：本 RFC 落地 T29 时，删掉那两条分支后写的说明注释里就带着
    // `cfg.type === 'workflow' | 'workgroup'` 两个词，一条 `grep -c "'workflow'"`
    // 当场把它算成两处违规——而它恰恰是在解释「这里已经没有分叉了」。
    const innocent = sourceUnit(
      'probe.ts',
      `// 这里原本按 \`cfg.type === 'workflow' | 'workgroup'\` 分叉发广播：\n` +
        `await cfg.afterUpdate?.(row.id)\n`,
    )
    expect(
      mintedVocabulary(innocent, ACL_RESOURCE_TYPES),
      '一条断言和它的否定共用同一批关键词——用文本判据分不开，只能靠 AST',
    ).toEqual([])
  })
})
