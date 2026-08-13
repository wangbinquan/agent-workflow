// RFC-287 T2 —— 装配骨架的单元测试。
//
// 三轮设计门在同一批契约上反复翻车，所以这里逐条钉死最容易搞错的：
//   ① settle 只在窗口正常走完时执行——任何 skip / disposition / catch-all 产出的
//      结果直接成为装配结果；
//   ② finally 里释放许可**先于**清理 iso，且释放按逆序（RFC-208 事故）；
//   ③ persistBase 相位按线声明：'in-setup' 抛出→走 onIsoSetupFailure；
//      'in-window' 抛出→经 finally 释放后继续传播；
//   ④ 线级 catch-all 逐线不同，'rethrow' 保持抛出直穿；
//   ⑤ merge 抛出的默认处置=保留 iso + 标记合并失败 + 按失败 settle。

import { describe, expect, test } from 'bun:test'
import {
  runAssembly,
  type AssemblySpec,
  type IsoLike,
  type PoolLike,
} from '../src/services/schedulerAssembly'

const silentLog = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never

/** 记录事件序的测试脚手架。 */
function makeSpec(over: Partial<AssemblySpec<{ id: string }, string, string>> = {}) {
  const events: string[] = []
  const pool = (name: string): PoolLike => ({
    acquire: async () => {
      events.push(`acquire:${name}`)
      return () => events.push(`release:${name}`)
    },
  })
  const handle: IsoLike = { passthrough: false }
  const spec: AssemblySpec<{ id: string }, string, string> = {
    pools: [pool('a'), pool('b')],
    iso: {
      create: async () => {
        events.push('iso:create')
        return handle
      },
      persistBase: 'in-window',
      persist: async () => {
        events.push('iso:persist')
      },
    },
    spawn: async () => {
      events.push('spawn')
      return 'done'
    },
    mergePhase: () => 'merge',
    mergeBack: {
      run: async () => {
        events.push('merge')
        // RFC-287 T3 把返回类型从 `{kind:'ok'}` 收窄为真实原语的
        // `merged | conflict-human`，本夹具未同步（该 commit 未触及本文件）。
        // 这里补成功路径的 `merged`，只为让 HEAD 自洽——夹具意图与归属不变。
        return { kind: 'merged' as const }
      },
    },
    onIsoSetupFailure: () => 'iso-setup-failed',
    markMergeFailed: async () => {
      events.push('markMergeFailed')
    },
    discardIso: async () => {
      events.push('discard')
    },
    settle: async () => {
      events.push('settle')
      return 'settled'
    },
    log: silentLog,
    ...over,
  }
  return { spec, events }
}

describe('RFC-287 T2 — 装配骨架', () => {
  test('正常路径：许可→物化→spawn→合并→settle，finally 释放逆序后清理', async () => {
    const { spec, events } = makeSpec()
    expect(await runAssembly({ id: 't' }, spec)).toBe('settled')
    expect(events).toEqual([
      'acquire:a',
      'acquire:b',
      'iso:create',
      'iso:persist',
      'spawn',
      'merge',
      'settle',
      'release:b', // ② 逆序
      'release:a',
      'discard', // ② 释放先于清理
    ])
  })

  test('① 跳合并且短路产出：settle 不执行', async () => {
    const { spec, events } = makeSpec({
      mergePhase: () => ({ skip: 'park', keep: true, then: { produce: async () => 'parked' } }),
    })
    expect(await runAssembly({ id: 't' }, spec)).toBe('parked')
    expect(events).not.toContain('settle')
    expect(events).not.toContain('merge')
    expect(events).not.toContain('discard') // keep=true ⇒ 不清理
  })

  test('① 跳合并但 then=settle：settle 仍执行，keep 生效', async () => {
    const { spec, events } = makeSpec({
      mergePhase: () => ({ skip: 'not-done', keep: false, then: 'settle' }),
    })
    expect(await runAssembly({ id: 't' }, spec)).toBe('settled')
    expect(events).toContain('settle')
    expect(events).not.toContain('merge')
    expect(events).toContain('discard') // keep=false ⇒ 清理
  })

  test('⑤ merge 抛出的默认处置：保留 iso + 标记合并失败 + 按失败 settle', async () => {
    const { spec, events } = makeSpec({
      mergeBack: {
        run: async () => {
          throw new Error('merge boom')
        },
      },
    })
    expect(await runAssembly({ id: 't' }, spec)).toBe('settled')
    expect(events).toContain('markMergeFailed')
    expect(events).not.toContain('discard') // 默认 keep
  })

  test('⑤ 覆写 onThrow=rethrow：保持 L1 的重抛语义，且 keep 由覆写决定', async () => {
    const { spec, events } = makeSpec({
      mergeBack: {
        run: async () => {
          throw new Error('boom')
        },
        disposition: { onThrow: () => ({ keep: true, then: 'rethrow' }) },
      },
    })
    await expect(runAssembly({ id: 't' }, spec)).rejects.toThrow('boom')
    expect(events).not.toContain('discard')
    expect(events).not.toContain('markMergeFailed') // 覆写后不走默认
  })

  test('conflict-human 默认：keep + settle；覆写可改为 abandon 形态', async () => {
    const base = { run: async () => ({ kind: 'conflict-human' as const, detail: 'x' }) }
    const d = makeSpec({ mergeBack: base })
    expect(await runAssembly({ id: 't' }, d.spec)).toBe('settled')
    expect(d.events).not.toContain('discard')

    const o = makeSpec({
      mergeBack: {
        ...base,
        disposition: { onConflictHuman: () => ({ keep: false, produce: async () => 'abandoned' }) },
      },
    })
    expect(await runAssembly({ id: 't' }, o.spec)).toBe('abandoned')
    expect(o.events).toContain('discard') // keep=false
  })

  test('③ persistBase=in-setup：落基线抛出走 onIsoSetupFailure', async () => {
    const { spec, events } = makeSpec({
      iso: {
        create: async () => ({ passthrough: false }),
        persistBase: 'in-setup',
        persist: async () => {
          throw new Error('persist boom')
        },
      },
    })
    expect(await runAssembly({ id: 't' }, spec)).toBe('iso-setup-failed')
    expect(events).not.toContain('spawn')
  })

  test('③ persistBase=in-window：落基线抛出继续传播（不吞成 iso-setup-failed）', async () => {
    const { spec } = makeSpec({
      iso: {
        create: async () => ({ passthrough: false }),
        persistBase: 'in-window',
        persist: async () => {
          throw new Error('persist boom')
        },
      },
    })
    await expect(runAssembly({ id: 't' }, spec)).rejects.toThrow('persist boom')
  })

  test('④ 线级 catch-all 产出结果；未声明则抛出直穿', async () => {
    const caught = makeSpec({
      spawn: async () => {
        throw new Error('spawn boom')
      },
      onUnhandledThrow: () => 'caught',
    })
    expect(await runAssembly({ id: 't' }, caught.spec)).toBe('caught')
    expect(caught.events).not.toContain('settle')

    const bare = makeSpec({
      spawn: async () => {
        throw new Error('spawn boom')
      },
    })
    await expect(runAssembly({ id: 't' }, bare.spec)).rejects.toThrow('spawn boom')
  })

  test('⑥ keepFromOutcome 置真则 keep 恒真，且**不被后续相位下调**', async () => {
    // 现状四条线的 processUnreaped ⇒ keep：旧 child 可能还活着，此时清理 iso 会让
    // 新会话重试在同一棵工作树里造出两个写者。迁移时只搬 mergePhase 会静默丢掉它。
    const { spec, events } = makeSpec({
      keepFromOutcome: () => true,
      // 相位显式说 keep=false —— 仍不得下调。
      mergePhase: () => ({ skip: 'not-done', keep: false, then: 'settle' }),
    })
    expect(await runAssembly({ id: 't' }, spec)).toBe('settled')
    expect(events).not.toContain('discard')
  })

  test('⑥ keepFromOutcome 置真时，即便走覆写产出也不清理', async () => {
    const { spec, events } = makeSpec({
      keepFromOutcome: () => true,
      mergeBack: {
        run: async () => ({ kind: 'conflict-human' as const, detail: 'x' }),
        disposition: { onConflictHuman: () => ({ keep: false, produce: async () => 'abandoned' }) },
      },
    })
    expect(await runAssembly({ id: 't' }, spec)).toBe('abandoned')
    expect(events).not.toContain('discard')
  })

  // ---------------------------------------------------------------------------
  // 模式 B（跨 attempt 窗口）——T5b 补。要害是两条线的 iso 处置**相反**，
  // 统一任一方都是行为变更：agent 线跨 attempt 保住同一棵（同会话续跑要它），
  // 脚本线每次换新树（否则上次的文件写入与这次叠加）。
  // ---------------------------------------------------------------------------
  test('模式 B：窗口内多次 spawn，许可与 iso 只取一次', async () => {
    let spawns = 0
    const { spec, events } = makeSpec({
      spawn: async () => {
        spawns++
        events.push(`spawn#${spawns}`)
        return spawns < 3 ? 'retryable' : 'done'
      },
      retryPolicy: {
        shouldRetry: (o) => o === 'retryable',
        isoOnRetry: { keepIf: () => true },
        onIsoRecreateFailure: () => 'recreate-failed',
        onNextAttempt: async (n) => {
          events.push(`nextAttempt#${n}`)
        },
      },
    })
    expect(await runAssembly({ id: 't' }, spec)).toBe('settled')
    expect(spawns).toBe(3)
    // 许可只取一次、iso 只建一次（keepIf 恒真 ⇒ 不换树）——这正是 agent 线的形态。
    expect(events.filter((e) => e === 'acquire:a')).toHaveLength(1)
    expect(events.filter((e) => e === 'iso:create')).toHaveLength(1)
    expect(events.filter((e) => e === 'discard')).toHaveLength(1) // 只有收尾那次
  })

  test("模式 B：isoOnRetry='always-recreate' 每次重试换新树（脚本线形态）", async () => {
    let spawns = 0
    const { spec, events } = makeSpec({
      spawn: async () => {
        spawns++
        return spawns < 3 ? 'retryable' : 'done'
      },
      retryPolicy: {
        shouldRetry: (o) => o === 'retryable',
        isoOnRetry: 'always-recreate',
        onIsoRecreateFailure: () => 'recreate-failed',
        onNextAttempt: async () => {},
      },
    })
    expect(await runAssembly({ id: 't' }, spec)).toBe('settled')
    // 两次重试 ⇒ 两次「先丢弃再物化」，加初始物化共 3 次 create、收尾 1 次 discard。
    expect(events.filter((e) => e === 'iso:create')).toHaveLength(3)
    expect(events.filter((e) => e === 'discard')).toHaveLength(3)
    // 顺序不可颠倒：每次都是 discard 在 create 之前。
    const isoEvents = events.filter((e) => e === 'iso:create' || e === 'discard')
    expect(isoEvents.slice(0, 4)).toEqual(['iso:create', 'discard', 'iso:create', 'discard'])
  })

  test('模式 B：换树失败走 onIsoRecreateFailure（与初始物化失败是两种结局）', async () => {
    let creates = 0
    const { spec } = makeSpec({
      iso: {
        create: async () => {
          creates++
          if (creates > 1) throw new Error('recreate boom')
          return { passthrough: false }
        },
        persistBase: 'in-window',
        persist: async () => {},
      },
      spawn: async () => 'retryable',
      retryPolicy: {
        shouldRetry: (o) => o === 'retryable',
        isoOnRetry: 'always-recreate',
        onIsoRecreateFailure: () => 'recreate-failed',
        onNextAttempt: async () => {},
      },
    })
    // 不是 'iso-setup-failed'——那是**初始**物化失败的结局。
    expect(await runAssembly({ id: 't' }, spec)).toBe('recreate-failed')
  })

  test('模式 B：shouldRetry 永不收敛时撞硬上限并响亮抛出（防 daemon 自旋）', async () => {
    // 这条是变异实证逼出来的：把 isoOnRetry 的判定写死成「一律留树」时，本文件的
    // 「换树失败」用例会变成无限循环——它靠换树失败来终止。真实的两条线各有重试
    // 预算兜着，但骨架不该依赖调用方不犯错：无限自旋会占着许可与隔离工作树把
    // daemon 拖住。
    let spawns = 0
    const { spec } = makeSpec({
      spawn: async () => {
        spawns++
        return 'never-settles'
      },
      retryPolicy: {
        shouldRetry: () => true, // 永远返真 = spec bug
        isoOnRetry: { keepIf: () => true },
        onIsoRecreateFailure: () => 'recreate-failed',
        onNextAttempt: async () => {},
      },
    })
    await expect(runAssembly({ id: 't' }, spec)).rejects.toThrow(/exceeded .* attempts/)
    expect(spawns).toBeLessThan(200) // 有界，而不是跑到天荒地老
  })

  test('模式 A（不声明 retryPolicy）仍只跑一次 spawn', async () => {
    let spawns = 0
    const { spec } = makeSpec({
      spawn: async () => {
        spawns++
        return 'done'
      },
    })
    await runAssembly({ id: 't' }, spec)
    expect(spawns).toBe(1)
  })

  test('② 许可在异常路径上也必然释放', async () => {
    const { spec, events } = makeSpec({
      spawn: async () => {
        throw new Error('boom')
      },
    })
    await expect(runAssembly({ id: 't' }, spec)).rejects.toThrow()
    expect(events.filter((e) => e.startsWith('release:'))).toEqual(['release:b', 'release:a'])
  })

  test('② 清理失败被吞并记 warn，不改变装配结果', async () => {
    const warns: string[] = []
    const { spec } = makeSpec({
      discardIso: async () => {
        throw new Error('discard boom')
      },
      log: { warn: (m: string) => warns.push(m) } as never,
    })
    expect(await runAssembly({ id: 't' }, spec)).toBe('settled')
    expect(warns).toEqual(['iso discard failed'])
  })
})
