// RFC-330 —— 数字员工类型页三类卡片的控件按调用者档位收敛（proposal AC-12）。
//
// 判定集中在纯函数 `cardControls`（components/digital-employees/access.ts），这里逐格锁：
//   read  → 无编辑 / 退休、只读徽标、权限入口仍在（RFC-324 X10：可见者可看只读授权清单）
//   write → 有编辑、无退休、名字锁定（改名归 owner）
//   own   → 全部
//   平台工具 → 一切关闭、无权限入口（没有 ACL 行）
// 再用一条源码层文本断言兜底：三张卡片确实接了它（运行时巨型路由组件难以直接渲染）。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  cardControls,
  jobTemplateOptionLabel,
  requestedJobTemplateDecision,
} from '../src/components/digital-employees/access'

const PAGE = resolve(import.meta.dirname, '..', 'src', 'routes', 'digital-employees.$typeRef.tsx')
const CASE_PAGE = resolve(import.meta.dirname, '..', 'src', 'routes', 'employee-cases.$caseId.tsx')

describe('cardControls', () => {
  test('read 档：只读徽标 + 权限入口，无编辑 / 退休，名字锁定', () => {
    expect(cardControls({ access: 'read', canUpdate: true, canArchive: true })).toEqual({
      edit: false,
      govern: false,
      nameLocked: true,
      readOnlyBadge: true,
      aclEntry: true,
    })
  })

  test('write 档：可编辑、不可退休、名字锁定、无只读徽标', () => {
    expect(cardControls({ access: 'write', canUpdate: true, canArchive: true })).toEqual({
      edit: true,
      govern: false,
      nameLocked: true,
      readOnlyBadge: false,
      aclEntry: true,
    })
  })

  test('own 档：全部；粗粒度权限点缺失时对应控件仍关闭', () => {
    expect(cardControls({ access: 'own', canUpdate: true, canArchive: true })).toEqual({
      edit: true,
      govern: true,
      nameLocked: false,
      readOnlyBadge: false,
      aclEntry: true,
    })
    expect(cardControls({ access: 'own', canUpdate: false, canArchive: false })).toMatchObject({
      edit: false,
      govern: false,
    })
    // canArchive 未给（模版 / 员工卡）时治理面跟随 canUpdate。
    expect(cardControls({ access: 'own', canUpdate: true })).toMatchObject({ govern: true })
  })

  test('平台工具：无编辑 / 退休 / 权限入口，也不打只读徽标', () => {
    expect(
      cardControls({ access: 'read', canUpdate: true, canArchive: true, builtin: true }),
    ).toEqual({
      edit: false,
      govern: false,
      nameLocked: true,
      readOnlyBadge: false,
      aclEntry: false,
    })
  })
})

describe('类型页接线（源码层兜底断言）', () => {
  const source = readFileSync(PAGE, 'utf8')

  test('工具 / 模版 / 员工三张卡片都经 cardControls 决定控件，并各自挂了 AclDialogButton', () => {
    expect(source).toContain("from '@/components/digital-employees/access'")
    expect(source).toContain('cardControls({')
    expect(source).toContain('access: tool.access')
    expect(source).toContain('access: job.access')
    expect(source).toContain('access: employee.access')
    expect(source).toContain(
      'resourceBaseUrl={`/api/digital-employee-tools/${encodeURIComponent(tool.id)}`}',
    )
    expect(source).toContain(
      'resourceBaseUrl={`/api/digital-employee-job-templates/${encodeURIComponent(job.id)}`}',
    )
    expect(source).toContain(
      'resourceBaseUrl={`/api/digital-employees/${encodeURIComponent(employee.id)}`}',
    )
  })

  test('三个名字输入都按 nameLocked 锁定；员工卡的「创建任务」不受档位影响', () => {
    expect(source.split('.nameLocked').length - 1).toBeGreaterThanOrEqual(3)
    // 创建任务链接紧跟在（受档位控制的）编辑按钮组之后、且不在 cardControls 条件里。
    expect(source).toMatch(/data-testid=\{`digital-employee-create-task-\$\{employee\.id\}`\}/)
  })
})

describe("jobTemplateOptionLabel（D17'：重名才带 owner）", () => {
  const owners = {
    get: (id: string | null | undefined) =>
      id === 'alice' ? { displayName: 'Alice', username: 'alice' } : undefined,
  }
  const all = [
    { id: 'a', name: 'Reviewer', ownerUserId: 'alice' },
    { id: 'b', name: 'Reviewer', ownerUserId: 'bob' },
    { id: 'c', name: 'Planner', ownerUserId: 'alice' },
    { id: 'd', name: 'Reviewer', ownerUserId: null },
  ]
  test('不重名不加后缀；重名按显示名 → id → 系统 兜底', () => {
    expect(jobTemplateOptionLabel(all[2]!, all, owners)).toBe('Planner')
    expect(jobTemplateOptionLabel(all[0]!, all, owners)).toBe('Reviewer · Alice')
    expect(jobTemplateOptionLabel(all[1]!, all, owners)).toBe('Reviewer · bob')
    expect(jobTemplateOptionLabel(all[3]!, all, owners, '系统')).toBe('Reviewer · 系统')
  })
})

describe('深链与案例页（源码层兜底断言）', () => {
  test('模版深链经 requestedJobTemplateDecision 分流：wait 不消费、close 关深链、open 进编辑器', () => {
    const source = readFileSync(PAGE, 'utf8')
    expect(source).toContain('const decision = requestedJobTemplateDecision({')
    expect(source).toContain("if (decision === 'wait') return")
    // 只有就绪后才把请求标为已处理（wait 分支在标记之前返回）。
    const effect = source.slice(source.indexOf('const decision = requestedJobTemplateDecision({'))
    expect(effect.indexOf("if (decision === 'wait') return")).toBeLessThan(
      effect.indexOf('openedRequestedJobTemplateId.current = requestedId'),
    )
  })

  test('requestedJobTemplateDecision：权限点未就绪 → wait；就绪后 read → close，write / own → open', () => {
    expect(
      requestedJobTemplateDecision({ permissionsSettled: false, canUpdate: false, access: 'own' }),
    ).toBe('wait')
    expect(
      requestedJobTemplateDecision({ permissionsSettled: true, canUpdate: true, access: 'read' }),
    ).toBe('close')
    expect(
      requestedJobTemplateDecision({ permissionsSettled: true, canUpdate: true, access: 'write' }),
    ).toBe('open')
    expect(
      requestedJobTemplateDecision({ permissionsSettled: true, canUpdate: false, access: 'own' }),
    ).toBe('close')
  })

  test('案例页恢复按钮 = 权限点 ∧ members.canOperate === true（成员面未取到不渲染）', () => {
    const source = readFileSync(CASE_PAGE, 'utf8')
    expect(source).toContain(
      'const canResume = canResumePoint && members.data?.canOperate === true',
    )
    expect(source).toContain('<CaseMembersDialogButton caseId={caseId} />')
  })

  test('模版 / 员工卡片带 ResourceBadges（visibility 芯片 + owner 标识）', () => {
    const source = readFileSync(PAGE, 'utf8')
    expect(source).toContain('visibility={job.visibility}')
    expect(source).toContain('visibility={employee.visibility}')
    expect(source).toContain('label: jobTemplateOptionLabel(job, publishedJobs, owners')
  })
})

describe('案例页成员查询的 key 分离（源码层兜底断言）', () => {
  test('页面级 canOperate 查询用自己的 key，不与面板编辑快照共用', () => {
    const source = readFileSync(CASE_PAGE, 'utf8')
    expect(source).toContain('queryKey: CASE_MEMBERS_PAGE_QUERY_KEY(caseId, authRevision)')
  })

  test('WS 帧 employee-case.members.changed 只失效页面级成员查询，不碰面板编辑快照 key', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'hooks', 'useTasksSync.ts'),
      'utf8',
    )
    const rule = source.slice(source.indexOf("'employee-case.members.changed'"))
    // 到下一条规则为止（数组里嵌套的 `],` 不是规则的结尾）。
    const body = rule.slice(0, rule.indexOf("'lifecycle.alert'"))
    expect(body).toContain("['employee-case-members-page', msg.caseId]")
    expect(body).not.toContain("['employee-case-members', msg.caseId]")
  })
})
