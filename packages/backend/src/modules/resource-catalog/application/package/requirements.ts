// RFC-271 package prerequisites.
//
// The manifest is advisory UI, but the bundle is the machine contract. Derive the
// prerequisite projection from that contract on both export and import so a hand-edited
// manifest cannot hide a missing runtime/executable (or invent a scary prerequisite).

import {
  decodeBundleCallRef,
  decodeBundleIdentityRef,
  type ResourceBundle,
} from '@agent-workflow/shared'

export interface PackageRequirements {
  runtimes: string[]
  codeHosts: string[]
  executables: string[]
  pluginSources: Array<{ name: string; spec: string; sourceKind: string }>
  projectSkills: string[]
  mcpKinds: string[]
  humanMembers: string[]
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** Stable, secret-safe prerequisite projection of a validated bundle. */
export function collectPackageRequirements(bundle: ResourceBundle): PackageRequirements {
  const runtimes = new Set<string>()
  const codeHosts = new Set<string>()
  const executables = new Set<string>()
  const pluginSources: PackageRequirements['pluginSources'] = []
  const projectSkills = new Set<string>()
  const mcpKinds = new Set<string>()
  const humanMembers = new Set<string>()

  for (const op of bundle.ops) {
    const payload = op.payload as Record<string, unknown>
    if (op.kind === 'agent-create' || op.kind === 'agent-update') {
      if (typeof payload.runtime === 'string' && payload.runtime.length > 0) {
        runtimes.add(payload.runtime)
      }
      for (const ref of Array.isArray(payload.skills) ? payload.skills : []) {
        if (typeof ref === 'string' && ref.startsWith('project:') && ref.length > 8) {
          projectSkills.add(ref.slice(8))
        }
      }
      continue
    }

    if (op.kind === 'workflow-create' || op.kind === 'workflow-update') {
      const definition = asRecord(payload.definition)
      for (const raw of Array.isArray(definition?.nodes) ? definition.nodes : []) {
        const node = asRecord(raw)
        if (
          node?.kind === 'code-host-call' &&
          typeof node.provider === 'string' &&
          node.provider.length > 0
        ) {
          codeHosts.add(node.provider)
        }
      }
      continue
    }

    if (op.kind === 'mcp-create' || op.kind === 'mcp-update') {
      if (typeof payload.type === 'string') mcpKinds.add(payload.type)
      if (payload.type === 'local') {
        const config = asRecord(payload.config)
        const command = Array.isArray(config?.command) ? config.command : []
        if (typeof command[0] === 'string' && command[0].length > 0) {
          executables.add(command[0])
        }
      }
      continue
    }

    if (op.kind === 'plugin-create' || op.kind === 'plugin-update') {
      pluginSources.push({
        name: String(payload.name ?? ''),
        spec: String(payload.spec ?? ''),
        sourceKind: String(payload.sourceKind ?? 'npm'),
      })
      continue
    }

    if (op.kind === 'workgroup-create' || op.kind === 'workgroup-update') {
      for (const raw of Array.isArray(payload.members) ? payload.members : []) {
        const member = asRecord(raw)
        if (
          member?.memberType === 'human' &&
          typeof member.username === 'string' &&
          member.username.length > 0
        ) {
          humanMembers.add(member.username)
        }
      }
    }
  }

  return {
    runtimes: [...runtimes].sort(),
    codeHosts: [...codeHosts].sort(),
    executables: [...executables].sort(),
    pluginSources: pluginSources.sort((a, b) =>
      a.name === b.name
        ? a.sourceKind === b.sourceKind
          ? a.spec.localeCompare(b.spec)
          : a.sourceKind.localeCompare(b.sourceKind)
        : a.name.localeCompare(b.name),
    ),
    projectSkills: [...projectSkills].sort(),
    mcpKinds: [...mcpKinds].sort(),
    humanMembers: [...humanMembers].sort(),
  }
}

/**
 * 收集 bundle 里实际出现的 built-in 身份：**引用槽 + rootRef**；同一项只声明一次。
 *
 * `rootRef` 那一支（上面 `takeIdentity(bundle.rootRef)`）不能漏：built-in 自己当根时它
 * **不在任何 op 的引用槽里**——它压根不产 op。
 *
 * ⚠️ 这个函数是 **manifest 侧与 parse 侧共用的唯一定义**，两边必须同源。实现门第四轮的
 * P1-1 就是它们不同源的代价：`manifest.builtins` 曾按「闭包里所有 builtin 资源」列，而
 * 对账按 bundle 扫。built-in 根 **且** 它自己还引用别的 built-in 时，闭包有两项、bundle
 * 只有 `rootRef` 一项（依赖压根不出现在包里），于是**真实的 `aw-skill-fusion` 导出返回
 * 200、产物却被自己的 parser 判 `package-invalid`**。
 *
 * 语义上也是 bundle 侧对：built-in 根的包只表达「绑你自己的那一个」，零 op、根的
 * definition 一个字节都没带，无从担保它内部还用了什么。
 */
export function collectBundleBuiltins(
  bundle: ResourceBundle,
): Array<{ type: string; name: string }> {
  const out = new Set<string>()
  const takeIdentity = (raw: unknown): void => {
    if (typeof raw !== 'string') return
    const ref = decodeBundleIdentityRef(raw)
    if (ref?.k === 'builtin') out.add(`${ref.type}\u0000${ref.name}`)
  }
  const takeCall = (raw: unknown): void => {
    if (typeof raw !== 'string') return
    const ref = decodeBundleCallRef(raw)
    if (ref?.k === 'builtin') out.add(`${ref.type}\u0000${ref.name}`)
  }

  if (bundle.rootRef?.startsWith('builtin:')) takeIdentity(bundle.rootRef)
  for (const op of bundle.ops) {
    const payload = op.payload as Record<string, unknown>
    if (op.kind === 'agent-create' || op.kind === 'agent-update') {
      for (const key of ['dependsOn', 'mcp', 'plugins'] as const) {
        for (const raw of Array.isArray(payload[key]) ? payload[key] : []) takeIdentity(raw)
      }
    }
    if (op.kind === 'workgroup-create' || op.kind === 'workgroup-update') {
      for (const raw of Array.isArray(payload.members) ? payload.members : []) {
        const member = raw as Record<string, unknown>
        if (member.memberType === 'agent') takeIdentity(member.agentRef)
      }
    }
    if (op.kind === 'workflow-create' || op.kind === 'workflow-update') {
      const definition = payload.definition as { nodes?: unknown } | undefined
      for (const raw of Array.isArray(definition?.nodes) ? definition.nodes : []) {
        const node = raw as Record<string, unknown>
        takeIdentity(node.agentRef)
        takeCall(node.workflowRef)
        takeCall(node.workgroupRef)
      }
    }
  }

  return [...out]
    .map((key) => {
      const [type, name] = key.split('\u0000')
      return { type: type!, name: name! }
    })
    .sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type),
    )
}
