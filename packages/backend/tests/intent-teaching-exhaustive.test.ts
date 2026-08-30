// RFC-348 AC-7 — COMPILE-TIME exhaustiveness of the intent teaching registries.
//
// This file is an ordinary test so `tsc --noEmit` type-checks it with the rest
// of the package (precedent: rfc148-adt-contracts.test.ts). Each fixture below
// is a registry literal with ONE thing missing or one schema with ONE thing
// added; `// @ts-expect-error` makes the build RED if the type machinery ever
// stops rejecting it (TS2578 "unused @ts-expect-error"). Removing a directive
// shows the underlying diagnostic (TS2741 missing property etc.) — that is how
// design/RFC-348 §T7 collects the red-screen evidence.
//
// Every fixture is a DECLARATION (`const _x = … satisfies …`) referenced from
// the single test: `@typescript-eslint/no-unused-expressions` rejects a bare
// `satisfies` statement, and the `_` prefix satisfies `varsIgnorePattern`.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  IntentMcpPayloadSchema,
  IntentWorkgroupMemberSchema,
  ReviewNodeSchema,
  ScriptOutputPortSchema,
  type AclResourceType,
  type IntentResourceType,
  type NodeKind,
} from '@agent-workflow/shared'
import { INTENT_NODE_TEACHING } from '../src/modules/intent/domain/teaching/nodeKinds'
import {
  INTENT_PLATFORM_RESOURCE_MAP,
  type IntentPlatformResourceTeaching,
} from '../src/modules/intent/domain/teaching/platformMap'
import { INTENT_RESOURCE_TEACHING } from '../src/modules/intent/domain/teaching/resourceTypes'
import type {
  IntentPayloadSchemaOf,
  IntentResourceTeaching,
  IntentVariantTeaching,
  NodeBaseKey,
  NodeTeachingOf,
  ResourceFieldsOf,
  StrictNodeFields,
  TeachingFieldsOf,
} from '../src/modules/intent/domain/teaching/types'

// ---------------------------------------------------------------------------
// 1–3: a roster grew, the registry did not
// ---------------------------------------------------------------------------
const { review: _dropReview, ...nodeWithoutReview } = INTENT_NODE_TEACHING
// @ts-expect-error — 1. a NodeKind without a teaching entry does not compile
const _missingKind = nodeWithoutReview satisfies { readonly [K in NodeKind]: NodeTeachingOf<K> }

const { skill: _dropSkill, ...resourcesWithoutSkill } = INTENT_RESOURCE_TEACHING
// @ts-expect-error — 2. an IntentResourceType without a teaching entry does not compile
const _missingResource = resourcesWithoutSkill satisfies {
  readonly [K in IntentResourceType]: IntentResourceTeaching<
    ResourceFieldsOf<IntentPayloadSchemaOf[K]>
  >
}

const { employee_tool: _dropTool, ...mapWithoutTool } = INTENT_PLATFORM_RESOURCE_MAP
// @ts-expect-error — 3. an AclResourceType without a capability-map stance does not compile
const _missingAcl = mapWithoutTool satisfies Record<AclResourceType, IntentPlatformResourceTeaching>

// ---------------------------------------------------------------------------
// 4–6: a schema grew a field (top level / nested element / one variant only)
// ---------------------------------------------------------------------------
const _ReviewExtended = ReviewNodeSchema.extend({ zzzFake: z.string() })
// @ts-expect-error — 4. a top-level field added to a strict node schema must be taught
const _topLevelField = INTENT_NODE_TEACHING.review.fields satisfies Omit<
  TeachingFieldsOf<typeof _ReviewExtended>,
  NodeBaseKey
>

const _ScriptOutputExtended = ScriptOutputPortSchema.extend({ zzzFake: z.string() })
// @ts-expect-error — 5. a field added to a nested array element must be taught in the sub-table
const _nestedField = INTENT_NODE_TEACHING.script.fields.outputs.nested satisfies TeachingFieldsOf<
  typeof _ScriptOutputExtended
>

const _MemberExtended = z.discriminatedUnion('memberType', [
  IntentWorkgroupMemberSchema.options[0].extend({ zzzFake: z.string() }),
  IntentWorkgroupMemberSchema.options[1],
])
const membersTeaching = INTENT_RESOURCE_TEACHING.workgroup.fields.members.nested
// @ts-expect-error — 6. a field added to ONE variant must be taught in that variant's table
const _variantOnlyField = membersTeaching satisfies IntentVariantTeaching<typeof _MemberExtended>

// ---------------------------------------------------------------------------
// 7: a discriminated union grew a variant
// ---------------------------------------------------------------------------
const _McpExtended = z.discriminatedUnion('type', [
  IntentMcpPayloadSchema.options[0],
  IntentMcpPayloadSchema.options[1],
  z.object({ type: z.literal('stdio'), name: z.string() }).strict(),
])
// @ts-expect-error — 7. a new union variant must get its own variant table
const _newVariant = INTENT_RESOURCE_TEACHING.mcp.fields satisfies IntentVariantTeaching<
  typeof _McpExtended
>

// ---------------------------------------------------------------------------
// 8: an object-valued field registered parent-only (no `nested`)
// ---------------------------------------------------------------------------
const _ReviewWithPolicy = ReviewNodeSchema.extend({ policy: z.object({ mode: z.string() }) })
const _parentOnly = {
  ...INTENT_NODE_TEACHING.review.fields,
  // @ts-expect-error — 8. an object-valued field cannot be taught without its schema-keyed `nested` table
  policy: { form: 'policy', required: false },
} satisfies Omit<TeachingFieldsOf<typeof _ReviewWithPolicy>, NodeBaseKey>

// Positive controls: the same shapes WITH the missing piece compile.
const _reviewToday = INTENT_NODE_TEACHING.review.fields satisfies StrictNodeFields<'review'>
const _parentWithNested = {
  ...INTENT_NODE_TEACHING.review.fields,
  policy: { form: 'policy', required: false, nested: { mode: { form: 'mode', required: true } } },
} satisfies Omit<TeachingFieldsOf<typeof _ReviewWithPolicy>, NodeBaseKey>

describe('RFC-348 — registry exhaustiveness is enforced by the compiler', () => {
  test('eight negative fixtures are resident (each guarded by @ts-expect-error)', () => {
    const fixtures = [
      _missingKind,
      _missingResource,
      _missingAcl,
      _topLevelField,
      _nestedField,
      _variantOnlyField,
      _newVariant,
      _parentOnly,
    ]
    expect(fixtures.length).toBe(8)
    expect([_reviewToday, _parentWithNested].length).toBe(2)
  })
})
