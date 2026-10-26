import type { SchemaExpression } from '../../schema/expressions'
import type { TargetRow, TargetValue } from './types'
import { ConversionContractError } from './blockCodes'

export type SqlTruth = boolean | null
export function sqlTruth(value: TargetValue): SqlTruth {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' || typeof value === 'bigint') return value !== 0 && value !== 0n
  throw new ConversionContractError('v2-expression-type', 'expected a SQL predicate')
}
export function isTypedExpression(expression: SchemaExpression): boolean {
  switch (expression.kind) {
    case 'raw':
      return false
    case 'binary':
      return isTypedExpression(expression.left) && isTypedExpression(expression.right)
    case 'unary':
      return isTypedExpression(expression.value)
    case 'call':
      return expression.args.every(isTypedExpression)
    case 'in':
      return isTypedExpression(expression.value) && expression.values.every(isTypedExpression)
    default:
      return true
  }
}
function compare(left: TargetValue, right: TargetValue): number {
  if (left instanceof Uint8Array && right instanceof Uint8Array) return Buffer.compare(left, right)
  if (typeof left === 'string' && typeof right === 'string')
    return Buffer.compare(Buffer.from(left), Buffer.from(right))
  const a = typeof left === 'boolean' ? Number(left) : left
  const b = typeof right === 'boolean' ? Number(right) : right
  if (
    (typeof a === 'number' || typeof a === 'bigint') &&
    (typeof b === 'number' || typeof b === 'bigint')
  )
    return a < b ? -1 : a > b ? 1 : 0
  throw new ConversionContractError('v2-expression-type', 'incomparable SQL operands')
}
export function evaluateExpression(expression: SchemaExpression, row: TargetRow): TargetValue {
  const evaluate = (child: SchemaExpression): TargetValue => evaluateExpression(child, row)
  switch (expression.kind) {
    case 'raw':
      throw new ConversionContractError('v2-deferred-expression', expression.reason)
    case 'column': {
      const value = row[expression.name]
      if (value === undefined)
        throw new ConversionContractError('v2-expression-column', expression.name)
      return value
    }
    case 'literal':
      return expression.value
    case 'unary': {
      const value = evaluate(expression.value)
      if (expression.op === 'IS NULL') return value === null
      if (expression.op === 'IS NOT NULL') return value !== null
      if (expression.op === 'DESC') return value
      const truth = sqlTruth(value)
      return truth === null ? null : !truth
    }
    case 'binary': {
      const left = evaluate(expression.left)
      const right = evaluate(expression.right)
      if (expression.op === 'AND' || expression.op === 'OR') {
        const a = sqlTruth(left)
        const b = sqlTruth(right)
        if (expression.op === 'AND')
          return a === false || b === false ? false : a === null || b === null ? null : true
        return a === true || b === true ? true : a === null || b === null ? null : false
      }
      if (left === null || right === null) return null
      const order = compare(left, right)
      switch (expression.op) {
        case '=':
          return order === 0
        case '<>':
          return order !== 0
        case '<':
          return order < 0
        case '<=':
          return order <= 0
        case '>':
          return order > 0
        case '>=':
          return order >= 0
      }
      break
    }
    case 'in': {
      const value = evaluate(expression.value)
      const values = expression.values.map(evaluate)
      if (!values.length) return false
      if (value === null) return null
      if (values.some((other) => other !== null && compare(value, other) === 0)) return true
      return values.includes(null) ? null : false
    }
    case 'call': {
      const args = expression.args.map(evaluate)
      if (expression.name === 'coalesce') return args.find((value) => value !== null) ?? null
      const value = args[0] ?? null
      if (expression.name === 'jsonValid') {
        if (value === null) return null
        if (typeof value !== 'string') return false
        try {
          JSON.parse(value)
          return true
        } catch {
          return false
        }
      }
      if (value === null) return null
      if (expression.name === 'length')
        return value instanceof Uint8Array ? value.byteLength : Array.from(String(value)).length
      // Both native registries use ASCII case folding for identity indexes.
      return String(value).replace(/[A-Z]/g, (character) => character.toLowerCase())
    }
  }
  throw new ConversionContractError('v2-expression-type', 'unknown expression')
}
