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
  test('WS_PATHS key set is exactly the eight channels (bijection lock)', () => {
    expect(Object.keys(WS_PATHS).sort()).toEqual(
      // RFC-159 added `scheduledTasks`.
      [
        'task',
        'tasksList',
        'workflows',
        'workgroups',
        'repoImport',
        'memories',
        'memoryDistillJobs',
        'scheduledTasks',
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

  test('static paths parse', () => {
    expect(parse(WS_PATHS.tasksList)).toEqual({ kind: 'tasks-list' })
    expect(parse(WS_PATHS.workflows)).toEqual({ kind: 'workflows' })
    expect(parse(WS_PATHS.workgroups)).toEqual({ kind: 'workgroups' })
    expect(parse(WS_PATHS.memories)).toEqual({ kind: 'memories' })
    expect(parse(WS_PATHS.memoryDistillJobs)).toEqual({ kind: 'memory-distill-jobs' })
    expect(parse(WS_PATHS.scheduledTasks)).toEqual({ kind: 'scheduled-tasks' })
  })

  test('repoImport(batchId) — parses back with %-decoding', () => {
    expect(parse(WS_PATHS.repoImport('b1'))).toEqual({ kind: 'repo-import', batchId: 'b1' })
    expect(parse(WS_PATHS.repoImport('b/2?x'))).toEqual({ kind: 'repo-import', batchId: 'b/2?x' })
  })

  test('every WS_PATHS sample matches exactly ONE registry pathRe (no overlap)', () => {
    const samples: Array<[string, WsChannelKind]> = [
      [WS_PATHS.task('01ABC'), 'task'],
      [WS_PATHS.tasksList, 'tasks-list'],
      [WS_PATHS.workflows, 'workflows'],
      [WS_PATHS.workgroups, 'workgroups'],
      [WS_PATHS.repoImport('b1'), 'repo-import'],
      [WS_PATHS.memories, 'memories'],
      [WS_PATHS.memoryDistillJobs, 'memory-distill-jobs'],
      [WS_PATHS.scheduledTasks, 'scheduled-tasks'],
    ]
    const kinds = Object.keys(WS_CHANNELS) as WsChannelKind[]
    for (const [path, expected] of samples) {
      const pathname = new URL(path, 'http://daemon.test').pathname
      const matching = kinds.filter((k) => WS_CHANNELS[k].pathRe.test(pathname))
      expect(matching).toEqual([expected])
    }
  })
})
