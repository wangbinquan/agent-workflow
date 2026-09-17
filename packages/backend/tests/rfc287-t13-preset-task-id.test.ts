// RFC-287 T13（G7 第一刀）—— `materializeSpace` 接受调用方预定的 taskId。
//
// 为什么需要它：G7 要把仓库准备挪到任务行落库**之后**（启动接口不再同步阻塞到
// 工作树就绪；准备失败也能留下一条可见记录，而不是「什么都没发生」）。落行需要
// id，而 id 一直是在物化过程里才铸出来的——这就是「必须先物化才能落行」的死结。
//
// 本刀只解开这个结：id 变成可选入参，不传时逐字维持旧行为。锁两件事：
//   ① 传了就用它（否则下一刀落的占位行与实际物化出的目录对不上）；
//   ② 不传仍自铸且形如 ULID（旧调用方一个都不用改）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8')

describe('RFC-287 T13 — materializeSpace 的 taskId 可由调用方预定', () => {
  test('签名带可选 presetTaskId，且 id 取「传入 ?? 自铸」', () => {
    expect(SRC).toMatch(/presetTaskId\?: string,/)
    expect(SRC).toMatch(/const taskId = presetTaskId \?\? ulid\(\)/)
  })

  test('自铸分支仍在（不传时旧调用方行为逐字不变）', () => {
    // 反向锁：把 `?? ulid()` 删掉会让所有不传 id 的调用方拿到 undefined，
    // 而那正是 multipart / agent 启动两条现存路径的用法。
    expect(SRC).toContain('?? ulid()')
  })

  test('现存调用路径都还在，且都没被迫改签名', () => {
    // `materializeSpace` 原本有三个调用点：JSON 启动（task.ts 自身）、multipart、agent 启动。
    // **RFC-359 AC-1（plan §5hn 批次二 ⑥⑦⑧）：后两个都没有了。**
    //   · multipart 那条路由改走与 PostgreSQL 共用的启动参与者 → 根启动内核，工作区物化由内核的
    //     `workspace.prepare(...)` 做，`services/multipartTaskStart.ts` 整份删除；
    //   · agent 启动同理——`startAgentTask` 整份删除，单代理臂走的也是那台内核。
    // 本刀（预置 taskId）是纯增量这件事没变：`task.ts` 自己那个调用点原样在。
    const taskService = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'),
      'utf8',
    )
    expect(taskService).toContain('materializeSpace(')
    // 内核那条路的等价物：一次 `workspace.prepare(...)`，成功与 earlyError 两支共用它。
    const kernel = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'infrastructure',
        'postgresqlTaskRouteLaunchOperations.ts',
      ),
      'utf8',
    )
    expect(kernel).toContain('const preparedWorkspace = await (')
  })
})
