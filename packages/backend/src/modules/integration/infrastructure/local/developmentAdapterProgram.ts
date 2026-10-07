// RFC-370 native program implementation; application sees opaque program/stage refs.
import type { Subprocess } from 'bun'
import type {
  EvidenceStagingNamespace,
  EvidenceStagingReference,
} from '@/modules/development-automation/public/types'
import type {
  AdapterConfigurationReference,
  AdapterFailureCategory,
  AdapterFailureReceipt,
  AdapterRetryability,
  AdapterProcessObservation,
  AdapterProgramFactory,
  AdapterProgramReference,
  ApprovalAdapterEffects,
  PipelineAdapterEffects,
  RequirementAdapterEffects,
} from '../../application/ports/developmentAdapterEffects'
import type { DevelopmentAdapterOperation } from '../../application/developmentAdapterOperation'
import { platformSpawnOptionsForHost } from '@/util/platformExec'
import { killProcessTree, readStreamCapped, reapDetachedGroup } from '@/util/process'

const STDOUT_LIMIT = 256 * 1024
/** TERM 之后给整组的宽限。 */
const ADAPTER_KILL_GRACE_MS = 2_000
/** 超时路径上等整组死透的上限——有界，绝不无限等。 */
const ADAPTER_REAP_WINDOW_MS = 2_000
const DAEMON_BOOT_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({
  ...process.env,
})
const SECRET_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/

export interface NativeAdapterRunInput {
  /** published developmentAdapterDefinition 内容（executableRef/timeoutMs/…）。 */
  readonly adapterContent: {
    readonly executableRef: string
    readonly timeoutMs: number
    readonly connectionRef: string | null
    readonly secretProjection: readonly string[]
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
    | {
        readonly kind: 'pipeline.collect'
        readonly headSha: string
        readonly targetSha: string
        readonly gateKeysCsv: string
      }
    | {
        readonly kind: 'pipeline.trigger'
        readonly headSha: string
        readonly gateKeysCsv: string
        readonly idempotencyKey: string
      }
    | {
        readonly kind: 'pipeline.rerun'
        readonly runRef: string
        readonly gateKey: string
        readonly headSha: string
        readonly idempotencyKey: string
      }
    | {
        readonly kind: 'approval.submit'
        readonly stepRunRef: string
        readonly draftRef: string
        readonly deadlineAt: string
        readonly idempotencyKey: string
        readonly intentDigest: string
      }
    | { readonly kind: 'approval.lookup'; readonly idempotencyKey: string }
    | { readonly kind: 'approval.observe'; readonly correlationRef: string }
  readonly stagedRoot: string
  /** 测试/装配注入的额外 env（如 mock 上游 URL）；不含 daemon 环境。 */
  readonly extraEnv?: Record<string, string>
  /** Daemon-boot snapshot; injectable only at the Integration composition/test boundary. */
  readonly secretSource?: Readonly<Record<string, string | undefined>>
}

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

type NativeAdapterConfiguration = Pick<
  NativeAdapterRunInput,
  'adapterContent' | 'extraEnv' | 'secretSource'
>

export function createLocalDevelopmentAdapterEffects(deps: {
  readonly namespace: EvidenceStagingNamespace
  resolveStaging(reference: EvidenceStagingReference): string
}): {
  readonly requirement: RequirementAdapterEffects
  readonly pipeline: PipelineAdapterEffects
  readonly approval: ApprovalAdapterEffects
  configurationFor(input: NativeAdapterConfiguration): AdapterConfigurationReference
} {
  const configurations = new WeakMap<object, NativeAdapterConfiguration>()
  const preparedPrograms = new WeakMap<
    object,
    {
      readonly configuration: NativeAdapterConfiguration
      readonly projectedSecrets: Record<string, string>
    }
  >()
  const programs: AdapterProgramFactory = {
    bind(configuration) {
      const input = configurations.get(configuration.reference)
      if (input === undefined) throw new Error('native-development-adapter-configuration-unknown')
      const secretSource = input.secretSource ?? DAEMON_BOOT_ENV
      const projectedSecrets: Record<string, string> = {}
      for (const key of input.adapterContent.secretProjection) {
        if (
          !SECRET_ENV_KEY.test(key) ||
          key.startsWith('AW_') ||
          key === 'PATH' ||
          key === 'HOME' ||
          key === 'TMPDIR'
        ) {
          return failure(
            'configuration',
            'adapter-secret-projection-invalid',
            'after-configuration',
            `replace invalid projected environment key ${key}`,
          )
        }
        const value = secretSource[key]
        if (value === undefined) {
          return failure(
            'configuration',
            'adapter-secret-projection-missing',
            'after-configuration',
            `configure declared adapter environment key ${key} before restarting the daemon`,
          )
        }
        projectedSecrets[key] = value
      }
      const program: AdapterProgramReference = {
        kind: 'development-adapter-program',
        reference: {},
      }
      preparedPrograms.set(program.reference, { configuration: input, projectedSecrets })
      return { ok: true, program }
    },
  }
  async function execute(
    program: AdapterProgramReference,
    staging: EvidenceStagingReference,
    operation: DevelopmentAdapterOperation,
  ): Promise<AdapterProcessObservation> {
    const prepared = preparedPrograms.get(program.reference)
    if (prepared === undefined) throw new Error('native-development-adapter-program-unknown')
    const configuration = prepared.configuration
    const input: NativeAdapterRunInput = {
      get adapterContent() {
        return configuration.adapterContent
      },
      get extraEnv() {
        return configuration.extraEnv
      },
      get secretSource() {
        return configuration.secretSource
      },
      operation,
      get stagedRoot() {
        return deps.resolveStaging(staging)
      },
    }
    const projectedSecrets = prepared.projectedSecrets
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
      case 'pipeline.collect':
        argv.push('--collect-pipeline', input.operation.headSha)
        break
      case 'pipeline.trigger':
        argv.push('--trigger-pipeline', input.operation.headSha)
        break
      case 'pipeline.rerun':
        argv.push('--rerun-pipeline', input.operation.runRef)
        break
      case 'approval.submit':
        argv.push('--submit-approval', input.operation.stepRunRef)
        break
      case 'approval.lookup':
        argv.push('--lookup-approval', input.operation.idempotencyKey)
        break
      case 'approval.observe':
        argv.push('--observe-approval', input.operation.correlationRef)
        break
    }
    const op = input.operation
    const env: Record<string, string> = {
      ...(input.extraEnv ?? {}),
      // 空环境构造：只给运行所需的最小面。AW_EXTERNAL_ID 是 requirement 三 op
      // 专属；pipeline 三 op 用 AW_PIPELINE_* 面。
      PATH: DAEMON_BOOT_ENV.PATH ?? '',
      HOME: DAEMON_BOOT_ENV.HOME ?? '',
      TMPDIR: DAEMON_BOOT_ENV.TMPDIR ?? '/tmp',
      AW_ADAPTER_SINK: input.stagedRoot,
      ...(input.adapterContent.connectionRef === null
        ? {}
        : { AW_ADAPTER_CONNECTION_REF: input.adapterContent.connectionRef }),
      ...(op.kind === 'acquire' ||
      op.kind === 'questions.writeback' ||
      op.kind === 'answers.collect'
        ? { AW_EXTERNAL_ID: op.externalId }
        : {}),
      ...(op.kind === 'questions.writeback' ? { AW_ADAPTER_QUESTIONS: op.questionsJson } : {}),
      ...(op.kind === 'pipeline.collect'
        ? {
            AW_PIPELINE_HEAD: op.headSha,
            AW_PIPELINE_TARGET: op.targetSha,
            AW_PIPELINE_GATES: op.gateKeysCsv,
          }
        : {}),
      ...(op.kind === 'pipeline.trigger'
        ? {
            AW_PIPELINE_HEAD: op.headSha,
            AW_PIPELINE_GATES: op.gateKeysCsv,
            AW_IDEMPOTENCY_KEY: op.idempotencyKey,
          }
        : {}),
      ...(op.kind === 'pipeline.rerun'
        ? {
            AW_PIPELINE_HEAD: op.headSha,
            AW_PIPELINE_GATE: op.gateKey,
            AW_IDEMPOTENCY_KEY: op.idempotencyKey,
          }
        : {}),
      ...(op.kind === 'approval.submit'
        ? {
            AW_APPROVAL_STEP_RUN: op.stepRunRef,
            AW_APPROVAL_DRAFT_REF: op.draftRef,
            AW_APPROVAL_DEADLINE: op.deadlineAt,
            AW_IDEMPOTENCY_KEY: op.idempotencyKey,
            AW_APPROVAL_INTENT_DIGEST: op.intentDigest,
          }
        : {}),
      ...(op.kind === 'approval.lookup' ? { AW_IDEMPOTENCY_KEY: op.idempotencyKey } : {}),
      ...(op.kind === 'approval.observe' ? { AW_APPROVAL_CORRELATION_REF: op.correlationRef } : {}),
      ...projectedSecrets,
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
        // RFC-317 T35（EK-01）—— 自成进程组：这里跑的是**外部适配器可执行文件**，
        // 它 fork 什么完全不受本仓控制。不 detached 时下面的杀链只能杀到直接子进程。
        detached: true,
      })
    } catch {
      return { kind: 'unavailable' }
    }

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // 整组杀，且 TERM 先行留一个宽限——改造前是一发裸 SIGKILL 打给直接子进程：
      // 既没有优雅退出的机会，孙进程也全都活着。
      killProcessTree(proc.pid, 'SIGTERM')
      setTimeout(() => killProcessTree(proc.pid, 'SIGKILL'), ADAPTER_KILL_GRACE_MS).unref?.()
    }, input.adapterContent.timeoutMs)
    // **边读边限**。改造前是 `new Response(proc.stdout).text()`——完整读进内存之后才去
    // 判断 `stdout.length > STDOUT_LIMIT`。那条 256 KiB 的「上限」不提供任何内存保护：
    // 字节早就在堆里了，一个话痨的适配器会在判断跑到之前把 daemon 撑爆。
    const [stdout, , exitCode] = await Promise.all([
      readStreamCapped(proc.stdout as ReadableStream<Uint8Array> | undefined, STDOUT_LIMIT + 1),
      readStreamCapped(proc.stderr as ReadableStream<Uint8Array> | undefined, STDOUT_LIMIT + 1),
      proc.exited,
    ])
    clearTimeout(timer)
    // 有界收尸：超时路径上组里可能还有孙进程没死透。
    if (timedOut) await reapDetachedGroup(proc.pid, ADAPTER_REAP_WINDOW_MS)

    return timedOut ? { kind: 'expired' } : { kind: 'completed', stdout, exitCode }
  }
  const requirement: RequirementAdapterEffects = {
    namespace: deps.namespace,
    programs,
    acquire(input) {
      return execute(input.program, input.staging, {
        kind: 'acquire',
        externalId: input.externalId,
      })
    },
    questionsWriteback(input) {
      return execute(input.program, input.staging, {
        kind: 'questions.writeback',
        externalId: input.externalId,
        questionsJson: input.questionsJson,
      })
    },
    answersCollect(input) {
      return execute(input.program, input.staging, {
        kind: 'answers.collect',
        externalId: input.externalId,
        correlationRef: input.correlationRef,
      })
    },
  }
  const pipeline: PipelineAdapterEffects = {
    namespace: deps.namespace,
    programs,
    collect(input) {
      return execute(input.program, input.staging, {
        kind: 'pipeline.collect',
        headSha: input.headSha,
        targetSha: input.targetSha,
        gateKeysCsv: input.gateKeysCsv,
      })
    },
    trigger(input) {
      return execute(input.program, input.staging, {
        kind: 'pipeline.trigger',
        headSha: input.headSha,
        gateKeysCsv: input.gateKeysCsv,
        idempotencyKey: input.idempotencyKey,
      })
    },
    rerun(input) {
      return execute(input.program, input.staging, {
        kind: 'pipeline.rerun',
        runRef: input.runRef,
        gateKey: input.gateKey,
        headSha: input.headSha,
        idempotencyKey: input.idempotencyKey,
      })
    },
  }
  const approval: ApprovalAdapterEffects = {
    namespace: deps.namespace,
    programs,
    submit(input) {
      return execute(input.program, input.staging, {
        kind: 'approval.submit',
        stepRunRef: input.stepRunRef,
        draftRef: input.draftRef,
        deadlineAt: input.deadlineAt,
        idempotencyKey: input.idempotencyKey,
        intentDigest: input.intentDigest,
      })
    },
    lookup(input) {
      return execute(input.program, input.staging, {
        kind: 'approval.lookup',
        idempotencyKey: input.idempotencyKey,
      })
    },
    observe(input) {
      return execute(input.program, input.staging, {
        kind: 'approval.observe',
        correlationRef: input.correlationRef,
      })
    },
  }
  return {
    requirement,
    pipeline,
    approval,
    configurationFor(input) {
      const reference: AdapterConfigurationReference = {
        kind: 'development-adapter-configuration',
        reference: {},
      }
      configurations.set(reference.reference, input)
      return reference
    },
  }
}
