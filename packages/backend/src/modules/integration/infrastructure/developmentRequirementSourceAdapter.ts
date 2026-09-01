// RFC-310 PR-3 T33 —— requirement-source 执行适配（integration 所有）。
//
// 把「已发布 adapter binding + 一次操作」落成 runner 子进程调用，并把
// envelope/失败映射成 closed 结果。分工（design §5.2/§5.3）：本文件只负责
// 取件到 sink + 转述 envelope 事实；safe import、平台 manifest 生成与
// digest 全部在消费侧（development-automation workspace participant）
// ——adapter 自报的 file/digest 不作数。跨模块不 import：消费侧以结构同形
// 的窄函数依赖接住本工厂的返回值（rfc294 preflight 禁止反向内部 import）。
//
// 成对约束的运行时半边：operations 未声明的操作在此拒绝（configuration），
// 与发布期 validateAdapterContract 的 writeback/collect 成对校验互为表里。

import {
  developmentAdapterContentSchema,
  type DevelopmentAdapterContent,
} from '@/modules/integration/domain/developmentAdapterDefinition'
import {
  runAnswersCollect,
  runQuestionsWriteback,
  runRequirementAcquire,
  type AdapterFailureReceipt,
} from './developmentAdapterRunner'

export type RequirementSourceOutcome<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly failure: AdapterFailureReceipt }

export interface RequirementSourceExecution {
  acquire(input: {
    readonly adapterBindingRef: string
    readonly externalId: string
    readonly sinkPath: string
  }): Promise<
    RequirementSourceOutcome<{
      readonly sourceRevision: string
      readonly title: string
      readonly files: readonly { readonly relativePath: string; readonly role: string }[]
      readonly outputBudget: {
        readonly maxFiles: number
        readonly maxFileBytes: number
        readonly maxTotalBytes: number
      }
    }>
  >
  publishQuestions(input: {
    readonly adapterBindingRef: string
    readonly externalId: string
    readonly questionsJson: string
    readonly sinkPath: string
  }): Promise<RequirementSourceOutcome<{ readonly correlationRef: string }>>
  collectAnswers(input: {
    readonly adapterBindingRef: string
    readonly externalId: string
    readonly correlationRef: string
    readonly sinkPath: string
  }): Promise<
    RequirementSourceOutcome<{
      readonly complete: boolean
      readonly answerRevision: string | null
      readonly answers: readonly { readonly questionId: string; readonly answer: string }[]
    }>
  >
}

export interface RequirementSourceAdapterDeps {
  /** `id@revision` → 已发布 adapter 内容；未发布/不存在 → null。 */
  readonly resolveBinding: (
    adapterBindingRef: string,
  ) => DevelopmentAdapterContent | null | Promise<DevelopmentAdapterContent | null>
  /** 测试/装配注入的额外子进程 env（如 mock 上游 URL）；不含 daemon 环境。 */
  readonly extraEnv?: Record<string, string>
  readonly secretSource?: Readonly<Record<string, string | undefined>>
}

function fail(
  category: AdapterFailureReceipt['category'],
  code: string,
  retryability: AdapterFailureReceipt['retryability'],
  remediation: string,
): { ok: false; failure: AdapterFailureReceipt } {
  return {
    ok: false,
    failure: { category, code, retryability, attemptOrdinal: 0, remediation, evidenceRef: null },
  }
}

async function resolveFor(
  deps: RequirementSourceAdapterDeps,
  adapterBindingRef: string,
  operation: 'acquire' | 'questions.writeback' | 'answers.collect',
): Promise<
  | { readonly ok: true; readonly content: DevelopmentAdapterContent }
  | { readonly ok: false; readonly failure: AdapterFailureReceipt }
> {
  const content = await deps.resolveBinding(adapterBindingRef)
  if (content === null) {
    return fail(
      'configuration',
      'adapter-binding-unresolved',
      'after-configuration',
      `no published adapter content for ${adapterBindingRef}`,
    )
  }
  if (content.purpose !== 'requirement-source') {
    return fail(
      'configuration',
      'adapter-purpose-mismatch',
      'after-configuration',
      `adapter purpose is ${content.purpose}, expected requirement-source`,
    )
  }
  if (!content.operations.includes(operation)) {
    return fail(
      'configuration',
      'operation-not-declared',
      'after-configuration',
      `adapter does not declare operation ${operation}`,
    )
  }
  return { ok: true, content }
}

export function createRequirementSourceAdapter(
  deps: RequirementSourceAdapterDeps,
): RequirementSourceExecution {
  return {
    async acquire(input) {
      const resolved = await resolveFor(deps, input.adapterBindingRef, 'acquire')
      if (!resolved.ok) return resolved
      const run = await runRequirementAcquire({
        adapterContent: resolved.content,
        operation: { kind: 'acquire', externalId: input.externalId },
        stagedRoot: input.sinkPath,
        extraEnv: deps.extraEnv,
        secretSource: deps.secretSource,
      })
      if (!run.ok) return run
      return {
        ok: true,
        sourceRevision: run.envelope.sourceRevision,
        title: run.envelope.title,
        files: run.envelope.files,
        outputBudget: resolved.content.outputBudget,
      }
    },

    async publishQuestions(input) {
      const resolved = await resolveFor(deps, input.adapterBindingRef, 'questions.writeback')
      if (!resolved.ok) return resolved
      const run = await runQuestionsWriteback({
        adapterContent: resolved.content,
        operation: {
          kind: 'questions.writeback',
          externalId: input.externalId,
          questionsJson: input.questionsJson,
        },
        stagedRoot: input.sinkPath,
        extraEnv: deps.extraEnv,
        secretSource: deps.secretSource,
      })
      if (!run.ok) return run
      return { ok: true, correlationRef: run.envelope.correlationRef }
    },

    async collectAnswers(input) {
      const resolved = await resolveFor(deps, input.adapterBindingRef, 'answers.collect')
      if (!resolved.ok) return resolved
      const run = await runAnswersCollect({
        adapterContent: resolved.content,
        operation: {
          kind: 'answers.collect',
          externalId: input.externalId,
          correlationRef: input.correlationRef,
        },
        stagedRoot: input.sinkPath,
        extraEnv: deps.extraEnv,
        secretSource: deps.secretSource,
      })
      if (!run.ok) return run
      return {
        ok: true,
        complete: run.envelope.complete,
        answerRevision: run.envelope.answerRevision,
        answers: run.envelope.answers,
      }
    },
  }
}

/** `id@revision` binding 解析器（integration 自己的已发布 revision 面）。 */
export function createDbAdapterBindingResolver(
  getRevision: (id: string, revision: number) => { readonly contentJson: string } | null,
): (adapterBindingRef: string) => DevelopmentAdapterContent | null {
  return (adapterBindingRef) => {
    const at = adapterBindingRef.lastIndexOf('@')
    if (at <= 0) return null
    const revision = Number(adapterBindingRef.slice(at + 1))
    if (!Number.isInteger(revision) || revision <= 0) return null
    const row = getRevision(adapterBindingRef.slice(0, at), revision)
    if (row === null) return null
    const parsed = developmentAdapterContentSchema.safeParse(JSON.parse(row.contentJson))
    return parsed.success ? parsed.data : null
  }
}

/** PostgreSQL/remote-store variant; parsing remains identical to SQLite. */
export function createAsyncDbAdapterBindingResolver(
  getRevision: (id: string, revision: number) => Promise<{ readonly contentJson: string } | null>,
): (adapterBindingRef: string) => Promise<DevelopmentAdapterContent | null> {
  return async (adapterBindingRef) => {
    const at = adapterBindingRef.lastIndexOf('@')
    if (at <= 0) return null
    const revision = Number(adapterBindingRef.slice(at + 1))
    if (!Number.isInteger(revision) || revision <= 0) return null
    const row = await getRevision(adapterBindingRef.slice(0, at), revision)
    if (row === null) return null
    const parsed = developmentAdapterContentSchema.safeParse(JSON.parse(row.contentJson))
    return parsed.success ? parsed.data : null
  }
}
