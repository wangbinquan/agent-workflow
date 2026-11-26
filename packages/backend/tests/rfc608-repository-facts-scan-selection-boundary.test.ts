// RFC-608 — 仓库事实扫描的选择归 infrastructure（RFC-294 S10 余项：development-automation 的 composition 只装配）。
//
// 为什么存在：development-automation 的 composition/ 只剩一处控制流——`repositoryFactsScanner.ts` 按所选工作区效果有没有树操作，决定在卷内扫描
// 还是返回 undefined 让采集器回落到进程内扫描。扫描方式取决于效果实现的能力，属于 infrastructure 的实现选择。现在选择函数
// `repositoryFactsScanFor` 在采集器所在的 infrastructure，直接给出两种扫描之一，composition 只把效果交给它。锁两件事：
// ① 选择：没有树操作得到进程内扫描本身；有树操作时经它运行 `repository-facts-scan`，根是给定路径。
// ② 落位：composition/ 里不再有那个文件，composition 把工作区效果交给 `repositoryFactsScanFor`。
//
// 覆盖范围（C12）：① 跑选择函数；② 读 development-automation 的 composition。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AutomationWorkspaceEffectsFactory } from '@/modules/development-automation/application/ports/automationWorkspaceEffects'
import { repositoryFactsScanFor } from '@/modules/development-automation/infrastructure/repositoryFactsCollector'
import { scanRepositoryFacts } from '@/modules/development-automation/infrastructure/repositoryFactsScan'

const DA = join(import.meta.dir, '..', 'src', 'modules', 'development-automation')

describe('RFC-608 —— 仓库事实扫描的选择归 infrastructure', () => {
  test('没有树操作得到进程内扫描，有树操作时在卷内扫描', async () => {
    const native = {} as AutomationWorkspaceEffectsFactory
    expect(repositoryFactsScanFor(native)).toBe(scanRepositoryFacts)
    const calls: unknown[] = []
    const scanned = { languages: ['java'] }
    const volume = {
      treeOperations: {
        async run(operation: string, input: unknown) {
          calls.push([operation, input])
          return scanned
        },
      },
    } as unknown as AutomationWorkspaceEffectsFactory
    expect(await repositoryFactsScanFor(volume)('/volume/repo')).toBe(scanned as never)
    expect(calls).toEqual([['repository-facts-scan', { root: '/volume/repo' }]])
  })

  test('composition 不再有这处选择，只把工作区效果交出去', () => {
    expect(existsSync(join(DA, 'composition', 'repositoryFactsScanner.ts'))).toBe(false)
    const composition = readFileSync(join(DA, 'composition.ts'), 'utf8')
    expect(composition).toContain('repositoryFactsScanFor(deps.automationWorkspaceEffects)')
    expect(composition).not.toContain('repositoryFactsScannerOf')
  })
})
