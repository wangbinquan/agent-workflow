// RFC-395 I-a: provider expressions are explicit, including epoch-1 spelling.
import type { DatabaseProvider } from '../databaseProviders'
import { databaseProviderTraits } from '../providerTraits'

export type SchemaExpression =
  | { readonly kind: 'column'; readonly name: string }
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | {
      readonly kind: 'call'
      readonly name: 'length' | 'lower' | 'coalesce' | 'jsonValid'
      readonly args: readonly SchemaExpression[]
    }
  | {
      readonly kind: 'binary'
      readonly op: '=' | '<>' | '>' | '>=' | '<' | '<=' | 'AND' | 'OR'
      readonly left: SchemaExpression
      readonly right: SchemaExpression
    }
  | {
      readonly kind: 'unary'
      readonly op: 'NOT' | 'IS NULL' | 'IS NOT NULL' | 'DESC'
      readonly value: SchemaExpression
    }
  | {
      readonly kind: 'in'
      readonly value: SchemaExpression
      readonly values: readonly SchemaExpression[]
    }
  | {
      readonly kind: 'raw'
      readonly reason: string
      readonly sqlite: string
      readonly postgresql: string
    }

export function quoteSchemaIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
export function renderSchemaExpression(
  expression: SchemaExpression,
  provider: DatabaseProvider,
): string {
  const render = (value: SchemaExpression): string => renderSchemaExpression(value, provider)
  switch (expression.kind) {
    case 'column':
      return quoteSchemaIdentifier(expression.name)
    case 'literal': {
      const value = expression.value
      if (value === null) return 'NULL'
      if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
      if (typeof value === 'boolean') return databaseProviderTraits(provider).booleanLiteral(value)
      return String(value)
    }
    case 'call':
      return `${expression.name === 'jsonValid' ? 'json_valid' : expression.name}(${expression.args.map(render).join(', ')})`
    case 'binary':
      return `(${render(expression.left)} ${expression.op} ${render(expression.right)})`
    case 'unary':
      return expression.op === 'NOT'
        ? `NOT (${render(expression.value)})`
        : `${render(expression.value)} ${expression.op}`
    case 'in':
      return `${render(expression.value)} IN (${expression.values.map(render).join(', ')})`
    case 'raw':
      if (!expression.reason.trim() || !expression.sqlite.trim() || !expression.postgresql.trim())
        throw new Error('RFC-395 raw expression requires a reason and both providers')
      return expression[provider]
  }
}
