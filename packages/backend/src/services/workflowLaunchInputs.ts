import type { WorkflowInput } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

export type WorkflowLaunchInputIssueCode =
  | 'unknown-input'
  | 'required-input-missing'
  | 'input-too-long'
  | 'input-count-too-small'
  | 'input-count-too-large'
  | 'enum-value-invalid'
  | 'git-value-invalid'

export interface WorkflowLaunchInputIssue {
  key: string
  code: WorkflowLaunchInputIssueCode
  message: string
}

export interface WorkflowLaunchInputValidationOptions {
  /**
   * Multipart preflight validates upload parts through validateUploadPlan
   * before paths have been packed into the launch input map. Its early call
   * skips upload keys; startTask runs the full check again after packing.
   */
  ignoreUploadInputs?: boolean
}

function ownValue(inputs: Readonly<Record<string, string>>, key: string): string {
  return Object.prototype.hasOwnProperty.call(inputs, key) ? (inputs[key] ?? '') : ''
}

function packedLines(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function numberField(def: WorkflowInput, field: string): number | undefined {
  const value = (def as Record<string, unknown>)[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringField(def: WorkflowInput, field: string): string | undefined {
  const value = (def as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

function addCountIssues(
  issues: WorkflowLaunchInputIssue[],
  def: WorkflowInput,
  count: number,
): void {
  const minCount = numberField(def, 'minCount')
  const maxCount = numberField(def, 'maxCount')
  const minimum = Math.max(def.required === true ? 1 : 0, minCount ?? 0)
  if (count < minimum) {
    issues.push({
      key: def.key,
      code:
        count === 0 && def.required === true ? 'required-input-missing' : 'input-count-too-small',
      message:
        count === 0 && def.required === true
          ? `input '${def.key}' is required`
          : `input '${def.key}' requires at least ${minimum} item(s)`,
    })
  }
  if (maxCount !== undefined && count > maxCount) {
    issues.push({
      key: def.key,
      code: 'input-count-too-large',
      message: `input '${def.key}' allows at most ${maxCount} item(s)`,
    })
  }
}

function enumMembers(
  def: WorkflowInput,
  raw: string,
): { ok: true; members: string[] } | { ok: false } {
  const multi = (def as Record<string, unknown>).multiSelect === true
  if (!multi) return { ok: true, members: raw.trim().length === 0 ? [] : [raw] }
  if (raw.trim().length === 0) return { ok: true, members: [] }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      return { ok: false }
    }
    return { ok: true, members: parsed as string[] }
  } catch {
    return { ok: false }
  }
}

function validGitValue(def: WorkflowInput, raw: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const value = parsed as Record<string, unknown>
  const expectedKind = stringField(def, 'gitKind') ?? 'branch'
  if (value.kind !== expectedKind) return false
  const nonEmpty = (field: string): boolean =>
    typeof value[field] === 'string' && value[field].trim().length > 0
  if (expectedKind === 'branch') return nonEmpty('ref')
  if (expectedKind === 'commit-range') return nonEmpty('from') && nonEmpty('to')
  if (expectedKind === 'pr') return nonEmpty('number')
  return false
}

/**
 * Validate the packed launch map against the workflow's authored input form.
 *
 * The browser performs the same user-facing gating, but workflow launches
 * also arrive through direct API calls and scheduled-task replay. This
 * service-level oracle prevents missing required values from silently
 * becoming `''` at the input node and rejects packed values that the matching
 * picker cannot represent.
 */
export function workflowLaunchInputIssues(
  defs: readonly WorkflowInput[],
  inputs: Readonly<Record<string, string>>,
  options: WorkflowLaunchInputValidationOptions = {},
): WorkflowLaunchInputIssue[] {
  const issues: WorkflowLaunchInputIssue[] = []
  const declared = new Set(defs.map((def) => def.key))

  for (const key of Object.keys(inputs)) {
    if (!declared.has(key)) {
      issues.push({
        key,
        code: 'unknown-input',
        message: `input '${key}' is not declared by this workflow`,
      })
    }
  }

  for (const def of defs) {
    if (def.kind === 'upload' && options.ignoreUploadInputs === true) continue
    const raw = ownValue(inputs, def.key)

    if (def.kind === 'files' || def.kind === 'upload') {
      addCountIssues(issues, def, packedLines(raw).length)
      continue
    }

    if (def.kind === 'enum') {
      const parsed = enumMembers(def, raw)
      if (!parsed.ok) {
        issues.push({
          key: def.key,
          code: 'enum-value-invalid',
          message: `input '${def.key}' must use the enum picker's packed format`,
        })
        continue
      }
      if (def.required === true && parsed.members.length === 0) {
        issues.push({
          key: def.key,
          code: 'required-input-missing',
          message: `input '${def.key}' is required`,
        })
      }
      const choicesRaw = (def as Record<string, unknown>).choices
      const choices = Array.isArray(choicesRaw)
        ? choicesRaw.filter((choice): choice is string => typeof choice === 'string')
        : []
      const allowOther = (def as Record<string, unknown>).allowOther === true
      if (!allowOther && parsed.members.some((member) => !choices.includes(member))) {
        issues.push({
          key: def.key,
          code: 'enum-value-invalid',
          message: `input '${def.key}' contains a value outside its declared choices`,
        })
      }
      continue
    }

    if (def.kind === 'git') {
      if (raw.trim().length === 0) {
        if (def.required === true) {
          issues.push({
            key: def.key,
            code: 'required-input-missing',
            message: `input '${def.key}' is required`,
          })
        }
      } else if (!validGitValue(def, raw)) {
        issues.push({
          key: def.key,
          code: 'git-value-invalid',
          message: `input '${def.key}' does not match its declared gitKind`,
        })
      }
      continue
    }

    if (def.required === true && raw.trim().length === 0) {
      issues.push({
        key: def.key,
        code: 'required-input-missing',
        message: `input '${def.key}' is required`,
      })
    }
    const maxLength = numberField(def, 'maxLength')
    if (maxLength !== undefined && raw.length > maxLength) {
      issues.push({
        key: def.key,
        code: 'input-too-long',
        message: `input '${def.key}' exceeds maxLength ${maxLength}`,
      })
    }
  }

  return issues
}

export function assertWorkflowLaunchInputs(
  defs: readonly WorkflowInput[],
  inputs: Readonly<Record<string, string>>,
  options: WorkflowLaunchInputValidationOptions = {},
): void {
  const issues = workflowLaunchInputIssues(defs, inputs, options)
  if (issues.length === 0) return
  throw new ValidationError(
    'workflow-inputs-invalid',
    `workflow launch inputs failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
    { issues },
  )
}
