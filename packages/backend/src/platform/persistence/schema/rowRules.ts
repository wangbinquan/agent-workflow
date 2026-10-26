// RFC-395 II-b R1: the closed row-rule language is shared by both native compilers.
import { unhandledDatabaseProvider, type DatabaseProvider } from '../databaseProviders'
import type { TableDefinition } from './contribution'
import type { SchemaRegistry } from './registry'
import {
  quoteSchemaIdentifier as quote,
  renderSchemaExpression,
  type SchemaExpression,
} from './expressions'

export type RowCondition =
  | Extract<SchemaExpression, { kind: 'column' | 'literal' }>
  | {
      readonly kind: 'binary'
      readonly op: Extract<SchemaExpression, { kind: 'binary' }>['op']
      readonly left: RowCondition
      readonly right: RowCondition
    }
  | {
      readonly kind: 'unary'
      readonly op: 'NOT' | 'IS NULL' | 'IS NOT NULL'
      readonly value: RowCondition
    }
  | { readonly kind: 'in'; readonly value: RowCondition; readonly values: readonly RowCondition[] }
  | {
      readonly kind: 'call'
      readonly name: Extract<SchemaExpression, { kind: 'call' }>['name']
      readonly args: readonly RowCondition[]
    }
export type RowRule =
  | {
      readonly kind: 'immutableOnceSet'
      readonly columns: readonly string[]
      readonly when: RowCondition
      readonly errorCode: string
    }
  | { readonly kind: 'appendOnly'; readonly table: string; readonly errorCode: string }

export function immutableOnceSet(
  columns: readonly string[],
  when: RowCondition,
  errorCode: string,
): RowRule {
  return {
    kind: 'immutableOnceSet',
    columns,
    when,
    errorCode,
  }
}
export function appendOnly(table: string, errorCode: string): RowRule {
  return { kind: 'appendOnly', table, errorCode }
}

/** Row predicates may only refer to declared columns, never raw SQL or another row. */
export function validateRowCondition(expression: SchemaExpression, names: readonly string[]): void {
  switch (expression.kind) {
    case 'column':
      if (!names.includes(expression.name))
        throw new Error(`RFC-395 unknown row-rule column: ${expression.name}`)
      return
    case 'literal':
      return
    case 'binary':
      validateRowCondition(expression.left, names)
      validateRowCondition(expression.right, names)
      return
    case 'unary':
      validateRowCondition(expression.value, names)
      return
    case 'in':
      validateRowCondition(expression.value, names)
      expression.values.forEach((value) => validateRowCondition(value, names))
      return
    case 'call':
      expression.args.forEach((value) => validateRowCondition(value, names))
      return
    default:
      throw new Error('RFC-395 untyped row rule is forbidden')
  }
}

function oldCondition(expression: SchemaExpression, provider: DatabaseProvider): string {
  // Render the typed tree with qualified OLD references; do not rewrite SQL text.
  switch (expression.kind) {
    case 'column':
      return `OLD.${quote(expression.name)}`
    case 'literal':
      return renderSchemaExpression(expression, provider)
    case 'binary':
      return `(${oldCondition(expression.left, provider)} ${expression.op} ${oldCondition(expression.right, provider)})`
    case 'unary':
      return expression.op === 'NOT'
        ? `NOT (${oldCondition(expression.value, provider)})`
        : `${oldCondition(expression.value, provider)} ${expression.op}`
    case 'in':
      return `${oldCondition(expression.value, provider)} IN (${expression.values.map((value) => oldCondition(value, provider)).join(', ')})`
    case 'call':
      return `${expression.name === 'jsonValid' ? 'json_valid' : expression.name}(${expression.args.map((value) => oldCondition(value, provider)).join(', ')})`
    default:
      throw new Error('RFC-395 untyped row rule is forbidden')
  }
}
export interface RowRuleStatement {
  readonly kind: 'trigger' | 'function'
  readonly logicalId: string
  readonly sql: string
}
export function compileRowRules(
  table: TableDefinition,
  provider: DatabaseProvider,
): RowRuleStatement[] {
  return (table.rowRules ?? []).flatMap((rule, ordinal) => {
    const name = `rfc395_${table.id}_${ordinal}`
    const logicalId = `${table.id}:row-rule:${ordinal}`
    const message = renderSchemaExpression({ kind: 'literal', value: rule.errorCode }, provider)
    const always = renderSchemaExpression({ kind: 'literal', value: true }, provider)
    let distinct: string
    switch (provider) {
      case 'sqlite':
        distinct = 'IS NOT'
        break
      case 'postgresql':
        distinct = 'IS DISTINCT FROM'
        break
      default:
        return unhandledDatabaseProvider(provider)
    }
    const when = rule.kind === 'appendOnly' ? always : oldCondition(rule.when, provider)
    const changed =
      rule.kind === 'appendOnly'
        ? always
        : rule.columns
            .map((column) => `NEW.${quote(column)} ${distinct} OLD.${quote(column)}`)
            .join(' OR ')
    switch (provider) {
      case 'sqlite':
        return [
          {
            kind: 'trigger',
            logicalId: `${logicalId}:update`,
            sql: `CREATE TRIGGER ${quote(name + '_update')} BEFORE UPDATE ON ${quote(table.id)} WHEN (${when}) AND (${changed}) BEGIN SELECT RAISE(ABORT, ${message}); END`,
          },
          ...(rule.kind === 'appendOnly'
            ? [
                {
                  kind: 'trigger' as const,
                  logicalId: `${logicalId}:delete`,
                  sql: `CREATE TRIGGER ${quote(name + '_delete')} BEFORE DELETE ON ${quote(table.id)} BEGIN SELECT RAISE(ABORT, ${message}); END`,
                },
              ]
            : []),
        ]
      case 'postgresql': {
        const fn = `${quote('agent_workflow')}.${quote(name + '_guard')}`
        return [
          {
            kind: 'function',
            logicalId: `${logicalId}:function`,
            sql: `CREATE FUNCTION ${fn}() RETURNS TRIGGER LANGUAGE plpgsql AS $rfc395$ BEGIN IF (${when}) THEN IF ${rule.kind === 'appendOnly' ? "TG_OP = 'DELETE' OR " : ''}(${changed}) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = ${message}; END IF; END IF; IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $rfc395$`,
          },
          {
            kind: 'trigger',
            logicalId,
            sql: `CREATE TRIGGER ${quote(name)} BEFORE UPDATE${rule.kind === 'appendOnly' ? ' OR DELETE' : ''} ON ${quote('agent_workflow')}.${quote(table.id)} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
          },
        ]
      }
      default:
        return unhandledDatabaseProvider(provider)
    }
  })
}

export class SchemaRowRuleError extends Error {
  constructor(
    readonly code: string,
    readonly tableId: string,
    cause: unknown,
  ) {
    super(code, { cause })
    this.name = 'SchemaRowRuleError'
  }
}
/** Native errors and Drizzle's cause wrapper share one declared domain error. */
export function compileSchemaRowRuleCodes(registry: SchemaRegistry): ReadonlyMap<string, string> {
  return new Map(
    registry.tables.flatMap((table) =>
      (table.rowRules ?? []).map((rule) => [rule.errorCode, table.id] as const),
    ),
  )
}
export function mapSchemaRowRuleError(
  declared: ReadonlyMap<string, string>,
  error: unknown,
): SchemaRowRuleError | undefined {
  if (error instanceof SchemaRowRuleError) return error
  let current: unknown = error
  const visited = new Set<unknown>()
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current)
    const table = declared.get(current.message)
    if (table) return new SchemaRowRuleError(current.message, table, error)
    current = current.cause
  }
  return undefined
}

/** Bound once by provider construction; module callers receive the domain error directly. */
export function createSchemaRowRuleErrorTranslator(declared: ReadonlyMap<string, string>) {
  const codes = new Map(declared)
  return (error: unknown): unknown => mapSchemaRowRuleError(codes, error) ?? error
}
const boundSessions = new WeakSet<object>()
export function bindSchemaRowRuleErrors(handle: object, codes: ReadonlyMap<string, string>): void {
  const session = (handle as { session?: object }).session
  if (!session || boundSessions.has(session)) return
  boundSessions.add(session)
  const translate = createSchemaRowRuleErrorTranslator(codes)
  const wrap = (target: object, method: string): void => {
    const object = target as Record<string, unknown>
    const original = object[method]
    if (typeof original !== 'function') return
    object[method] = function (this: object, ...args: unknown[]): unknown {
      try {
        const result: unknown = Reflect.apply(original, this, args)
        if (result && typeof result === 'object' && 'then' in result)
          return Promise.resolve(result).catch((error: unknown) => {
            throw translate(error)
          })
        return result
      } catch (error) {
        throw translate(error)
      }
    }
  }
  const native = session as Record<string, unknown>
  const prepare = native.prepareQuery
  if (typeof prepare === 'function')
    native.prepareQuery = function (this: object, ...args: unknown[]) {
      const query = Reflect.apply(prepare, this, args) as object
      for (const method of ['run', 'all', 'get', 'values', 'execute']) wrap(query, method)
      return query
    }
  for (const method of ['run', 'all', 'get', 'values', 'execute', 'exec']) wrap(session, method)
  const transaction = native.transaction
  if (typeof transaction === 'function')
    native.transaction = function (
      this: object,
      body: (tx: object) => unknown,
      ...args: unknown[]
    ) {
      return Reflect.apply(transaction, this, [
        (tx: object) => {
          bindSchemaRowRuleErrors(tx, codes)
          return body(tx)
        },
        ...args,
      ]) as unknown
    }
}
