// RFC-310 PR-9 T96（报告半）—— `agent-workflow migration-report`。
//
// 对 legacy `capability_templates` / `repo_capability_config` 跑一次 T94 分析
// 并打印可审计报告（默认人读表格，`--json` 原样 JSON）。只读：分析每次现算
// （可推导、成本低），不落库也不建 candidate——T95 落库由 cutover runbook 的
// materialize 步骤显式触发。daemon 无需在跑（直接开 db，与 migrate 同姿势）。

import { openDb } from '@/db/client'
import { resolveMigrationsFolder } from '@/util/migrationsFolder'
import { Paths } from '@/util/paths'
import {
  analyzeLegacyAssets,
  printMigrationReport,
} from '@/modules/development-automation/application/migrationAnalyzer'
import { collectLegacyAssets } from '@/modules/development-automation/infrastructure/migrationAssets'

export async function migrationReportCommand(args: readonly string[]): Promise<{ output: string }> {
  const asJson = args.includes('--json')
  const db = openDb({ path: Paths.db, migrationsFolder: await resolveMigrationsFolder() })
  try {
    const report = analyzeLegacyAssets(await collectLegacyAssets(db), Date.now())
    return {
      output: asJson ? `${JSON.stringify(report, null, 2)}\n` : `${printMigrationReport(report)}\n`,
    }
  } finally {
    // 与 migrate.ts 相同的收尾纪律：Windows 上泄漏的 bun:sqlite 句柄会锁目录。
    db.$client.close()
  }
}
