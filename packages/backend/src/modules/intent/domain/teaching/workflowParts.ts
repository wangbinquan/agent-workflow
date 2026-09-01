// RFC-348 — workflow PART teaching tables: input declarations, edges, output
// bindings and the single PortRef sub-table.
//
// The intent changeset carries `definition.inputs[] / edges[] / outputs` as
// passthrough `unknown`, so their teaching cannot hang off the intent payload
// schema. It hangs off the PLATFORM schemas instead (`WorkflowInputSchema`,
// `WorkflowEdgeSchema`, `WorkflowOutputBindingSchema`, `PortRefSchema`,
// `UploadInputSchema`): a key added there fails to compile here. The four input
// kinds whose extra fields have NO schema (text / files / enum / git are
// `.passthrough()`) are keyed by literal unions and carry `extraSources` — the
// real read points a test verifies through the TypeScript AST.

import { UPLOAD_ON_CONFLICT } from '@agent-workflow/shared'
import type {
  PortRefSchema,
  UploadInputSchema,
  WORKFLOW_INPUT_KIND,
  WorkflowEdgeSchema,
  WorkflowInputSchema,
  WorkflowOutputBindingSchema,
} from '@agent-workflow/shared'
import type {
  IntentPassthroughFieldSource,
  KeysOf,
  ScalarTeaching,
  TeachingFieldsOf,
} from './types'

export type WorkflowInputKind = (typeof WORKFLOW_INPUT_KIND)[number]

// ───────────────────────── PortRef / edge / output ─────────────────────────

/** The ONE PortRef sub-table. review `inputSource`, edge `source` / `target` and
 *  output `bind` all reference this object (a test asserts identity). */
export const WORKFLOW_PORT_REF_TEACHING = {
  nodeId: { form: 'nodeId', required: true },
  portName: { form: 'portName', required: true },
} as const satisfies TeachingFieldsOf<typeof PortRefSchema>

export const WORKFLOW_EDGE_TEACHING = {
  id: { form: 'id', required: true },
  source: {
    form: 'source:{nodeId,portName}',
    required: true,
    nested: WORKFLOW_PORT_REF_TEACHING,
  },
  target: {
    form: 'target:{nodeId,portName}',
    required: true,
    nested: WORKFLOW_PORT_REF_TEACHING,
  },
  boundary: {
    form: "boundary:'wrapper-input'|'wrapper-output'",
    required: false,
    note: "A fanout boundary edge additionally has `boundary:'wrapper-input'|'wrapper-output'`: wrapper-input runs from wrapper declared input → inner agent input; wrapper-output runs from inner aggregator output → wrapper outlet.",
  },
} as const satisfies TeachingFieldsOf<typeof WorkflowEdgeSchema>

export const WORKFLOW_OUTPUT_TEACHING = {
  name: { form: 'name', required: true },
  bind: { form: 'bind:{nodeId,portName}', required: true, nested: WORKFLOW_PORT_REF_TEACHING },
} as const satisfies TeachingFieldsOf<typeof WorkflowOutputBindingSchema>

/** Sentences rendered after the edge form (contract-locked wording). */
export const WORKFLOW_EDGE_NOTES = [
  "An input node's out-port = its inputKey; an agent's out-ports = its `outputs`; prompt templates read inbound ports as `{{port_name}}`.",
] as const

// ───────────────────────── input declarations ─────────────────────────

type InputBaseKey = KeysOf<typeof WorkflowInputSchema>
type UploadExtraKey = Exclude<KeysOf<typeof UploadInputSchema>, InputBaseKey>
type PassthroughInputExtraKey<K extends WorkflowInputKind> = K extends 'text'
  ? 'multiline' | 'maxLength'
  : K extends 'files'
    ? 'minCount' | 'maxCount' | 'accept'
    : K extends 'enum'
      ? 'choices' | 'multiSelect' | 'allowOther'
      : K extends 'git'
        ? 'gitKind'
        : never
export type InputExtraKeyOf<K extends WorkflowInputKind> = K extends 'upload'
  ? UploadExtraKey
  : PassthroughInputExtraKey<K>

export type WorkflowInputKindTeaching<K extends WorkflowInputKind> = {
  /** The five common keys, keyed by `WorkflowInputSchema` (shared object). */
  readonly base: TeachingFieldsOf<typeof WorkflowInputSchema>
  /** Kind-specific extension fields: upload keyed by `UploadInputSchema`, the rest by literal unions. */
  readonly extra: { readonly [F in InputExtraKeyOf<K>]: ScalarTeaching }
} & (K extends 'upload'
  ? { readonly extraSources?: never }
  : { readonly extraSources: { readonly [F in InputExtraKeyOf<K>]: IntentPassthroughFieldSource } })

const LAUNCH_INPUTS =
  'packages/backend/src/modules/resource-catalog/infrastructure/legacy/workflowLaunchInputs.ts'

export const WORKFLOW_INPUT_BASE_TEACHING = {
  kind: { form: 'kind', required: true },
  key: { form: 'key', required: true },
  label: { form: 'label', required: true },
  required: { form: 'required', required: false },
  description: { form: 'description', required: false },
} as const satisfies TeachingFieldsOf<typeof WorkflowInputSchema>

export const WORKFLOW_INPUT_TEACHING = {
  text: {
    base: WORKFLOW_INPUT_BASE_TEACHING,
    extra: {
      multiline: { form: 'multiline', required: false },
      maxLength: { form: 'maxLength', required: false },
    },
    extraSources: {
      multiline: {
        readPoint: {
          file: 'packages/frontend/src/components/launch/DynamicInput.tsx',
          identifier: 'multiline',
        },
      },
      maxLength: { readPoint: { file: LAUNCH_INPUTS, identifier: 'maxLength' } },
    },
  },
  files: {
    base: WORKFLOW_INPUT_BASE_TEACHING,
    extra: {
      minCount: { form: 'minCount', required: false },
      maxCount: { form: 'maxCount', required: false },
      accept: { form: 'accept', required: false },
    },
    extraSources: {
      minCount: { readPoint: { file: LAUNCH_INPUTS, identifier: 'minCount' } },
      maxCount: { readPoint: { file: LAUNCH_INPUTS, identifier: 'maxCount' } },
      accept: {
        readPoint: {
          file: 'packages/frontend/src/components/launch/FilesPicker.tsx',
          identifier: 'accept',
        },
      },
    },
  },
  enum: {
    base: WORKFLOW_INPUT_BASE_TEACHING,
    extra: {
      choices: { form: 'choices', required: true },
      multiSelect: { form: 'multiSelect', required: false },
      allowOther: { form: 'allowOther', required: false },
    },
    extraSources: {
      choices: { readPoint: { file: LAUNCH_INPUTS, identifier: 'choices' } },
      multiSelect: { readPoint: { file: LAUNCH_INPUTS, identifier: 'multiSelect' } },
      allowOther: { readPoint: { file: LAUNCH_INPUTS, identifier: 'allowOther' } },
    },
  },
  git: {
    base: WORKFLOW_INPUT_BASE_TEACHING,
    extra: {
      gitKind: { form: "gitKind:'branch'|'commit-range'|'pr'", required: true },
    },
    extraSources: {
      gitKind: { readPoint: { file: LAUNCH_INPUTS, identifier: 'gitKind' } },
    },
  },
  upload: {
    base: WORKFLOW_INPUT_BASE_TEACHING,
    extra: {
      targetDir: { form: 'targetDir', required: true },
      accept: { form: 'accept', required: false },
      maxFileSize: { form: 'maxFileSize', required: false },
      minCount: { form: 'minCount', required: false },
      maxCount: { form: 'maxCount', required: false },
      onConflict: {
        form: 'onConflict',
        required: false,
        note: `(\`onConflict:${UPLOAD_ON_CONFLICT.map((v) => `'${v}'`).join('|')}\`, default \`rename\`: on a name clash inside \`targetDir\`,
  \`rename\` writes \`report (1).pdf\` and keeps the existing file, \`overwrite\` replaces it and keeps
  the original path. Two uploaded files landing on the same path are rejected at launch either way).`,
      },
    },
  },
} as const satisfies { readonly [K in WorkflowInputKind]: WorkflowInputKindTeaching<K> }

/** Every extension field name any input kind carries (authorable or derived). */
export type InputExtraField =
  | 'multiline'
  | 'maxLength'
  | 'minCount'
  | 'maxCount'
  | 'accept'
  | 'choices'
  | 'multiSelect'
  | 'allowOther'
  | 'gitKind'
  | 'targetDir'
  | 'maxFileSize'
  | 'onConflict'
  | 'presentation'
  | 'agentKind'

export interface InputFieldOwnership {
  readonly kinds: readonly WorkflowInputKind[]
  /** false = platform-derived (DerivedLaunchInput), never written by a workflow author — not taught. */
  readonly authorable: boolean
  readonly why?: string
}

/** Which kinds each extension field belongs to. Tests check three ways: every
 *  authorable (field, kind) pair appears in that kind's `extra`, every `extra`
 *  key is owned by its kind here, and every name the backend / frontend read
 *  scans find is listed here. */
export const INPUT_FIELD_OWNERSHIP = {
  multiline: { kinds: ['text'], authorable: true },
  maxLength: { kinds: ['text'], authorable: true },
  minCount: { kinds: ['files', 'upload'], authorable: true },
  maxCount: { kinds: ['files', 'upload'], authorable: true },
  accept: { kinds: ['files', 'upload'], authorable: true },
  choices: { kinds: ['enum'], authorable: true },
  multiSelect: { kinds: ['enum'], authorable: true },
  allowOther: { kinds: ['enum'], authorable: true },
  gitKind: { kinds: ['git'], authorable: true },
  targetDir: { kinds: ['upload'], authorable: true },
  maxFileSize: { kinds: ['upload'], authorable: true },
  onConflict: { kinds: ['upload'], authorable: true },
  presentation: {
    kinds: ['text'],
    authorable: false,
    why: 'DerivedLaunchInput (packages/shared/src/agentLaunchForm.ts) synthesized when an agent is launched directly',
  },
  agentKind: {
    kinds: ['text', 'upload'],
    authorable: false,
    why: 'DerivedLaunchInput (packages/shared/src/agentLaunchForm.ts) — carried on both the text and the upload derived input',
  },
} as const satisfies Record<InputExtraField, InputFieldOwnership>
