// `agent-workflow backup` — produce a tarball of agent-workflow state.

import { composeLocalSystemOperations } from '@/modules/system-operations/composition'

export interface BackupCommandResult {
  output: string
  status: 'ok' | 'error'
}

export async function backupCommand(argv: string[] = []): Promise<BackupCommandResult> {
  const includeWorktrees = argv.includes('--include-worktrees')
  // 开库放在 try **之内**：它自己也会失败（迁移目录解析、schema 准入、
  // integrity check），放在外面时那类失败会绕过下面的 `backup failed:` 前缀，
  // 运维只看到一句 drizzle 内部报错，既不含 backup 字样也不提是哪一步。
  try {
    const r = await composeLocalSystemOperations().requestBackup({ includeWorktrees })
    const sizeMb = (r.sizeBytes / 1024 / 1024).toFixed(2)
    const lines = [
      `backup written: ${r.path}`,
      `  size:      ${sizeMb} MB`,
      `  workflows: ${r.contents.workflows}`,
      `  skills:    ${r.contents.skills} files`,
      `  db:        ${r.contents.db ? 'included' : 'missing'}`,
      `  config:    ${r.contents.config ? 'included' : 'missing'}`,
    ]
    return { output: lines.join('\n') + '\n', status: 'ok' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: `backup failed: ${msg}\n`, status: 'error' }
  }
}
