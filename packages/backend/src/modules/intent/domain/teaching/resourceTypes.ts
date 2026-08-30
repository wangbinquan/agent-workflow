// RFC-348 D2 — the resource-type teaching registry: one entry per
// `IntentResourceType`, compile-checked against the intent payload schemas
// (`ResourceFieldsOf<IntentPayloadSchemaOf[K]>`, types.ts).
//
// A field added to any intent payload schema — top level, nested object, array
// element, plain-union object option (agent `skills`) or discriminated-union
// variant (mcp root, workgroup `members`) — fails to compile until it is taught
// here or explicitly `omit`ted. The reconciliation table (reconciliation.ts)
// then ties these intent keys back to the PLATFORM create schemas so a
// platform-side field cannot silently stay unteachable.

import { WORKFLOW_SCHEMA_VERSION, type IntentResourceType } from '@agent-workflow/shared'
import { renderPermissionGrammar } from './permissionGrammar'
import type { IntentResourceTeaching, IntentPayloadSchemaOf, ResourceFieldsOf } from './types'

const SECRET = "'‹secret›'"

export const INTENT_RESOURCE_TEACHING = {
  agent: {
    fields: {
      name: { form: 'name', required: true },
      description: { form: 'description', required: true },
      outputs: { form: 'outputs: string[]', required: true },
      bodyMd: {
        form: 'bodyMd',
        required: true,
        note: "`bodyMd` is the agent's full markdown body (its system prompt).",
        mistake: 'There is NO `systemPrompt`/`ports`/`outputPorts` field.',
      },
      outputKinds: { form: 'outputKinds:{port:kind}', required: false },
      branchPorts: {
        form: 'branchPorts:[port]',
        required: false,
        note: '`branchPorts` (RFC-306) names the subset of `outputs` the agent may mark inactive at runtime (`<port name="x" active="false">`), which skips every edge leaving that port.',
      },
      outputWrapperPortNames: {
        form: 'outputWrapperPortNames:{agentPort:wrapperPort}',
        required: false,
      },
      inputs: {
        form: 'inputs:[{name,kind,required?,description?}]',
        required: false,
        nested: {
          name: { form: 'name', required: true },
          kind: { form: 'kind', required: true },
          required: { form: 'required', required: false },
          description: { form: 'description', required: false },
        },
      },
      role: { form: "role:'normal'|'aggregator'", required: false },
      runtime: {
        form: 'runtime',
        required: false,
        note: '`runtime` is a runtime profile NAME from inventory/runtimes.md — choose an ENABLED row; rows marked (disabled) are listed only so you can recognise an existing pin (creating or re-pointing an agent to one is rejected with `runtime-disabled`). Omit it to inherit the effective default named there.',
      },
      permission: {
        form: 'permission:{key:action}',
        required: false,
        note: `\`permission\` — ${renderPermissionGrammar()}`,
      },
      skills: {
        form: "skills:[ref|{kind:'project',name}]",
        required: false,
        note: "Each `skills` entry is either a `res#skill#n` handle / `$new:` tempRef of a managed skill, or `{kind:'project',name}` for a skill that lives in the repository itself.",
        nested: {
          kind: { form: "kind:'project'", required: true },
          name: { form: 'name', required: true },
        },
      },
      dependsOn: { form: 'dependsOn:[ref]', required: false },
      mcp: { form: 'mcp:[ref]', required: false },
      plugins: { form: 'plugins:[ref]', required: false },
      syncOutputsOnIterate: { form: 'syncOutputsOnIterate', required: false },
      frontmatterExtra: { form: 'frontmatterExtra', required: false },
    },
    notes: [
      'Port kinds (`outputKinds` values / `inputs[].kind`): `string` (default) | `markdown` | `signal` | `path<ext>` | `list<kind>` — nothing else.',
      '`outputWrapperPortNames` is only for an aggregator inside wrapper-fanout; omit it when wrapper outlet names equal the agent output names.',
      "On an update, omitting `branchPorts` / `outputKinds` / `role` / `outputWrapperPortNames` keeps the stored value; send `[]` / `{}` / `'normal'` / `{}` respectively to clear one.",
    ],
    mistakes: [
      '`branchPorts` must be a subset of `outputs` — a branch port that is not also declared in `outputs` fails validation.',
      "`outputWrapperPortNames` without `role:'aggregator'` does nothing; declare the role on the aggregator agent.",
    ],
  },
  skill: {
    fields: {
      name: { form: 'name', required: true },
      description: { form: 'description', required: true },
      bodyMd: { form: 'bodyMd', required: true, note: '`bodyMd` becomes SKILL.md.' },
      files: {
        form: 'files:[{path,content}]',
        required: false,
        nested: {
          path: { form: 'path', required: true },
          content: { form: 'content', required: true },
        },
      },
      frontmatterExtra: { form: 'frontmatterExtra', required: false },
    },
    notes: ['Skills have NO inputs/outputs.'],
    mistakes: [],
  },
  mcp: {
    fields: {
      discriminator: 'type',
      variants: {
        local: {
          type: { form: "type:'local'", required: true },
          name: { form: 'name', required: true },
          description: { form: 'description', required: true },
          config: {
            form: `config:{command: string[], env?:{KEY:${SECRET}}, timeoutMs?}`,
            required: true,
            nested: {
              command: { form: 'command: string[]', required: true },
              env: { form: `env:{KEY:${SECRET}}`, required: false },
              timeoutMs: { form: 'timeoutMs', required: false },
            },
          },
          enabled: { form: 'enabled', required: false },
        },
        remote: {
          type: { form: "type:'remote'", required: true },
          name: { form: 'name', required: true },
          description: { form: 'description', required: true },
          config: {
            form: `config:{url, headers?:{KEY:${SECRET}}, oauth?:false|{clientId?,clientSecret?:${SECRET},scope?,redirectUri?}, timeoutMs?}`,
            required: true,
            nested: {
              url: { form: 'url', required: true },
              headers: { form: `headers:{KEY:${SECRET}}`, required: false },
              oauth: {
                form: `oauth:false|{clientId?,clientSecret?:${SECRET},scope?,redirectUri?}`,
                required: false,
                nested: {
                  clientId: { form: 'clientId', required: false },
                  clientSecret: { form: `clientSecret:${SECRET}`, required: false },
                  scope: { form: 'scope', required: false },
                  redirectUri: { form: 'redirectUri', required: false },
                },
              },
              timeoutMs: { form: 'timeoutMs', required: false },
            },
          },
          enabled: { form: 'enabled', required: false },
        },
      },
    },
    notes: [
      `\`oauth\` (remote only): omit it on create to let the runtime auto-discover OAuth, set \`false\` to disable, or give \`{clientId?,clientSecret?:${SECRET},scope?,redirectUri?}\` for an explicit client (\`clientSecret\` may be omitted when the client has none) — the confirm UI collects the real secret. On an update, omitting \`oauth\` keeps the stored configuration.`,
      '`timeoutMs` (both types) is the server start / call timeout in milliseconds, a positive integer; omit it for the runtime default.',
    ],
    mistakes: [
      "A literal credential anywhere — an `env` value, a header value or `oauth.clientSecret` — is rejected; every credential slot must be the exact `‹secret›` sentinel (or `''`).",
    ],
  },
  plugin: {
    fields: {
      name: { form: 'name', required: true },
      spec: {
        form: 'spec',
        required: true,
        note: '`spec` = npm package or git/file URL.',
      },
      description: { form: 'description', required: true },
      optionsJson: {
        form: 'optionsJson',
        required: false,
        mistake: 'The key is exactly `optionsJson`, never `options`.',
      },
      enabled: { form: 'enabled', required: false },
    },
    notes: [],
    mistakes: [],
  },
  workflow: {
    fields: {
      name: { form: 'name', required: true },
      description: { form: 'description', required: true },
      definition: {
        form: `definition:{$schema_version:${WORKFLOW_SCHEMA_VERSION}, inputs:[…], nodes:[…], edges:[…], outputs?}`,
        required: true,
        nested: {
          $schema_version: { form: `$schema_version:${WORKFLOW_SCHEMA_VERSION}`, required: true },
          inputs: { form: 'inputs:[…]', required: true },
          nodes: {
            form: 'nodes:[…]',
            required: true,
            nested: {
              id: { form: 'id', required: true },
              kind: { form: 'kind', required: true },
              agentRef: { form: 'agentRef', required: false },
              workflowRef: { form: 'workflowRef', required: false },
              workgroupRef: { form: 'workgroupRef', required: false },
            },
          },
          edges: { form: 'edges:[…]', required: true },
          outputs: { form: 'outputs', required: false },
        },
      },
    },
    notes: [],
    mistakes: [],
  },
  workgroup: {
    fields: {
      name: { form: 'name', required: true },
      description: { form: 'description', required: true },
      instructions: { form: 'instructions', required: true },
      mode: { form: "mode:'leader_worker'|'free_collab'|'dynamic_workflow'", required: true },
      outputContract: {
        form: "outputContract:'files'|'discussion'",
        required: false,
        note: 'Use `discussion` when the primary result is a room conclusion and files are optional; omitted means `files`.',
      },
      leaderDisplayName: { form: 'leaderDisplayName', required: false },
      members: {
        form: "members:[{memberType:'agent', agentRef: ref, displayName, roleDesc} | {memberType:'human', displayName, roleDesc}]",
        required: true,
        note: 'Human members are placeholders — never real usernames.',
        nested: {
          discriminator: 'memberType',
          variants: {
            agent: {
              memberType: { form: "memberType:'agent'", required: true },
              agentRef: { form: 'agentRef: ref', required: true },
              displayName: { form: 'displayName', required: true },
              roleDesc: { form: 'roleDesc', required: true },
            },
            human: {
              memberType: { form: "memberType:'human'", required: true },
              displayName: { form: 'displayName', required: true },
              roleDesc: { form: 'roleDesc', required: true },
            },
          },
        },
      },
      switches: {
        form: 'switches:{shareOutputs:boolean,directMessages:boolean,blackboard:boolean}',
        required: false,
        nested: {
          shareOutputs: { form: 'shareOutputs:boolean', required: true },
          directMessages: { form: 'directMessages:boolean', required: true },
          blackboard: { form: 'blackboard:boolean', required: true },
        },
      },
      maxRounds: { form: 'maxRounds:integer(1..1000)', required: false },
      completionGate: { form: 'completionGate:boolean', required: false },
      clarifyBudget: { form: 'clarifyBudget:integer(0..50)', required: false },
      fanOut: { form: 'fanOut:boolean', required: false },
    },
    notes: [
      'Visibility choices must be encoded structurally: for “private direct messages + public blackboard”, set `switches:{shareOutputs:true,directMessages:true,blackboard:true}`; prose in `instructions` does not change runtime switches.',
    ],
    mistakes: [
      "`leaderDisplayName` must equal an AGENT member's `displayName`, and `mode:'dynamic_workflow'` forbids human members.",
    ],
  },
} as const satisfies {
  readonly [K in IntentResourceType]: IntentResourceTeaching<
    ResourceFieldsOf<IntentPayloadSchemaOf[K]>
  >
}

export type IntentResourceTeachingRegistryValue = typeof INTENT_RESOURCE_TEACHING
