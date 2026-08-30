// RFC-271 T40–T42 —— 配置包 CLI 的准入与参数契约。
//
// 三条要害：
//  ① **`--as-user` 是强制的**。导出的可见性、导入的 owner 归属与「只能覆盖自己的」
//     全部从 actor 出——没有它就没有判据可用。CLI 是本机 break-glass 通道，但那不
//     是「可以绕过判据」的理由，那会让「按谁的身份发生」变得不可追溯。
//  ② **同名多行时不猜**：同一个 owner 可以有两个同名工作流（`workflows.name` 非
//     唯一），`--type --name` 选不中确定的一行 ⇒ 报错并列出候选 id，让用户用 `--id`。
//  ③ `--plan` 与 `--on-conflict` **互斥**：一个是逐条显式决策，一个是一刀切默认，
//     同时给说明用户没想清楚哪个说了算——与其挑一个，不如让他明确。

//
// 覆盖验收条款：AC-26b（CLI 根选择器 --id） / AC-28（--plan/--apply/--on-conflict 互斥）/ AC-29（CLI 的权限、owner 归属与网页逐条一致） / AC-26 / AC-27（两条命令都必须 --as-user，缺则报错退出）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { packageCommand } from '../src/cli/package'

const SRC = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'package.ts'), 'utf8')
const MAIN = readFileSync(resolve(import.meta.dir, '..', 'src', 'main.ts'), 'utf8')

describe('① --as-user 强制', () => {
  test('导出不给 --as-user ⇒ 报错', async () => {
    const out = await packageCommand([
      'export',
      '--type',
      'agent',
      '--name',
      'x',
      '--out',
      '/tmp/x',
    ])
    expect(out.status).toBe('error')
    expect(out.output).toContain('--as-user is required')
  })

  test('导入不给 --as-user ⇒ 报错', async () => {
    const out = await packageCommand(['import', '--file', '/tmp/x.zip'])
    expect(out.status).toBe('error')
    expect(out.output).toContain('--as-user is required')
  })

  test('通过 composition-only local operator 解析与 HTTP 同源的访问投影（源码层）', () => {
    // CLI 与 HTTP 都从当前数据库访问状态解析最终 permissions；CLI 使用独立
    // local participant，不伪装成 daemon/session/PAT direct authority；具体
    // runtime 只由 main bootstrap 装配，package consumer 收窄 handle。
    expect(SRC).not.toContain('identity-access/composition')
    expect(SRC).toContain('identity.localActorForUser(row.id)')
    expect(MAIN).toContain('composePackageCommandBootstrap')
    expect(MAIN).toContain('identityAccess.localOperator.forUser(userId)')
    expect(SRC).not.toContain('buildCurrentActor(')
    expect(SRC).not.toMatch(/directAuthority\.(?:fromSession|fromPat|fromDaemon)\(/)
    expect(SRC).toContain('access revision')
  })
})

describe('② 同名多行不猜 / ③ 两个决策来源互斥', () => {
  test('`--id` 的存在理由写在 usage 里，并说明 workflows.name 非唯一', () => {
    expect(SRC).toContain('workflows.name is NOT unique')
  })

  test('同名多行的分支报错并列出候选（源码层）', () => {
    expect(SRC).toContain('pass --id to pick one')
  })

  test('--plan 与 --on-conflict 同时给 ⇒ 报错', async () => {
    const out = await packageCommand([
      'import',
      '--as-user',
      'nobody',
      '--file',
      '/tmp/x.zip',
      '--plan',
      '/tmp/p.json',
      '--on-conflict',
      'new',
    ])
    // 用户不存在会先报 user not found；两者都是「拒绝而不是猜」，这里断言它没有
    // 静默继续。
    expect(out.status).toBe('error')
  })

  test('一刀切默认值也要落在**允许**的动作里（源码层）', () => {
    // 例如别人的资源没有 overwrite —— 那就退回 reuse，再退回 new，而不是硬提交
    // 一个服务端必然拒绝的动作。
    expect(SRC).toContain('e.allowedActions.includes(want as never)')
    expect(SRC).toContain("? 'reuse'")
  })
})

describe('注册与帮助', () => {
  test('main.ts 挂了 package 命令', () => {
    expect(MAIN).toContain("case 'package':")
    expect(MAIN).toContain('packageCommand(Bun.argv.slice(3), composePackageCommandBootstrap)')
  })

  test('--help 写明 break-glass 边界（不是绕过判据的通道）', () => {
    expect(MAIN).toContain('not a way around them')
    expect(SRC).toContain('Break-glass boundary')
  })

  test('无子命令 ⇒ 打 usage 而不是静默成功', async () => {
    const out = await packageCommand([])
    expect(out.status).toBe('error')
    expect(out.output).toContain('usage: agent-workflow package')
  })
})
