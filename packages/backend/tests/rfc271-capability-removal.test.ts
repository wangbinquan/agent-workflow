// RFC-271 T46 —— 能力下线 C1–C6 的**不复辟**守卫。
//
// 这些能力是**刻意**移除的，不是忘了实现。仓里对「删了又被人以补齐为由加回来」的
// 态度很明确：删除要配一条 ratchet，并把理由摆在想加回去的人面前。
//
// C1 `GET /api/workflows/:id/export`（单文件 YAML 导出）
// C2 `POST /api/workflows/import`（裸 YAML 导入）+ 前端对话框
// C3 编辑页救援态的「导出本地 YAML」
// C4 无对应特权权限时**拒绝**导出（不是降级成「导出但去掉那些节点」）
// C5 覆盖判据是 owner，不再有 exact-id / 跨 owner 覆盖
// C6 传递闭包不可见时不再可导出
//
// 共同根因只有一句：**YAML 导出只序列化工作流自己的 `definition`**，代理背后的
// 技能 / MCP / 插件 / dependsOn 闭包一个字节都不在文件里，导入到另一个实例必然
// 悬空。那不是「功能少一点」，是一个会稳定产出坏结果的出口。

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BACKEND = resolve(import.meta.dir, '..')
const FRONTEND = resolve(BACKEND, '..', 'frontend')
const read = (p: string): string => readFileSync(p, 'utf8')

describe('C1 · 单文件 YAML 导出端点已下线', () => {
  test('路由没了，且取代它的那条在', () => {
    const src = read(resolve(BACKEND, 'src', 'routes', 'workflows.ts'))
    expect(src).not.toContain("path: '/api/workflows/:id/export'")
    const pkg = read(resolve(BACKEND, 'src', 'routes', 'resourcePackages.ts'))
    expect(pkg).toContain("path: '/api/workflows/:id/export-package'")
  })

  test('契约注册表同步 —— 覆盖守卫与实现一起收口', () => {
    const registry = read(resolve(BACKEND, 'tests', 'contracts', 'registry.ts'))
    expect(registry).not.toContain("path: '/api/workflows/:id/export'")
  })

  test('只服务它的 helper 一并删掉（不留死码）', () => {
    const src = read(resolve(BACKEND, 'src', 'routes', 'workflows.ts'))
    expect(src).not.toContain('parseExactPositiveInteger')
  })
})

describe('C2 · 裸 YAML 导入已下线', () => {
  test('后端端点与前端对话框都没了', () => {
    expect(read(resolve(BACKEND, 'src', 'routes', 'workflows.ts'))).not.toContain(
      "path: '/api/workflows/import'",
    )
    expect(existsSync(resolve(FRONTEND, 'src', 'components', 'WorkflowImportDialog.tsx'))).toBe(
      false,
    )
  })

  test('`postYaml` 也删了 —— 端点没了还留着它就是死码', () => {
    const list = read(resolve(FRONTEND, 'src', 'routes', 'workflows.tsx'))
    expect(list).not.toContain('postYaml')
    expect(list).not.toContain('WorkflowImportDialog')
  })

  test('取代入口融入创建流程，列表 header 不再复辟独立导入按钮', () => {
    const list = read(resolve(FRONTEND, 'src', 'routes', 'workflows.tsx'))
    expect(list).toContain('ResourcePackageImportDialog')
    expect(list).toContain('alternativeAction={{')
    expect(list).toContain("setCreateSurfaceTracked('package')")
    expect(list).not.toContain('ResourcePackageImportEntry')
    expect(list).not.toContain('emptyHeaderActions=')
  })
})

describe('C1/C2 · 已下线的端点不得有任何调用方（含 e2e）', () => {
  // 批次 I 只扫了前端源码，**漏了 e2e** —— 于是三个 spec 还在打
  // `POST /api/workflows/import`，而 `gate:local` 不跑 Playwright，本地全绿、CI 才红。
  // 这条守卫把 e2e 一并纳入扫描面，让「删端点」与「清调用方」不能再脱节。
  const E2E = resolve(BACKEND, '..', '..', 'e2e')

  test('e2e 里没有任何文件调用已删的两条端点', () => {
    const offenders: string[] = []
    for (const name of readdirSync(E2E)) {
      if (!name.endsWith('.ts')) continue
      const src = read(resolve(E2E, name))
      // 注释里提到端点名是允许的（解释为什么不能用它）；这里只抓真实调用。
      if (/apiFetch\(\s*['"`][^'"`]*\/api\/workflows\/import/.test(src)) offenders.push(name)
      if (/fetch\(\s*[^)]*\/api\/workflows\/import/.test(src)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  test('被它取代的 fixture 装载 helper 在，且走的是公开端点', () => {
    const helper = read(resolve(E2E, 'workflow-fixtures.ts'))
    expect(helper).toContain("apiFetch('/api/workflows'")
    // 不许绕回那条已下线的服务函数——那会让 e2e 依赖一条产品上不存在的路径。
    // ⚠️ 断言的是 **import 语句**，不是裸文本：这个文件的注释里正当地提到了那个
    // 函数名（解释为什么不用它），扫裸文本会匹配到自己的注释而恒红。
    expect(helper).not.toMatch(/^\s*import[^\n]*workflow\.yaml/m)
    expect(helper).not.toMatch(/importWorkflowYaml\s*\(/)
  })
})

describe('C3 · 救援态的本地 YAML 导出已下线', () => {
  test('lib 与它的测试都删了', () => {
    expect(existsSync(resolve(FRONTEND, 'src', 'lib', 'workflow-draft-export.ts'))).toBe(false)
    expect(existsSync(resolve(FRONTEND, 'tests', 'workflow-draft-export.test.ts'))).toBe(false)
  })

  test('`WorkflowDraftStatus` 不再有 onExportLocal', () => {
    const src = read(
      resolve(FRONTEND, 'src', 'components', 'workflow-editor', 'WorkflowDraftStatus.tsx'),
    )
    expect(src).not.toContain('onExportLocal')
  })

  test('救援态**保留**了真能救回工作的三条动作 —— 下线的只是产出坏文件的那个出口', () => {
    const src = read(
      resolve(FRONTEND, 'src', 'components', 'workflow-editor', 'WorkflowDraftStatus.tsx'),
    )
    expect(src).toContain('onSaveCopy')
    expect(src).toContain('onRetryAccess')
    expect(src).toContain('onReturnToList')
  })

  test('编辑页不再调那两个下载函数、也不再打那条 export URL', () => {
    const edit = read(resolve(FRONTEND, 'src', 'routes', 'workflows.edit.tsx'))
    expect(edit).not.toContain('downloadWorkflowLocalDraft')
    expect(edit).not.toContain('downloadWorkflowServerExport')
    expect(edit).not.toContain("/export'")
  })
})

describe('C4/C5/C6 · 导出与覆盖侧的三条收缩仍然生效', () => {
  const closure = read(resolve(BACKEND, 'src', 'services', 'resourcePackage', 'closure.ts'))

  test('C4：缺特权权限 ⇒ **拒绝**，不降级成「导出但去掉那些节点」', () => {
    // 降级会产出一个「看起来能用、跑起来少一半」的包——比拒绝糟得多。
    expect(closure).toContain('package-privileged-node-forbidden')
    expect(closure).not.toContain('skipPrivilegedNodes')
  })

  test('C5：覆盖判据是 owner，不是 exact-id、也不是角色', () => {
    const commit = read(resolve(BACKEND, 'src', 'services', 'resourcePackage', 'commit.ts'))
    expect(read(resolve(BACKEND, 'src', 'services', 'bundle', 'apply.ts'))).toContain(
      'bundle-overwrite-not-owned',
    )
    // manager / admin 不再能跨 owner 覆盖：判据里没有任何角色分支。
    expect(commit).not.toMatch(/role === 'admin'|isResourceAdminActor/)
  })

  test('C6：传递闭包里有不可见资源 ⇒ 整体拒绝', () => {
    expect(closure).toContain('package-export-ref-unavailable')
  })
})

describe('保留项 —— 下线不得误伤仍被使用的帮手', () => {
  test('`workflowDefinitionToSelectors` / `stripCallWorkflowNodeIds` 还在', () => {
    const yaml = read(resolve(BACKEND, 'src', 'services', 'workflow.yaml.ts'))
    expect(yaml).toContain('workflowDefinitionToSelectors')
    expect(yaml).toContain('stripCallWorkflowNodeIds')
  })
})
