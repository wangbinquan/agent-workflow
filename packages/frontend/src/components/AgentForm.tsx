// Shared frontmatter + body form for /agents/new and /agents/$name.
// Lifts the entire CreateAgent payload to local state; submission is the
// parent's concern.

import type { CreateAgent } from '@agent-workflow/shared'
import { AGENT_NAME_RE } from '@agent-workflow/shared'
import { ChipsInput } from './ChipsInput'
import { Field, NumberInput, Switch, TextArea, TextInput } from './Form'
import { JsonField } from './JsonField'
import { MarkdownEditor } from './MarkdownEditor'

export interface AgentFormProps {
  value: CreateAgent
  onChange: (next: CreateAgent) => void
  /** When true the name input is read-only (editing an existing agent). */
  nameLocked?: boolean
}

const DEFAULT: CreateAgent = {
  name: '',
  description: '',
  outputs: [],
  readonly: false,
  permission: {},
  skills: [],
  frontmatterExtra: {},
  bodyMd: '',
}

export function emptyAgent(): CreateAgent {
  return structuredClone(DEFAULT)
}

export function AgentForm({ value, onChange, nameLocked }: AgentFormProps) {
  function patch<K extends keyof CreateAgent>(key: K, next: CreateAgent[K]) {
    onChange({ ...value, [key]: next })
  }

  return (
    <div className="agent-form">
      <div className="form-grid">
        <Field label="Name" required hint="kebab-case; matches /agents/:name URL.">
          <TextInput
            value={value.name}
            onChange={(v) => patch('name', v)}
            disabled={nameLocked === true}
            required
            pattern={AGENT_NAME_RE.source}
            placeholder="e.g. code-fixer"
          />
        </Field>

        <Field label="Description">
          <TextInput
            value={value.description ?? ''}
            onChange={(v) => patch('description', v)}
            placeholder="One-line summary shown in lists"
          />
        </Field>

        <Field label="Outputs" hint="Port names declared in <port> envelopes.">
          <ChipsInput
            value={value.outputs ?? []}
            onChange={(v) => patch('outputs', v)}
            placeholder="add a port name then Enter"
            validate={(t) => (/^[a-z][a-z0-9_]*$/.test(t) ? null : 'lowercase + underscore only')}
          />
        </Field>

        <Field label="Skills" hint="Skill names the framework should inject.">
          <ChipsInput
            value={value.skills ?? []}
            onChange={(v) => patch('skills', v)}
            placeholder="add a skill name then Enter"
          />
        </Field>

        <Switch
          checked={value.readonly === true}
          onChange={(v) => patch('readonly', v)}
          label="Read-only"
          hint="Read-only agents can run concurrently in the same task; writers serialize."
        />

        <div className="form-grid form-grid--cols-3">
          <Field label="Model">
            <TextInput
              value={value.model ?? ''}
              onChange={(v) => patch('model', v === '' ? undefined : v)}
              placeholder="anthropic/claude-sonnet-4-6"
            />
          </Field>
          <Field label="Variant">
            <TextInput
              value={value.variant ?? ''}
              onChange={(v) => patch('variant', v === '' ? undefined : v)}
              placeholder="(optional)"
            />
          </Field>
          <Field label="Temperature">
            <NumberInput
              value={value.temperature}
              onChange={(v) => patch('temperature', v)}
              min={0}
              max={2}
              step={0.1}
              placeholder="0–2"
            />
          </Field>
          <Field label="Steps">
            <NumberInput
              value={value.steps}
              onChange={(v) => patch('steps', v)}
              min={1}
              placeholder="(optional)"
            />
          </Field>
          <Field label="Max steps">
            <NumberInput
              value={value.maxSteps}
              onChange={(v) => patch('maxSteps', v)}
              min={1}
              placeholder="(optional)"
            />
          </Field>
        </div>

        <Field label="Permission JSON" hint="opencode permission object; pass-through.">
          <JsonField
            value={value.permission ?? {}}
            onChange={(v) => patch('permission', v)}
            placeholder='{"edit":"allow","webfetch":"deny"}'
            rows={5}
          />
        </Field>

        <Field
          label="Extra frontmatter (JSON)"
          hint="Any keys other than name/description/outputs/readonly/model/variant/temperature/steps/permission/skills."
        >
          <JsonField
            value={value.frontmatterExtra ?? {}}
            onChange={(v) => patch('frontmatterExtra', v)}
            placeholder="(optional)"
            rows={4}
          />
        </Field>

        <Field label="Body (Markdown)">
          <MarkdownEditor
            value={value.bodyMd ?? ''}
            onChange={(v) => patch('bodyMd', v)}
            placeholder="Agent system prompt body. Markdown."
          />
        </Field>

        {/* Quick raw-body fallback for users who don't want preview. */}
        <details className="form-details">
          <summary>Raw body (no preview)</summary>
          <TextArea
            value={value.bodyMd ?? ''}
            onChange={(v) => patch('bodyMd', v)}
            rows={6}
            monospace
          />
        </details>
      </div>
    </div>
  )
}
