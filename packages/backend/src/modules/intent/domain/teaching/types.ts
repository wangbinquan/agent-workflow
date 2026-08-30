// RFC-348 — type machinery of the intent capability-teaching registries.
//
// The registries below (`nodeKinds.ts`, `resourceTypes.ts`, `workflowParts.ts`,
// `platformMap.ts`) are the SINGLE SOURCE the model-facing INTENT.md is rendered
// from. Their `satisfies` targets are mapped types DERIVED FROM THE ZOD
// SCHEMAS, so that
//   - a new NodeKind / IntentResourceType / AclResourceType fails to compile
//     until it declares its teaching entry;
//   - a field added to a strict schema (top level, nested object, array element
//     or discriminated-union variant) fails to compile until it is taught;
//   - an object-valued field cannot be registered "parent only" — it must carry
//     a schema-keyed `nested` table.
// Every definition here is the verbatim text compiled by the RFC-348 type probe
// (design/RFC-348-intent-capability-teaching-registry/type-probe.md): tsc 5.9 +
// zod 3.25, zero diagnostics, eight `@ts-expect-error` negatives, five
// mutations (see tests/intent-teaching-exhaustive.test.ts). Two TypeScript
// facts shape it: `keyof (A | B)` is the INTERSECTION of keys, so `KeysOf`
// distributes on a naked parameter; and `keyof never` is `string | number |
// symbol`, so only `ZodObject` may contribute keys.
//
// Pure module: zod types + shared schemas only — no DB, fs, actor or runtime.

/* eslint-disable @typescript-eslint/no-explicit-any -- `any` only ever appears as the
   "don't care" slot of zod's generic parameters inside `extends` / `infer` matching
   (`ZodObject<infer Shape, any, any>`, `ZodEffects<infer I, any, any>`); a narrower
   constraint there changes which schemas match, which the RFC-348 type probe verified
   against. Nothing is typed `any` for callers. */

import type { z } from 'zod'
import type {
  CallWorkflowNodeSchema,
  CallWorkgroupNodeSchema,
  ClarifyCrossAgentNodeSchema,
  ClarifyNodeSchema,
  CodeHostCallNodeSchema,
  IntentAgentPayloadSchema,
  IntentMcpPayloadSchema,
  IntentPluginPayloadSchema,
  IntentResourceType,
  IntentSkillPayloadSchema,
  IntentWorkflowPayloadSchema,
  IntentWorkgroupPayloadSchema,
  NodeKind,
  ReviewNodeSchema,
  ScriptNodeSchema,
  WrapperFanoutNodeSchema,
} from '@agent-workflow/shared'

// ───────────────────────── zod shape extraction ─────────────────────────

type Unwrap<S> =
  S extends z.ZodEffects<infer I, any, any>
    ? Unwrap<I>
    : S extends z.ZodOptional<infer T>
      ? Unwrap<T>
      : S extends z.ZodDefault<infer T>
        ? Unwrap<T>
        : S extends z.ZodNullable<infer T>
          ? Unwrap<T>
          : S
type ShapeOf<S> = Unwrap<S> extends z.ZodObject<infer Shape, any, any> ? Shape : never
type OptionsOf<S> =
  Unwrap<S> extends z.ZodDiscriminatedUnion<any, infer O>
    ? O[number]
    : Unwrap<S> extends z.ZodUnion<infer O>
      ? O[number]
      : never
/** Distributive over S (naked parameter): unions yield the UNION of keys, never the intersection. */
export type KeysOf<S> = S extends unknown ? KeysOfInner<Unwrap<S>> : never
type KeysOfInner<U> =
  U extends z.ZodDiscriminatedUnion<any, infer O>
    ? KeysOf<O[number]>
    : U extends z.ZodUnion<infer O>
      ? KeysOf<O[number]>
      : U extends z.ZodArray<infer E, any>
        ? KeysOf<E>
        : U extends z.ZodObject<infer Shape, any, any>
          ? keyof Shape & string
          : never // primitives / records / literals contribute no keys
type DiscriminatorOf<S> = Unwrap<S> extends z.ZodDiscriminatedUnion<infer D, any> ? D : never
export type VariantValues<S> =
  OptionsOf<S> extends infer O
    ? O extends z.ZodTypeAny
      ? z.infer<O>[DiscriminatorOf<S> & keyof z.infer<O>] & string
      : never
    : never
type OptionFor<S, V extends string> =
  OptionsOf<S> extends infer O
    ? O extends z.ZodTypeAny
      ? z.infer<O> extends Record<DiscriminatorOf<S>, V>
        ? O
        : never
      : never
    : never
type FieldSchemaAt<S, K extends string> =
  ShapeOf<S> extends infer Shape ? (K extends keyof Shape ? Shape[K] : never) : never
type ElementOf<F> = Unwrap<F> extends z.ZodArray<infer E, any> ? Unwrap<E> : Unwrap<F>
type IsObjectLike<F> = [KeysOf<F>] extends [never] ? false : true
type ObjectOptionsOf<U> =
  U extends z.ZodUnion<infer O> ? Extract<O[number], z.ZodObject<any, any, any>> : never

// ───────────────────────── teaching entry types ─────────────────────────

/** Per-variant sub-table of a discriminated union: `variants` is keyed by the
 *  discriminator's literal values, so a new variant fails to compile until it
 *  is taught; each variant's field table derives from its own option schema. */
export interface IntentVariantTeaching<S> {
  readonly discriminator: DiscriminatorOf<S>
  readonly variants: { readonly [V in VariantValues<S>]: TeachingFieldsOf<OptionFor<S, V>> }
}
type NestedFor<F> =
  ElementOf<F> extends z.ZodDiscriminatedUnion<any, any>
    ? IntentVariantTeaching<ElementOf<F>>
    : ElementOf<F> extends z.ZodUnion<any>
      ? TeachingFieldsOf<ObjectOptionsOf<ElementOf<F>>> // plain union: only object options get a table (agent skills)
      : TeachingFieldsOf<ElementOf<F>>
/** A scalar field: `form` is the fragment spelled inside the form literal (WITHOUT
 *  the outer `?`, the renderer inserts it from `required`); `note` renders after
 *  the form line; `mistake` is a field-adjacent counter-example. */
export type ScalarTeaching = {
  readonly form: string
  readonly required: boolean
  readonly note?: string
  readonly mistake?: string
  readonly nested?: never
}
export type ObjectTeaching<F> = {
  readonly form: string
  readonly required: boolean
  readonly note?: string
  readonly mistake?: string
  readonly nested: NestedFor<F>
}
/** A schema field the model must not author (reserved slot, canonical id). */
export type Omitted = { readonly omit: true; readonly why: string }
/** Object / object-array / variant fields REQUIRE a schema-keyed `nested`; scalars forbid it. */
export type FieldTeachingFor<F> =
  | Omitted
  | (IsObjectLike<F> extends true ? ObjectTeaching<F> : ScalarTeaching)
/** Field table derived from a schema's shape: keys = `KeysOf<S>`, values keyed by each field's zod type. */
export type TeachingFieldsOf<S> = {
  readonly [K in KeysOf<S>]: FieldTeachingFor<FieldSchemaAt<S, K>>
}
/** Resource root: a discriminated-union root (mcp) is taught per variant. */
export type ResourceFieldsOf<S> =
  Unwrap<S> extends z.ZodDiscriminatedUnion<any, any>
    ? IntentVariantTeaching<S>
    : TeachingFieldsOf<S>

// ───────────────────────── availability & sources ─────────────────────────

export type IntentNodeAvailability =
  | { readonly kind: 'public' }
  | {
      readonly kind: 'privileged'
      readonly permission: 'scripts:author' | 'code-host-calls:author'
      /** The exact shared constant (SCRIPT_REDACTED_FIELDS / CODE_HOST_REDACTED_FIELDS), never a copy. */
      readonly redactedFields: readonly string[]
      /** Overview label ("script (inline code, no model)") shown only when the actor holds the permission. */
      readonly overviewLabel: string
      /** Nested-redaction example printed in the Capability-limits section when withheld. */
      readonly nestedRedactionHint: string
      /** Fields the model may see but must not edit when withheld. */
      readonly untouchableFields: string
    }
  | { readonly kind: 'synthesized-only' }
/** Authorable kinds can never be synthesized-only. */
export type AuthorableAvailability = Exclude<IntentNodeAvailability, { kind: 'synthesized-only' }>

/** Where a passthrough field is actually read (a real read point) or that it
 *  exists only for the intent resolve seam (handles → canonical ids). */
export type IntentPassthroughFieldSource =
  | { readonly readPoint: { readonly file: string; readonly identifier: string } }
  | {
      readonly intentOnly: {
        readonly resolvedIn: 'packages/backend/src/services/intent/resolveChangeset.ts'
      }
    }

// ───────────────────────── node registry target ─────────────────────────

export type StrictNodeSchemaOf = {
  review: typeof ReviewNodeSchema
  clarify: typeof ClarifyNodeSchema
  'clarify-cross-agent': typeof ClarifyCrossAgentNodeSchema
  'wrapper-fanout': typeof WrapperFanoutNodeSchema
  'call-workflow': typeof CallWorkflowNodeSchema
  'call-workgroup': typeof CallWorkgroupNodeSchema
  script: typeof ScriptNodeSchema
  'code-host-call': typeof CodeHostCallNodeSchema
}
/** Keys every node carries; taught once in the common node sentence, not per kind. */
export type NodeBaseKey = 'id' | 'kind' | 'position' | 'title' | 'agentId'
/** Intent-only reference fields (session handles rehydrated at the resolve seam). */
export type IntentOnlyNodeFields<K> = K extends 'call-workflow'
  ? { readonly workflowRef: ScalarTeaching }
  : K extends 'call-workgroup'
    ? { readonly workgroupRef: ScalarTeaching }
    : Record<never, never>
/** `Omit` acts on the DERIVED field table (never on the schema instance). */
export type StrictNodeFields<K extends keyof StrictNodeSchemaOf> = Omit<
  TeachingFieldsOf<StrictNodeSchemaOf[K]>,
  NodeBaseKey
> &
  IntentOnlyNodeFields<K>
/** The five passthrough kinds have no dedicated zod schema; their authorable
 *  field roster is declared HERE and locked to real read points by
 *  `fieldSources` + tests/intent-teaching-registry.test.ts. */
export type PassthroughKeysOf<K> = K extends 'wrapper-loop'
  ? 'nodeIds' | 'maxIterations' | 'exitCondition' | 'outputBindings' | 'continueOnMaxIterations'
  : K extends 'agent-single'
    ? 'agentRef' | 'promptTemplate'
    : K extends 'input'
      ? 'inputKey'
      : K extends 'output'
        ? 'ports'
        : K extends 'wrapper-git'
          ? 'nodeIds'
          : never
/** Strict kinds must NOT carry `fieldSources`; passthrough kinds must cover every declared field. */
export type AuthorableNodeTeaching<Fields, Sources = undefined> = {
  readonly availability: AuthorableAvailability
  readonly fields: Fields
  /** Explanatory sentences rendered after the form line (contract-locked phrases live here verbatim). */
  readonly notes: readonly string[]
  /** Cross-field counter-examples collected into the Common-mistakes section. */
  readonly mistakes: readonly string[]
} & (Sources extends undefined
  ? { readonly fieldSources?: never }
  : { readonly fieldSources: Sources })
/** synthesized-only kinds have NO `fields` property (`Record<never, never>` would be `{}`). */
export type SynthesizedNodeTeaching = {
  readonly availability: { readonly kind: 'synthesized-only' }
  readonly notes: readonly string[]
  readonly mistakes: readonly string[]
  readonly fields?: never
}
export type NodeTeachingOf<K extends NodeKind> = K extends 'code-round'
  ? SynthesizedNodeTeaching
  : K extends keyof StrictNodeSchemaOf
    ? AuthorableNodeTeaching<StrictNodeFields<K>>
    : AuthorableNodeTeaching<
        { readonly [P in PassthroughKeysOf<K>]: ScalarTeaching },
        { readonly [P in PassthroughKeysOf<K>]: IntentPassthroughFieldSource }
      >
export type IntentNodeTeachingRegistry = { readonly [K in NodeKind]: NodeTeachingOf<K> }

// ───────────────────────── resource registry target ─────────────────────────

export type IntentPayloadSchemaOf = {
  agent: typeof IntentAgentPayloadSchema
  skill: typeof IntentSkillPayloadSchema
  mcp: typeof IntentMcpPayloadSchema
  plugin: typeof IntentPluginPayloadSchema
  workflow: typeof IntentWorkflowPayloadSchema
  workgroup: typeof IntentWorkgroupPayloadSchema
}
export interface IntentResourceTeaching<Fields> {
  readonly fields: Fields
  readonly notes: readonly string[]
  readonly mistakes: readonly string[]
}
export type IntentResourceTeachingRegistry = {
  readonly [K in IntentResourceType]: IntentResourceTeaching<
    ResourceFieldsOf<IntentPayloadSchemaOf[K]>
  >
}
