// RFC-330 —— 数字员工类型页三类卡片（工具 / 岗位模版 / 员工定义）的控件档位。
//
// 纯函数：输入是权限点 + 列表项自带的 `access`（RFC-324 四值档位，由后端
// `projectVisibleRowsWithAccess` 逐行投影），输出是卡片要渲染哪些控件。集中在一处
// 是为了让三张卡片的判定不各自漂移，也让它能被直接单测（design §7.2）。
//
//   read  → 只读徽标；无编辑 / 发布 / 退休；员工卡的「创建任务」仍可用
//   write → 编辑 / 发布；无退休（治理面）；名字输入锁定（改名归 owner，RFC-324 D3）
//   own   → 全部
//
// 权限入口对**所有可见者**渲染（RFC-324 X10：非 owner 看到的是只读的授权清单）；
// 平台工具没有 ACL 行，不渲染。

import type { ResourceAccess } from '@agent-workflow/shared'

export function canEditAccess(access: ResourceAccess): boolean {
  return access === 'write' || access === 'own'
}

export function canGovernAccess(access: ResourceAccess): boolean {
  return access === 'own'
}

export interface CardControls {
  /** 编辑（工具 / 模版 / 员工的内容写；发布与编辑同档，RFC-324 D8）。 */
  readonly edit: boolean
  /** 退休 / 删草稿（治理面）。 */
  readonly govern: boolean
  /** 名字输入是否锁定（编辑者不能改名）。 */
  readonly nameLocked: boolean
  /** 只读徽标。 */
  readonly readOnlyBadge: boolean
  /** 权限入口（只读视图或可编辑面板由 AclPanel 自己决定）。 */
  readonly aclEntry: boolean
}

export function cardControls(input: {
  readonly access: ResourceAccess
  /** 粗粒度权限点：digital-employees:update。 */
  readonly canUpdate: boolean
  /** 粗粒度权限点：digital-employees:archive（工具退休）。 */
  readonly canArchive?: boolean
  /** 平台目录工具：无 ACL 行、不可编辑、无权限入口。 */
  readonly builtin?: boolean
}): CardControls {
  if (input.builtin === true) {
    return { edit: false, govern: false, nameLocked: true, readOnlyBadge: false, aclEntry: false }
  }
  const edit = input.canUpdate && canEditAccess(input.access)
  return {
    edit,
    govern: (input.canArchive ?? input.canUpdate) && canGovernAccess(input.access),
    nameLocked: !canGovernAccess(input.access),
    readOnlyBadge: !canEditAccess(input.access),
    aclEntry: true,
  }
}

/**
 * RFC-330 D17' —— 岗位模版名字只在 (owner, type, typeRevision) 内唯一，同一类型版本下
 * 不同 owner 可以同名。选择器与卡片按 id 选择，但**显示**上要能区分：只有出现重名时才
 * 追加 owner（显示名 → 用户名 → id → 「系统」），不给不重名的列表增加噪音。
 */
export function jobTemplateOptionLabel(
  job: { readonly id: string; readonly name: string; readonly ownerUserId: string | null },
  all: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  owners: {
    get(id: string | null | undefined): { displayName: string; username: string } | undefined
  },
  systemLabel = 'system',
): string {
  const duplicated = all.some((other) => other.id !== job.id && other.name === job.name)
  if (!duplicated) return job.name
  const owner = owners.get(job.ownerUserId)
  const ownerLabel = owner?.displayName ?? owner?.username ?? job.ownerUserId ?? systemLabel
  return `${job.name} · ${ownerLabel}`
}

/**
 * RFC-330 —— 岗位模版深链（`?jobTemplateId=`）的分流。三态：权限点尚未就绪（/me 仍在
 * 加载 / 刷新）时 **wait**——既不打开也不消费深链，否则 own / write 用户会在能力数据
 * 刷新的一瞬被判成 read 而永久丢掉深链；就绪后 edit 档 **open**、其它 **close**。
 */
export function requestedJobTemplateDecision(input: {
  readonly permissionsSettled: boolean
  readonly canUpdate: boolean
  readonly access: ResourceAccess
}): 'wait' | 'open' | 'close' {
  if (!input.permissionsSettled) return 'wait'
  return cardControls({ access: input.access, canUpdate: input.canUpdate }).edit ? 'open' : 'close'
}
