// RFC-310 PR-3 T33 —— development adapter runner（integration 所有）。
//
// 以子进程执行已发布 adapter 的外部程序（design §3.3/§5.2）：
//   - cwd = one-shot staged sink（adapter 只被给这个目录写；close 后由
//     EvidenceStore safe-walk 重扫，adapter 自报的 file/digest 不作数）；
//   - env 从**空对象**构造：PATH/HOME/TMPDIR + AW_ADAPTER_SINK/AW_EXTERNAL_ID
//     + 声明的 secret projection（PR-3 恒空）+ mock 上游 URL（测试注入）——
//     不继承 daemon 环境（这是 adapter 与 Agent 的关键差异：adapter 是平台
//     自己拉起的受约束程序，空环境从第一天就成立）；
//   - stdout 只收一行小 envelope（256KB 上限，zod strict）；大文件走 sink。
// 失败一律映射 closed OperationFailureReceipt（§4.8）：超时/信号→transient、
// 非零退出→business-failure、envelope 破损→contract-violation。

import type { Subprocess } from 'bun'
import { z } from 'zod'

import { platformSpawnOptionsForHost } from '@/util/platformExec'

// 镜像自 modules/development-automation/domain/operationFailure.ts（RFC-284
// 镜像桥先例，同文件下方 canonicalStringify 的姿势）：integration 不能反向
// import development-automation 内部（rfc294 preflight 锁），closed 失败面在
// 此结构性自持；消费侧（materializer）按同形状读取。
export type AdapterFailureCategory =
  | 'transient'
  | 'stale-input'
  | 'configuration'
  | 'permission'
  | 'invalid-user-input'
  | 'business-failure'
  | 'contract-violation'
export type AdapterRetryability = 'same-input' | 'after-refresh' | 'after-configuration' | 'never'
export interface AdapterFailureReceipt {
  readonly category: AdapterFailureCategory
  readonly code: string
  readonly retryability: AdapterRetryability
  readonly attemptOrdinal: number
  readonly remediation: string
  readonly evidenceRef: string | null
}

const STDOUT_LIMIT = 256 * 1024

export const acquireEnvelopeSchema = z
  .object({
    protocol: z.literal('aw-adapter@1'),
    operation: z.literal('acquire'),
    sourceRevision: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    files: z
      .array(
        z
          .object({ relativePath: z.string().min(1).max(1024), role: z.string().min(1).max(60) })
          .strict(),
      )
      .max(1000),
  })
  .strict()

export const writebackEnvelopeSchema = z
  .object({
    protocol: z.literal('aw-adapter@1'),
    operation: z.literal('questions.writeback'),
    correlationRef: z.string().min(1).max(200),
  })
  .strict()

export const collectAnswersEnvelopeSchema = z
  .object({
    protocol: z.literal('aw-adapter@1'),
    operation: z.literal('answers.collect'),
    complete: z.boolean(),
    answerRevision: z.string().min(1).max(200).nullable(),
    answers: z
      .array(z.object({ questionId: z.string().min(1), answer: z.string() }).strict())
      .max(200),
  })
  .strict()

export interface AdapterRunInput {
  /** published developmentAdapterDefinition 内容（executableRef/timeoutMs/…）。 */
  readonly adapterContent: {
    readonly executableRef: string
    readonly timeoutMs: number
  }
  readonly operation:
    | { readonly kind: 'acquire'; readonly externalId: string }
    | {
        readonly kind: 'questions.writeback'
        readonly externalId: string
        readonly questionsJson: string
      }
    | {
        readonly kind: 'answers.collect'
        readonly externalId: string
        readonly correlationRef: string
      }
  readonly stagedRoot: string
  /** 测试/装配注入的额外 env（如 mock 上游 URL）；不含 daemon 环境。 */
  readonly extraEnv?: Record<string, string>
}

export type AdapterRunResult<T> =
  | { readonly ok: true; readonly envelope: T }
  | { readonly ok: false; readonly failure: AdapterFailureReceipt }

function failure(
  category: AdapterFailureCategory,
  code: string,
  retryability: AdapterRetryability,
  remediation: string,
): { ok: false; failure: AdapterFailureReceipt } {
  return {
    ok: false,
    failure: { category, code, retryability, attemptOrdinal: 0, remediation, evidenceRef: null },
  }
}

async function runAdapter(input: AdapterRunInput): Promise<AdapterRunResult<unknown>> {
  const exec = input.adapterContent.executableRef
  const scriptLike = /\.(?:ts|js|mjs|cjs)$/.test(exec)
  const argv: string[] = scriptLike ? [process.execPath, exec] : [exec]
  switch (input.operation.kind) {
    case 'acquire':
      argv.push('--acquire', input.operation.externalId)
      break
    case 'questions.writeback':
      argv.push('--writeback-questions')
      break
    case 'answers.collect':
      argv.push('--collect-answers', input.operation.correlationRef)
      break
  }
  const env: Record<string, string> = {
    // 空环境构造：只给运行所需的最小面。
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    AW_ADAPTER_SINK: input.stagedRoot,
    AW_EXTERNAL_ID: input.operation.externalId,
    ...(input.operation.kind === 'questions.writeback'
      ? { AW_ADAPTER_QUESTIONS: input.operation.questionsJson }
      : {}),
    ...(input.extraEnv ?? {}),
  }

  let proc: Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn({
      cmd: argv,
      cwd: input.stagedRoot,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ...platformSpawnOptionsForHost(),
    })
  } catch {
    return failure(
      'configuration',
      'adapter-executable-unavailable',
      'after-configuration',
      'fix the adapter executableRef',
    )
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, input.adapterContent.timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)

  if (timedOut) {
    return failure(
      'transient',
      'adapter-timeout',
      'same-input',
      'retry with backoff or raise adapter timeout',
    )
  }
  if (stdout.length > STDOUT_LIMIT) {
    return failure(
      'contract-violation',
      'adapter-stdout-overflow',
      'never',
      'adapter must keep stdout to one small envelope',
    )
  }
  if (exitCode !== 0) {
    return failure(
      'business-failure',
      `adapter-exit-${exitCode}`,
      'never',
      `adapter failed: ${stderr.slice(0, 500)}`,
    )
  }
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
  const last = lines[lines.length - 1]
  if (last === undefined) {
    return failure(
      'contract-violation',
      'adapter-envelope-missing',
      'never',
      'adapter printed no envelope',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(last)
  } catch {
    return failure(
      'contract-violation',
      'adapter-envelope-not-json',
      'never',
      'adapter envelope must be one JSON line',
    )
  }
  return { ok: true, envelope: parsed }
}

export async function runRequirementAcquire(
  input: AdapterRunInput & {
    readonly operation: { readonly kind: 'acquire'; readonly externalId: string }
  },
): Promise<AdapterRunResult<z.infer<typeof acquireEnvelopeSchema>>> {
  const raw = await runAdapter(input)
  if (!raw.ok) return raw
  const parsed = acquireEnvelopeSchema.safeParse(raw.envelope)
  if (!parsed.success) {
    return failure(
      'contract-violation',
      'adapter-envelope-schema',
      'never',
      'acquire envelope failed strict schema',
    )
  }
  return { ok: true, envelope: parsed.data }
}

export async function runQuestionsWriteback(
  input: AdapterRunInput & {
    readonly operation: {
      readonly kind: 'questions.writeback'
      readonly externalId: string
      readonly questionsJson: string
    }
  },
): Promise<AdapterRunResult<z.infer<typeof writebackEnvelopeSchema>>> {
  const raw = await runAdapter(input)
  if (!raw.ok) return raw
  const parsed = writebackEnvelopeSchema.safeParse(raw.envelope)
  if (!parsed.success) {
    return failure(
      'contract-violation',
      'adapter-envelope-schema',
      'never',
      'writeback envelope failed strict schema',
    )
  }
  return { ok: true, envelope: parsed.data }
}

export async function runAnswersCollect(
  input: AdapterRunInput & {
    readonly operation: {
      readonly kind: 'answers.collect'
      readonly externalId: string
      readonly correlationRef: string
    }
  },
): Promise<AdapterRunResult<z.infer<typeof collectAnswersEnvelopeSchema>>> {
  const raw = await runAdapter(input)
  if (!raw.ok) return raw
  const parsed = collectAnswersEnvelopeSchema.safeParse(raw.envelope)
  if (!parsed.success) {
    return failure(
      'contract-violation',
      'adapter-envelope-schema',
      'never',
      'collect envelope failed strict schema',
    )
  }
  return { ok: true, envelope: parsed.data }
}
