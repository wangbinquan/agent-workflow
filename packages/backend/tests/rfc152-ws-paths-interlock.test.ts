// RFC-152 PR-5 — WS_PATHS (shared) ↔ ws/registry pathRe interlock.
//
// The frontend builds every WS subscription URL from the shared WS_PATHS
// constants; the backend parses them with the registry specs' pathRes. The
// two are written in different packages, so this suite is the drift lock:
// every WS_PATHS entry must parse back to exactly its channel kind (with
// %-encoding round-tripping for the parametrized ones), and the WS_PATHS
// key set must stay a bijection onto the registry's kinds.

import { describe, expect, test } from 'bun:test'
import { WS_PATHS } from '@agent-workflow/shared'
import { parseWsChannel, WS_CHANNELS, type WsChannelKind } from '../src/ws/registry'

const parse = (path: string) => parseWsChannel(new URL(path, 'http://daemon.test'))

describe('RFC-152 — WS_PATHS ↔ registry pathRe interlock', () => {
  test('WS_PATHS key set is exactly the twelve channels (bijection lock)', () => {
    expect(Object.keys(WS_PATHS).sort()).toEqual(
      // RFC-159 added `scheduledTasks`; RFC-234 added `intentSessions`;
      // RFC-312 added `presence`（独立通道，带 users:presence 升级门）。
      [
        'authority',
        'task',
        'tasksList',
        'workflows',
        'workgroups',
        'repoImport',
        'memories',
        'memoryDistillJobs',
        'scheduledTasks',
        'intentSessions',
        'mcpRuntimeTests',
        'presence',
      ].sort(),
    )
  })

  test('task(id) — parses back with %-decoding and ?since intact', () => {
    expect(parse(WS_PATHS.task('01ABC'))).toEqual({ kind: 'task', taskId: '01ABC' })
    // encodeURIComponent (frontend) ↔ decodeURIComponent (registry parse).
    expect(parse(WS_PATHS.task('T/1 x'))).toEqual({ kind: 'task', taskId: 'T/1 x' })
    expect(parse(`${WS_PATHS.task('01ABC')}?since=7&token=t`)).toEqual({
      kind: 'task',
      taskId: '01ABC',
      since: 7,
    })
  })

  // RFC-317 T56（findings TP-06）—— 静态路径改为**遍历 WS_PATHS**，不再手写清单。
  //
  // 原来这里逐条列举，而新增通道不需要出现在列举里：RFC-312 的 presence 就同时逃过了
  // 这一处与下面那处样本（同一次改动里上面那条双射断言**是**被更新了的——作者确实动过
  // 本文件，逐条列举仍然没跟上）。现在遍历所有非函数型 WS_PATHS 项：漏一个即红。
  test('每个静态 WS_PATHS 都 parse 回它自己的 kind（遍历，不再手写清单）', () => {
    const staticEntries = Object.entries(WS_PATHS).filter(
      ([, value]) => typeof value === 'string',
    ) as Array<[string, string]>
    // 12 个通道里有 2 个是参数化的（task / repoImport），各由自己的用例覆盖。
    expect(staticEntries.length).toBe(Object.keys(WS_PATHS).length - 2)
    for (const [name, path] of staticEntries) {
      const parsed = parse(path)
      expect(parsed, `WS_PATHS.${name}（${path}）parse 不出任何通道`).not.toBeNull()
      // 反向核对：解析出的 kind 的 pathRe 必须也认这条路径（两侧同源）。
      expect(WS_CHANNELS[parsed!.kind].pathRe.test(new URL(path, 'http://x').pathname)).toBe(true)
    }
  })

  test('repoImport(batchId) — parses back with %-decoding', () => {
    expect(parse(WS_PATHS.repoImport('b1'))).toEqual({ kind: 'repo-import', batchId: 'b1' })
    expect(parse(WS_PATHS.repoImport('b/2?x'))).toEqual({ kind: 'repo-import', batchId: 'b/2?x' })
  })

  test('每个通道的样例路径只匹中它自己（样本取自注册表，遍历全部 kind）', () => {
    // RFC-317 T56 —— 样本从 `ChannelSpec.samplePath` 取（必填字段，新增通道漏填是
    // 编译错误），而不是在这里手写一份会漂移的清单。这条守卫要防的是「新通道的 pathRe
    // 意外遮蔽了既有通道」，而那种通道最不可能被人想起来加进手写样本里。
    const kinds = Object.keys(WS_CHANNELS) as WsChannelKind[]
    for (const kind of kinds) {
      const pathname = new URL(WS_CHANNELS[kind].samplePath, 'http://daemon.test').pathname
      const matching = kinds.filter((k) => WS_CHANNELS[k].pathRe.test(pathname))
      expect(matching, `${kind} 的样例路径 ${pathname} 匹中了多个通道`).toEqual([kind])
    }
  })
})
