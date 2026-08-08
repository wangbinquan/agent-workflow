// RFC-271 T9 —— bundle 引用槽的**回填**：wire 形态 → canonical id。
//
// 包里的引用有四种 wire 形态，各有各的归宿：
//   `local:<slug>`      → 本包内的目标，回填成**预铸 id**（同一批次里它还没落库）
//   `external:<token>`  → 库里既有的行，交给 provider 解析（含类型校验）
//   `project:<name>`    → 仓库自带技能，**不是资源**：原样按名字透传
//   `name:<type>/<n>`   → call 目标，**late-bound**：原样留名字，启动时才冻结
//
// ⚠️ 后两种「原样保留」不是偷懒：`project:` 没有 DB 行可指，而 call 的权威引用
// 本来就是名字（RFC-243），把它提前解析成 id 会让「导入后改名」这类正常操作
// 直接打断被调用方。

import type { AclResourceType } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import { localSlugOf } from './provider'

export interface RefResolveCtx {
  /** 本包内 slug → 预铸资源 id。 */
  idOfSlug: ReadonlyMap<string, string>
  /** `external:<token>` → 本地资源 id（含类型校验）。 */
  resolveExternal(ref: string, expectType: AclResourceType): Promise<string>
}

const PROJECT_PREFIX = 'project:'
const NAME_PREFIX = 'name:'

/** 身份域（`dependsOn` / `mcp` / `plugins` / 工作组成员）。只接受 local / external。 */
export async function resolveIdentityRef(
  ref: string,
  type: AclResourceType,
  ctx: RefResolveCtx,
): Promise<string> {
  const slug = localSlugOf(ref)
  if (slug !== null) {
    const id = ctx.idOfSlug.get(slug)
    if (id === undefined) {
      // 悬空 `local:` 在 shared 的 `collectBundleRefIssues` 就该被拒；走到这里说明
      // 调用方跳过了那道校验——fail closed，不要静默丢一个引用。
      throw new ValidationError(
        'bundle-dangling-local-ref',
        `bundle ref '${ref}' does not name any op in this bundle`,
      )
    }
    return id
  }
  if (ref.startsWith('external:')) return ctx.resolveExternal(ref, type)
  throw new ValidationError(
    'bundle-ref-invalid',
    `identity ref '${ref}' must be local: or external:`,
  )
}

/**
 * agent 的 `skills` 槽——**唯一**允许 `project:` 的地方。
 * 返回正式的判别联合形态（`agents.skills` 的存储形状）。
 */
export async function resolveAgentSkillRef(
  ref: string,
  ctx: RefResolveCtx,
): Promise<{ kind: 'managed'; skillId: string } | { kind: 'project'; name: string }> {
  if (ref.startsWith(PROJECT_PREFIX)) {
    const name = ref.slice(PROJECT_PREFIX.length)
    if (name.length === 0) {
      throw new ValidationError('bundle-ref-invalid', 'project skill ref has an empty name')
    }
    return { kind: 'project', name }
  }
  return { kind: 'managed', skillId: await resolveIdentityRef(ref, 'skill', ctx) }
}

/**
 * call 目标槽（`call-workflow` / `call-workgroup`）。
 *
 * 返回**写进节点的两个字段**：权威的 `name` 与可选的 `idHint`。
 * `name:` 形态只有名字（late-bound，导出方也可能根本看不见那一行）；
 * `local:` / `external:` 两种能解析出 id，于是名字与 id hint 都给全——这正是
 * 决策 28 依赖的那个 hint。
 */
export async function resolveCallRef(
  ref: string,
  type: 'workflow' | 'workgroup',
  ctx: RefResolveCtx,
  nameOfId: (id: string) => string | undefined,
): Promise<{ name: string; idHint?: string }> {
  if (ref.startsWith(NAME_PREFIX)) {
    const rest = ref.slice(NAME_PREFIX.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) {
      throw new ValidationError(
        'bundle-ref-invalid',
        `call ref '${ref}' must be name:<type>/<name>`,
      )
    }
    const declared = rest.slice(0, slash)
    const name = rest.slice(slash + 1)
    if (declared !== type) {
      throw new ValidationError(
        'bundle-ref-invalid',
        `call ref '${ref}' declares '${declared}' but the slot expects '${type}'`,
      )
    }
    if (name.length === 0) {
      throw new ValidationError('bundle-ref-invalid', `call ref '${ref}' has an empty name`)
    }
    return { name }
  }
  const id = await resolveIdentityRef(ref, type, ctx)
  const name = nameOfId(id)
  if (name === undefined) {
    // 解析出了 id 却拿不到名字：名字才是权威选择器，缺了它节点无法落库。
    throw new ValidationError(
      'bundle-ref-invalid',
      `call ref '${ref}' resolved to '${id}' but its name is unknown`,
    )
  }
  return { name, idHint: id }
}
