// RFC-310 PR-9 T96（报告半）—— `agent-workflow migration-report`。
//
// 对 legacy `capability_templates` / `repo_capability_config` 跑一次 T94 分析
// 并打印可审计报告（默认人读表格，`--json` 原样 JSON）。只读：分析每次现算
// （可推导、成本低），不落库也不建 candidate——T95 落库由 cutover runbook 的
// materialize 步骤显式触发。daemon 无需在跑（直接开 db，与 migrate 同姿势）。
//
// RFC-474：分析与人读渲染是 development-automation 的，由 bootstrap 组装后经 `deps.analysis` 交进来；本处理器只解析 provider、
// 开关运行时与选输出格式。

import { resolveDatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { loadConfig } from '@/config'
import { existsSync } from 'node:fs'
import { Paths } from '@/util/paths'

/** What the command needs; bootstrap's `composeMigrationReportCommandDependencies()` supplies development-automation's analysis. */
export interface MigrationReportCommandDependencies<R> {
  readonly contract: LogicalSchemaContract
  /** The legacy asset analysis over the client this command opened (`now` is read after the rows are collected). */
  analysis(db: PersistenceDb): {
    analyze(now: () => number): Promise<R>
    render(report: R): string
  }
}

export async function migrationReportCommand<R>(
  args: readonly string[],
  deps: MigrationReportCommandDependencies<R>,
): Promise<{ output: string }> {
  const asJson = args.includes('--json')
  if (!existsSync(Paths.databaseGenerationPointer))
    throw new Error('migration-report requires an installed database generation')
  const runtime = resolveDatabaseProviderRuntime({
    config: loadConfig(Paths.config).database,
    sqlitePath: Paths.db,
    generationPointerPath: Paths.databaseGenerationPointer,
    operationsRoot: Paths.databaseMigrationsDir,
    contract: deps.contract,
  })
  try {
    if ('sqlitePath' in runtime && !existsSync(runtime.sqlitePath))
      throw new Error('migration-report requires an installed database generation')
    const db = runtime.openClient({ skipMigrations: true })
    const analysis = deps.analysis(db)
    const report = await analysis.analyze(() => Date.now())
    return {
      output: asJson ? `${JSON.stringify(report, null, 2)}\n` : `${analysis.render(report)}\n`,
    }
  } finally {
    // 与 migrate.ts 相同的收尾纪律：Windows 上泄漏的 bun:sqlite 句柄会锁目录。
    await runtime.close()
  }
}
