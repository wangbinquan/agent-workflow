import { DATABASE_PROVIDERS } from '@/platform/persistence/databaseProviders'
import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import type { DatabaseCliResult } from './database'
import type { EpochSwitchApplication } from '@/modules/system-operations/public/commands'
import type { EpochSwitchTargetInput } from '@/modules/system-operations/public/types'
import { CanonicalLogicalValueSchema } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'

const usage =
  'db migration plan|acknowledge|withdraw-acknowledgement|run|status|trace|verify|rollback|complete|discard|receipt|restore-backup [arguments] [--json]'
const booleanFlags = new Set([
  '--all',
  '--rehearse',
  '--json',
  '--new-run',
  '--replay',
  '--confirm',
  '--restore-config',
  '--all-unfinished-legacy-code-work',
])
const allowed: Record<string, readonly string[]> = {
  plan: [
    '--target',
    '--target-url-env',
    '--scratch-url-env',
    '--archive-empty-table',
    '--rehearse',
    '--chunk-rows',
    '--json',
  ],
  acknowledge: ['--item', '--all-unfinished-legacy-code-work', '--reason', '--by', '--json'],
  'withdraw-acknowledgement': ['--decision', '--all', '--json'],
  run: ['--approve', '--new-run', '--drain-timeout-ms', '--json'],
  status: ['--json'],
  trace: ['--phase', '--replay', '--task', '--json'],
  verify: ['--json'],
  rollback: ['--json'],
  complete: ['--json'],
  discard: ['--confirm', '--json'],
  receipt: ['--json'],
  'restore-backup': [
    '--target',
    '--target-url-env',
    '--restore-config',
    '--content-root',
    '--scratch-url-env',
    '--json',
  ],
}
class UsageError extends Error {}

function parse(argv: readonly string[]) {
  const [verb, ...args] = argv
  if (!verb || !allowed[verb]) throw new UsageError(usage)
  const flags = new Map<string, string[]>()
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    if (!allowed[verb]!.includes(arg)) throw new UsageError(`unknown option: ${arg}`)
    const value = booleanFlags.has(arg) ? 'true' : args[++index]
    if (!value || value.startsWith('--')) throw new UsageError(`${arg} requires a value`)
    if (flags.has(arg) && !['--item', '--decision', '--archive-empty-table'].includes(arg))
      throw new UsageError(`duplicate option: ${arg}`)
    flags.set(arg, [...(flags.get(arg) ?? []), value])
  }
  const flag = (name: string) => flags.get(name)?.[0]
  const has = (name: string) => flags.has(name)
  const number = (name: string, max = Number.MAX_SAFE_INTEGER) => {
    const text = flag(name)
    if (text === undefined) return undefined
    const value = Number(text)
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1 || value > max)
      throw new UsageError(`${name} requires an integer between 1 and ${max}`)
    return value
  }
  const arity = (min: number, max = min) => {
    if (positional.length < min || positional.length > max) throw new UsageError(usage)
  }
  const target = (): EpochSwitchTargetInput | undefined => {
    const requested = flag('--target') ?? (has('--target-url-env') ? 'postgresql' : undefined)
    if (requested === undefined) return undefined
    const provider = DATABASE_PROVIDERS.find((value) => value === requested)
    if (!provider) throw new UsageError('--target must be sqlite or postgresql')
    if (
      has('--target-url-env') &&
      persistenceDialect(provider).targetLocationKind !== 'postgresql-target'
    )
      throw new UsageError('--target-url-env requires postgresql')
    const urlEnv = flag('--target-url-env')
    if (urlEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(urlEnv))
      throw new UsageError('--target-url-env requires an environment variable name')
    return { provider, ...(urlEnv ? { urlEnv } : {}) }
  }
  return { verb, positional, flags, flag, has, number, arity, target }
}

function render(value: unknown): string {
  if (value && typeof value === 'object' && 'guidance' in value && Array.isArray(value.guidance))
    return `${JSON.stringify(value, null, 2)}\n${value.guidance.join('\n')}`
  return JSON.stringify(value, null, 2)
}

export async function epochMigrationCommand(
  argv: readonly string[],
  deps: {
    application: EpochSwitchApplication
    operatorName?: string
  },
): Promise<DatabaseCliResult> {
  try {
    const p = parse(argv)
    const app = deps.application
    const op = p.positional[0]!
    let result: unknown
    switch (p.verb) {
      case 'plan': {
        p.arity(0, 1)
        const emptyTables = p.flags.get('--archive-empty-table')?.map((entry) => {
          const index = entry.indexOf('=')
          if (index < 1 || !entry.slice(index + 1).trim())
            throw new UsageError('--archive-empty-table requires TABLE=REASON')
          return { table: entry.slice(0, index), reason: entry.slice(index + 1) }
        })
        result = await app.plan({
          operationId: op,
          target: p.target(),
          scratchUrlEnv: p.flag('--scratch-url-env'),
          emptyTables,
          rehearse: p.has('--rehearse'),
          chunkLimit: p.number('--chunk-rows', 10000),
        })
        break
      }
      case 'acknowledge': {
        p.arity(1)
        const items = p.flags.get('--item')
        const all = p.has('--all-unfinished-legacy-code-work')
        const reason = p.flag('--reason')
        if ((!items?.length && !all) || (items?.length && all) || !reason?.trim())
          throw new UsageError(
            'acknowledge requires --item ID (repeatable) or --all-unfinished-legacy-code-work, and --reason TEXT',
          )
        result = await app.acknowledge({
          operationId: op,
          items: all ? 'all-unfinished-legacy-code-work' : items!,
          reason,
          by:
            p.flag('--by') ??
            deps.operatorName ??
            process.env.USER ??
            process.env.USERNAME ??
            'local-operator',
        })
        break
      }
      case 'withdraw-acknowledgement': {
        p.arity(1)
        const decisions = p.flags.get('--decision')
        if ((!decisions?.length && !p.has('--all')) || (decisions?.length && p.has('--all')))
          throw new UsageError(
            'withdraw-acknowledgement requires --decision DIGEST (repeatable) or --all',
          )
        result = await app.withdrawAcknowledgements({
          operationId: op,
          decisions: p.has('--all') ? 'all' : decisions!,
        })
        break
      }
      case 'run':
        p.arity(1)
        result = await app.run({
          operationId: op,
          approve: p.flag('--approve'),
          newRun: p.has('--new-run'),
          drainTimeoutMs: p.number('--drain-timeout-ms'),
        })
        break
      case 'status':
        p.arity(0, 1)
        result = await app.status({ operationId: op })
        break
      case 'trace': {
        if (p.has('--task')) {
          p.arity(1)
          if (p.has('--phase') || p.has('--replay'))
            throw new UsageError('--task cannot be combined with --phase or --replay')
          result = await app.trace({ operationId: op, taskId: p.flag('--task')! })
        } else {
          p.arity(3)
          const phase = p.flag('--phase') ?? 'current'
          if (phase !== 'current' && phase !== 'pre-upgrade')
            throw new UsageError('--phase must be current or pre-upgrade')
          let key: unknown
          try {
            key = JSON.parse(p.positional[2]!)
          } catch {
            throw new UsageError('trace key must be a JSON array')
          }
          if (!Array.isArray(key) || !key.length)
            throw new UsageError('trace key must be a non-empty JSON array')
          const parsedKey = CanonicalLogicalValueSchema.array().safeParse(key)
          if (!parsedKey.success)
            throw new UsageError('trace key cells must use canonical logical value tags')
          result = await app.trace({
            operationId: op,
            table: p.positional[1]!,
            key: parsedKey.data,
            phase,
            replay: p.has('--replay'),
          })
        }
        break
      }
      case 'verify':
        p.arity(1)
        result = await app.verify({ operationId: op })
        break
      case 'rollback':
        p.arity(1)
        result = await app.rollback({ operationId: op })
        break
      case 'complete':
        p.arity(1)
        result = await app.complete({ operationId: op })
        break
      case 'discard':
        p.arity(1)
        if (!p.has('--confirm')) throw new UsageError('discard requires --confirm')
        result = await app.discard({ operationId: op, confirm: true })
        break
      case 'receipt': {
        p.arity(2)
        const kind = p.positional[1]
        if (
          kind !== 'plan' &&
          kind !== 'run' &&
          kind !== 'activation' &&
          kind !== 'switch' &&
          kind !== 'rollback'
        )
          throw new UsageError('unknown receipt kind')
        result = await app.receipt({ operationId: op, kind })
        break
      }
      case 'restore-backup':
        p.arity(1)
        result = await app.restoreBackup({
          artifact: op,
          target: p.target(),
          restoreConfig: p.has('--restore-config'),
          contentRoot: p.flag('--content-root'),
          scratchUrlEnv: p.flag('--scratch-url-env'),
        })
        break
    }
    return { status: 'ok', output: p.has('--json') ? JSON.stringify(result) : render(result) }
  } catch (error) {
    return {
      status: error instanceof UsageError ? 'usage-error' : 'error',
      output: error instanceof Error ? error.message : String(error),
    }
  }
}
