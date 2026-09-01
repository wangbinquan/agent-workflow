// 为什么有这条测试（2026-08-26 起草 RFC-319 B97 时撞到）：
//
// 「重试仓库准备」与 boot 自动恢复两处**手搓** StartTaskDeps，都漏了 `secretBox`，
// 而启动路径老老实实走 `buildStartTaskDeps(db, configPath, userId, secretBox)`。
// 后果：凡是配了 `secret.key` 的部署（仓库 URL 封存在 `cached_repos.url_enc`），
// `unsealRepoUrl(row, undefined, db)` 对「已封存但没有密钥箱」这一档直接返回 null
// （services/repoCredentials.ts），`services/task.ts` 随即抛 409
// `cached-repo-credential-unavailable`——**文案还写着「sealed with a different
// secret.key?」，把原因指向密钥换了，真实原因是压根没接密钥箱**。
//
// 于是 RFC-287 AC-11 承诺的「卡在仓库准备 → 点重试」这条唯一出口，在真实部署里
// 100% 不可用；`autoResumeOnBoot` 下这类任务每次 boot 白撞一次直到被熔断隔离。
// 它能活到今天，是因为既有 e2e 只断言了那颗按钮**可见**、从没点过它。
//
// 这是**同一个 bug 类的第二次复发**：`rfc103-launch-config-passthrough.test.ts` 的
// 文件头记着上一次——「commitPush 只在 JSON start 传，resume/repair/retry/
// multipart-start 均不传」。手搓 deps 就会漏字段，所以这里按同样的方式上锁。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { unsealRepoUrl } from '../src/services/repoCredentials'

const SRC = join(import.meta.dir, '..', 'src')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

describe('仓库准备重试 / boot 恢复必须带上 secretBox', () => {
  test('失败模式本身：封存过的 URL 在没有 secretBox 时读不出来（这就是 409 的来源）', () => {
    const sealed = { id: 'r1', urlEnc: 'v1:deadbeef' }
    expect(unsealRepoUrl(sealed, undefined)).toBeNull()
  })

  test('routes/tasks.ts 只调用 provider-neutral operation，SQLite adapter 复用完整 start deps', () => {
    const route = read('routes/tasks.ts')
    const sqlite = read('modules/task-execution/infrastructure/sqliteTaskRouteOperations.ts')
    expect(route).toContain("path: '/api/tasks/:id/nodes/:nodeRunId/retry'")
    expect(route).toContain('await operations.retry({')
    expect(route).not.toMatch(/\bsecretBox\b|\bDbClient\b/)
    expect(sqlite).toContain('...dependencies.startDepsFor(actor)')
    expect(sqlite).toContain('taskRecoveryOperations: dependencies.recovery')
  })

  test('bootstrap 只构造一次带 secretBox 的 start deps，重试与 boot 恢复复用 closed command', () => {
    const src = read('cli/start.ts')
    const runtime = read('modules/task-execution/composition/providerRuntime.ts')
    const autoResume = read('modules/task-execution/composition/taskAutoResume.ts')
    const startDeps = src.slice(
      src.indexOf('const taskStartDepsFor'),
      src.indexOf('const fusionStartDeps'),
    )
    expect(startDeps).toContain('buildStartTaskDeps(')
    expect(startDeps).toContain('secretBox')
    expect(src).toContain('repositoryPreparationRetry: Object.freeze({')
    expect(src).toContain('taskStartDepsFor(SYSTEM_USER_ID)')
    expect(runtime).toContain('repositoryPreparation: dependencies.repositoryPreparationRetry')
    expect(autoResume).toContain('input.repositoryPreparation.retry(taskId)')
  })
})
