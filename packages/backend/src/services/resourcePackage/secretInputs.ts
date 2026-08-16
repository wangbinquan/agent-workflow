// RFC-271 — import-time credential projection.
//
// The package manifest is an index, not authority to mutate arbitrary payload fields. This
// helper therefore intersects three things before changing a byte:
//
//   1. the field is declared by manifest.secrets;
//   2. the caller supplied at most one value for that exact declaration; and
//   3. the field resolves to one of the secret carriers emitted by serialize.ts.
//
// The transformation is deliberately pure. Callers can validate/preview/commit the returned
// bundle without ever placing the submitted values back into the parsed package object.

import {
  BundleSchema,
  encodePackageSecretFieldSegments,
  PACKAGE_SECRET_PLACEHOLDER,
  type ResourcePackageType,
  type PackageSecretFieldSegment,
  type PackageSecretRef,
  type ResourceBundle,
} from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

const RESOURCE_TYPES = new Set<ResourcePackageType>([
  'agent',
  'skill',
  'mcp',
  'plugin',
  'workflow',
  'workgroup',
])

const ENCODED_PLACEHOLDER_RE = /%3cREDACTED%3aSECRET%3e/i

export interface PackageSecretInput extends PackageSecretRef {
  /** Empty means "leave this credential unset". It is never written as the placeholder. */
  value: string
}

export interface AppliedPackageSecretInputs {
  bundle: ResourceBundle
  /** Manifest declarations which were omitted or explicitly submitted with an empty value. */
  skippedRefs: PackageSecretRef[]
}

export interface PackageSecretProjection {
  /** Secret identity from the signed package manifest / client request. */
  source: PackageSecretRef
  /** Identity in the decision-translated bundle (for example after a rename). */
  target: PackageSecretRef
}

type Container = Record<string, unknown> | unknown[]

interface SecretSlot {
  parent: Container
  key: string | number
  current: string
  /** URL/spec redaction may remove userinfo entirely, so these fields are replaced as a whole. */
  wholeField: boolean
}

/**
 * Apply credential values to a redacted resource bundle without mutating the source bundle.
 *
 * Missing inputs are treated exactly like explicit empty inputs: optional object leaves are
 * removed, argv elements are removed, and the declaration is returned in `skippedRefs`.
 * Required whole fields such as MCP `config.url` and plugin `spec` cannot be skipped while still
 * satisfying the bundle schema. Those cases fail closed with `package-secret-input-required`
 * rather than manufacturing a fake value or allowing `<REDACTED:SECRET>` to reach persistence.
 */
export function applyPackageSecretInputs(
  bundle: ResourceBundle,
  manifestSecrets: unknown,
  rawInputs: unknown,
  projections?: readonly PackageSecretProjection[],
): AppliedPackageSecretInputs {
  const declared = parseManifestSecrets(manifestSecrets)
  const inputs = parseInputs(rawInputs, declared)
  const active = normalizeProjections(declared, projections)
  const out = cloneBundle(bundle)
  const slotsByRef = indexSecretSlots(out)
  const skippedRefs: PackageSecretRef[] = []
  const arrayDeletes = new Map<unknown[], Set<number>>()
  const resolvedSlots = new Set<SecretSlot>()

  for (const projection of active) {
    const sourceKey = secretRefKey(projection.source)
    const slots = slotsByRef.get(secretRefKey(projection.target)) ?? []
    if (slots.length !== 1) {
      throw new ValidationError(
        'package-secret-manifest-invalid',
        slots.length === 0
          ? `manifest secret '${formatRef(projection.source)}' does not resolve to a redacted bundle field`
          : `manifest secret '${formatRef(projection.source)}' resolves to more than one bundle field`,
      )
    }

    const slot = slots[0]!
    if (resolvedSlots.has(slot)) {
      throw new ValidationError(
        'package-secret-manifest-invalid',
        `manifest secret '${formatRef(projection.source)}' aliases a bundle field already declared by another secret ref`,
      )
    }
    resolvedSlots.add(slot)
    const input = inputs.get(sourceKey)
    if (input === undefined || input.value === '') {
      skippedRefs.push(copyRef(projection.target))
      if (Array.isArray(slot.parent)) {
        const indexes = arrayDeletes.get(slot.parent) ?? new Set<number>()
        indexes.add(slot.key as number)
        arrayDeletes.set(slot.parent, indexes)
      } else {
        delete slot.parent[slot.key as string]
      }
      continue
    }

    if (containsReservedPlaceholder(input.value)) {
      throw new ValidationError(
        'package-secret-input-invalid',
        `credential value for '${formatRef(projection.source)}' contains the reserved package placeholder`,
      )
    }
    slot.parent[slot.key as never] = (
      slot.wholeField
        ? input.value
        : slot.current.split(PACKAGE_SECRET_PLACEHOLDER).join(input.value)
    ) as never
  }

  // Delay splices until every manifest pointer has been resolved against the original indexes.
  for (const [arr, indexes] of arrayDeletes) {
    for (const index of [...indexes].sort((a, b) => b - a)) arr.splice(index, 1)
  }

  const remaining = collectReservedPlaceholderPaths(out)
  if (remaining.length > 0) {
    throw new ValidationError(
      'package-secret-placeholder-remains',
      'the bundle still contains redacted credential placeholders not covered by manifest.secrets',
      { paths: remaining },
    )
  }

  const parsed = BundleSchema.safeParse(out)
  if (!parsed.success) {
    const code =
      skippedRefs.length > 0 ? 'package-secret-input-required' : 'package-secret-input-invalid'
    throw new ValidationError(
      code,
      skippedRefs.length > 0
        ? 'one or more skipped credential fields are required by the resource schema'
        : 'one or more credential values do not satisfy the resource schema',
      {
        skippedRefs,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      },
    )
  }

  return { bundle: out, skippedRefs }
}

function normalizeProjections(
  declared: readonly PackageSecretRef[],
  projections: readonly PackageSecretProjection[] | undefined,
): PackageSecretProjection[] {
  if (projections === undefined) {
    return declared.map((ref) => ({ source: copyRef(ref), target: copyRef(ref) }))
  }
  const declaredKeys = new Set(declared.map(secretRefKey))
  const seen = new Set<string>()
  return projections.map((projection, index) => {
    const source = parseRef(projection.source, `secretProjections[${index}].source`, false)
    const target = parseRef(projection.target, `secretProjections[${index}].target`, false)
    const sourceKey = secretRefKey(source)
    if (!declaredKeys.has(sourceKey)) {
      throw new ValidationError(
        'package-secret-manifest-invalid',
        `secret projection source '${formatRef(source)}' was not declared by manifest.secrets`,
      )
    }
    if (seen.has(sourceKey)) {
      throw new ValidationError(
        'package-secret-manifest-invalid',
        `secret projection source '${formatRef(source)}' appears more than once`,
      )
    }
    seen.add(sourceKey)
    return { source, target }
  })
}

function parseManifestSecrets(raw: unknown): PackageSecretRef[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError(
      'package-secret-manifest-invalid',
      'manifest.secrets must be an array',
    )
  }
  const out: PackageSecretRef[] = []
  const seen = new Set<string>()
  for (const [index, value] of raw.entries()) {
    const ref = parseRef(value, `manifest.secrets[${index}]`, false)
    const key = secretRefKey(ref)
    if (seen.has(key)) {
      throw new ValidationError(
        'package-secret-manifest-invalid',
        `manifest contains duplicate secret declaration '${formatRef(ref)}'`,
      )
    }
    seen.add(key)
    out.push(ref)
  }
  return out
}

function parseInputs(
  raw: unknown,
  declared: readonly PackageSecretRef[],
): Map<string, PackageSecretInput> {
  if (!Array.isArray(raw)) {
    throw new ValidationError('package-secret-input-invalid', 'secretInputs must be an array')
  }
  const declaredKeys = new Set(declared.map(secretRefKey))
  const out = new Map<string, PackageSecretInput>()
  for (const [index, value] of raw.entries()) {
    const input = parseRef(value, `secretInputs[${index}]`, true) as PackageSecretInput
    const key = secretRefKey(input)
    if (!declaredKeys.has(key)) {
      throw new ValidationError(
        'package-secret-input-unconfirmed',
        `credential input '${formatRef(input)}' was not declared by manifest.secrets`,
      )
    }
    if (out.has(key)) {
      throw new ValidationError(
        'package-secret-input-invalid',
        `credential input '${formatRef(input)}' was submitted more than once`,
      )
    }
    out.set(key, input)
  }
  return out
}

function parseRef(value: unknown, label: string, withValue: boolean): PackageSecretRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(
      withValue ? 'package-secret-input-invalid' : 'package-secret-manifest-invalid',
      `${label} must be an object`,
    )
  }
  const record = value as Record<string, unknown>
  const expectedKeys = withValue
    ? ['field', 'resourceName', 'resourceType', 'value']
    : ['field', 'resourceName', 'resourceType']
  const actualKeys = Object.keys(record).sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ValidationError(
      withValue ? 'package-secret-input-invalid' : 'package-secret-manifest-invalid',
      `${label} must contain exactly ${expectedKeys.join(', ')}`,
    )
  }
  if (
    typeof record.resourceType !== 'string' ||
    !RESOURCE_TYPES.has(record.resourceType as ResourcePackageType) ||
    typeof record.resourceName !== 'string' ||
    record.resourceName.length === 0 ||
    typeof record.field !== 'string' ||
    record.field.length === 0 ||
    (withValue && typeof record.value !== 'string')
  ) {
    throw new ValidationError(
      withValue ? 'package-secret-input-invalid' : 'package-secret-manifest-invalid',
      `${label} has an invalid resourceType, resourceName, field, or value`,
    )
  }
  return {
    resourceType: record.resourceType,
    resourceName: record.resourceName,
    field: record.field,
    ...(withValue ? { value: record.value } : {}),
  } as PackageSecretRef
}

function indexSecretSlots(bundle: ResourceBundle): Map<string, SecretSlot[]> {
  const out = new Map<string, SecretSlot[]>()
  const resourceCounts = new Map<string, number>()

  for (const op of bundle.ops) {
    const resourceType = resourceTypeOfKind(op.kind)
    const payload = op.payload as Record<string, unknown>
    const resourceName = typeof payload.name === 'string' ? payload.name : ''
    const resourceKey = JSON.stringify([resourceType, resourceName])
    resourceCounts.set(resourceKey, (resourceCounts.get(resourceKey) ?? 0) + 1)

    const add = (field: string, slot: SecretSlot): void => {
      const key = secretRefKey({ resourceType, resourceName, field })
      const current = out.get(key) ?? []
      current.push(slot)
      out.set(key, current)
    }
    const collect = (value: unknown, path: string): void => {
      collectPlaceholderSlots(value, [path], (segments, slot) => {
        // New packages use typed segments. The legacy alias keeps already-exported packages
        // importable; if two real slots collapse to one legacy path, that alias has two entries
        // and the normal `slots.length !== 1` gate rejects it instead of guessing.
        add(encodePackageSecretFieldSegments(segments), slot)
        add(encodeLegacySecretField(segments), slot)
      })
    }

    switch (resourceType) {
      case 'agent':
      case 'skill':
        collect(payload.frontmatterExtra, 'frontmatterExtra')
        break
      case 'mcp': {
        const config = asRecord(payload.config)
        collect(config.env, 'config.env')
        collect(config.headers, 'config.headers')
        const oauth = asRecord(config.oauth)
        if (
          typeof oauth.clientSecret === 'string' &&
          oauth.clientSecret.includes(PACKAGE_SECRET_PLACEHOLDER)
        ) {
          add('config.oauth.clientSecret', {
            parent: oauth,
            key: 'clientSecret',
            current: oauth.clientSecret,
            wholeField: false,
          })
        }
        collectCommandSlots(config.command, add)
        if (typeof config.url === 'string') {
          add('config.url', {
            parent: config,
            key: 'url',
            current: config.url,
            wholeField: true,
          })
        }
        break
      }
      case 'plugin':
        collect(payload.options, 'options')
        if (typeof payload.spec === 'string') {
          add('spec', {
            parent: payload,
            key: 'spec',
            current: payload.spec,
            wholeField: true,
          })
        }
        break
      case 'workflow': {
        const definition = asRecord(payload.definition)
        const nodes = Array.isArray(definition.nodes) ? definition.nodes : []
        for (const rawNode of nodes) {
          const node = asRecord(rawNode)
          if (
            node.kind !== 'script' ||
            typeof node.id !== 'string' ||
            typeof node.env !== 'object' ||
            node.env === null
          ) {
            continue
          }
          collect(node.env, `nodes.${node.id}.env`)
        }
        break
      }
      case 'workgroup':
        break
    }
  }

  // Same-type/same-name resources make manifest refs ambiguous even when only one currently
  // contains a placeholder. Export rejects these; an imported hand-built package must not bypass
  // that invariant.
  for (const [resourceKey, count] of resourceCounts) {
    if (count < 2) continue
    const [resourceType, resourceName] = JSON.parse(resourceKey) as [string, string]
    for (const [key, slots] of out) {
      const [type, name] = JSON.parse(key) as [string, string, string]
      if (type === resourceType && name === resourceName && slots.length === 1)
        slots.push(slots[0]!)
    }
  }
  return out
}

function collectCommandSlots(value: unknown, add: (field: string, slot: SecretSlot) => void): void {
  if (!Array.isArray(value)) return
  // serialize.ts intentionally leaves argv[0] (the executable) untouched.
  for (let index = 1; index < value.length; index += 1) {
    const item = value[index]
    if (typeof item !== 'string' || !item.includes(PACKAGE_SECRET_PLACEHOLDER)) continue
    add(`config.command[${index}]`, {
      parent: value,
      key: index,
      current: item,
      wholeField: false,
    })
  }
}

function collectPlaceholderSlots(
  value: unknown,
  segments: readonly PackageSecretFieldSegment[],
  add: (segments: readonly PackageSecretFieldSegment[], slot: SecretSlot) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const itemSegments = [...segments, index]
      if (typeof item === 'string' && item.includes(PACKAGE_SECRET_PLACEHOLDER)) {
        add(itemSegments, {
          parent: value,
          key: index,
          current: item,
          wholeField: false,
        })
      } else {
        collectPlaceholderSlots(item, itemSegments, add)
      }
    })
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childSegments = [...segments, key]
    if (typeof child === 'string' && child.includes(PACKAGE_SECRET_PLACEHOLDER)) {
      add(childSegments, {
        parent: value as Record<string, unknown>,
        key,
        current: child,
        wholeField: false,
      })
    } else {
      collectPlaceholderSlots(child, childSegments, add)
    }
  }
}

function encodeLegacySecretField(segments: readonly PackageSecretFieldSegment[]): string {
  let out = ''
  for (const segment of segments) {
    if (typeof segment === 'number') {
      out += `[${segment}]`
    } else {
      out = out.length === 0 ? segment : `${out}.${segment}`
    }
  }
  return out
}

function collectReservedPlaceholderPaths(value: unknown, path = 'bundle'): string[] {
  if (typeof value === 'string') return containsReservedPlaceholder(value) ? [path] : []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectReservedPlaceholderPaths(item, `${path}[${index}]`),
    )
  }
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectReservedPlaceholderPaths(child, `${path}.${key}`),
  )
}

function containsReservedPlaceholder(value: string): boolean {
  return value.includes(PACKAGE_SECRET_PLACEHOLDER) || ENCODED_PLACEHOLDER_RE.test(value)
}

function resourceTypeOfKind(kind: string): ResourcePackageType {
  const type = kind.slice(0, kind.lastIndexOf('-'))
  if (!RESOURCE_TYPES.has(type as ResourcePackageType)) {
    throw new ValidationError('package-secret-manifest-invalid', `unsupported bundle op '${kind}'`)
  }
  return type as ResourcePackageType
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function cloneBundle(bundle: ResourceBundle): ResourceBundle {
  return structuredClone(bundle)
}

function secretRefKey(ref: PackageSecretRef): string {
  return JSON.stringify([ref.resourceType, ref.resourceName, ref.field])
}

function formatRef(ref: PackageSecretRef): string {
  return `${ref.resourceType}/${ref.resourceName}:${ref.field}`
}

function copyRef(ref: PackageSecretRef): PackageSecretRef {
  return {
    resourceType: ref.resourceType,
    resourceName: ref.resourceName,
    field: ref.field,
  }
}
