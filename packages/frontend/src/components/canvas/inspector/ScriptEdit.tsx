// RFC-253 — script node inspector branch.
//
// Two things here are deliberate and worth stating:
//
//   1. **The inbound-port hint list.** A script reads its upstream values from
//      `AW_PORT_<SUFFIX>` environment variables whose names are DERIVED from the
//      incoming edges' target port names (shared `scriptEnvSuffix`). Without a
//      live list the author has to guess the mangling, so the panel renders the
//      exact variable names the executor will set — same derivation, one source.
//
//   2. **Read-only for users without `scripts:author`.** The gate lives at the
//      persistence primitives, so an unprivileged user's edits would be accepted
//      by the form and rejected on save. Rendering the whole block read-only with
//      an explicit banner is the honest surface (AC-30) — "you may look, you may
//      not change" beats "type freely, lose it on save".

import { useTranslation } from 'react-i18next'
import {
  declaredScriptOutputs,
  readScriptDependencies,
  readScriptEnv,
  readScriptLanguage,
  resolveScriptNetwork,
  resolveScriptReadonly,
  scriptDependencyIssue,
  scriptEnvSuffix,
  scriptOutputMode,
  scriptReservedEnvKeyIssue,
  SCRIPT_ENV_VALUE_PREFIX,
  SCRIPT_LANGUAGES,
  type ScriptLanguage,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { ChipsInput } from '@/components/ChipsInput'
import { CodeEditor, type CodeEditorLanguage } from '@/components/CodeEditor'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, Switch, TextInput } from '@/components/Form'
import { Segmented } from '@/components/Segmented'
import { usePermission } from '@/hooks/useActor'
import {
  atomicNodeInspectorChange,
  continuousNodeInspectorChange,
  type InspectorChangeMeta,
} from './historyMeta'
import { InspectorFieldAnchor } from './InspectorFieldAnchor'
import { InspectorSection } from './InspectorSection'
import { NodeTitleField } from './NodeTitleField'
import { SCRIPT_STARTER_TEMPLATES } from '../nodePalette'
import type { EditProps } from './types'

const EDITOR_LANGUAGE: Record<ScriptLanguage, CodeEditorLanguage> = {
  python: 'python',
  bash: 'bash',
  node: 'javascript',
}

export function ScriptEdit({ node, definition, onPatch, onHistoryBoundary }: EditProps) {
  const { t } = useTranslation()
  const canAuthor = usePermission('scripts:author')

  const language = readScriptLanguage(node) ?? 'python'
  const body =
    typeof (node as unknown as Record<string, unknown>).script === 'string'
      ? ((node as unknown as Record<string, unknown>).script as string)
      : ''
  const dependencies = readScriptDependencies(node)
  const env = readScriptEnv(node)
  const network = resolveScriptNetwork(node)
  const isReadonly = resolveScriptReadonly(node)
  const outputs = declaredScriptOutputs(node)
  const mode = scriptOutputMode(node)

  // Inbound edges are the ONLY source of a script node's inputs (agent
  // precedent: edge-derived, never declared), so the hint list reads them
  // straight off the definition.
  const inboundPorts = [
    ...new Set(
      definition.edges
        .filter((edge) => edge.target.nodeId === node.id)
        .map((edge) => edge.target.portName),
    ),
  ].sort()

  function update(patch: Record<string, unknown>, meta: InspectorChangeMeta) {
    onPatch({ ...(node as Record<string, unknown>), ...patch } as unknown as WorkflowNode, meta)
  }

  return (
    <div className="inspector-sections">
      {canAuthor ? null : (
        <ErrorBanner error={null} message={t('scriptInspector.noAuthorPermission')} />
      )}

      <InspectorSection title={t('inspector.sectionBasics')}>
        <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
        <Field label={t('scriptInspector.language')} hint={t('scriptInspector.languageHint')} group>
          <Segmented<ScriptLanguage>
            value={language}
            ariaLabel={t('scriptInspector.language')}
            testidPrefix="script-language"
            options={SCRIPT_LANGUAGES.map((value) => ({ value, label: value }))}
            onChange={(next) => {
              if (!canAuthor) return
              // Swapping language on an untouched starter body swaps the
              // template too; a body the author actually wrote is never
              // rewritten under them.
              const isStarter = Object.values(SCRIPT_STARTER_TEMPLATES).includes(body)
              update(
                {
                  language: next,
                  ...(isStarter || body.trim().length === 0
                    ? { script: SCRIPT_STARTER_TEMPLATES[next] }
                    : {}),
                },
                atomicNodeInspectorChange(node.id, 'language', t('scriptInspector.language')),
              )
            }}
          />
        </Field>
      </InspectorSection>

      <InspectorSection title={t('scriptInspector.sectionCode')}>
        <InspectorFieldAnchor nodeId={node.id} field="script">
          <Field
            label={t('scriptInspector.body')}
            hint={t('scriptInspector.bodyHint')}
            required
            group
          >
            <CodeEditor
              value={body}
              language={EDITOR_LANGUAGE[language]}
              readOnly={!canAuthor}
              aria-label={t('scriptInspector.body')}
              data-testid="script-body-editor"
              onChange={(next) =>
                update(
                  { script: next },
                  continuousNodeInspectorChange(node.id, 'script', t('scriptInspector.body')),
                )
              }
            />
          </Field>
        </InspectorFieldAnchor>
        <p className="inspector-hint" data-testid="script-retry-warning">
          {t('scriptInspector.retryWarning')}
        </p>
      </InspectorSection>

      <InspectorSection title={t('scriptInspector.sectionInputs')}>
        {inboundPorts.length === 0 ? (
          <p className="inspector-hint">{t('scriptInspector.noInputs')}</p>
        ) : (
          <ul className="script-input-hints" data-testid="script-input-hints">
            {inboundPorts.map((port) => (
              <li key={port}>
                <code>{port}</code>
                <span aria-hidden="true"> → </span>
                <code>{`${SCRIPT_ENV_VALUE_PREFIX}${scriptEnvSuffix(port)}`}</code>
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>

      <InspectorSection title={t('scriptInspector.sectionOutputs')}>
        <p className="inspector-hint">
          {mode === 'single'
            ? t('scriptInspector.outputSingle', { port: outputs[0]?.name ?? 'stdout' })
            : t('scriptInspector.outputEnvelope')}
        </p>
        <Field
          label={t('scriptInspector.outputPorts')}
          hint={t('scriptInspector.outputPortsHint')}
          group
        >
          <ChipsInput
            value={outputs.length === 1 && mode === 'single' ? [] : outputs.map((p) => p.name)}
            disabled={!canAuthor}
            testidPrefix="script-outputs"
            onChange={(next) =>
              update(
                { outputs: next.length === 0 ? undefined : next.map((name) => ({ name })) },
                atomicNodeInspectorChange(node.id, 'outputs', t('scriptInspector.outputPorts')),
              )
            }
          />
        </Field>
      </InspectorSection>

      <InspectorSection title={t('scriptInspector.sectionRuntime')}>
        <Field
          label={t('scriptInspector.dependencies')}
          hint={t('scriptInspector.dependenciesHint')}
          group
        >
          <ChipsInput
            value={dependencies}
            disabled={!canAuthor || language === 'bash'}
            testidPrefix="script-deps"
            validate={(token) => scriptDependencyIssue(language, token)}
            onChange={(next) =>
              update(
                { dependencies: next.length === 0 ? undefined : next },
                atomicNodeInspectorChange(
                  node.id,
                  'dependencies',
                  t('scriptInspector.dependencies'),
                ),
              )
            }
          />
        </Field>

        <Field label={t('scriptInspector.env')} hint={t('scriptInspector.envHint')} group>
          <ScriptEnvTable
            env={env}
            disabled={!canAuthor}
            onChange={(next) =>
              update(
                { env: Object.keys(next).length === 0 ? undefined : next },
                atomicNodeInspectorChange(node.id, 'env', t('scriptInspector.env')),
              )
            }
          />
        </Field>

        <Switch
          checked={network === 'deny'}
          disabled={!canAuthor}
          label={t('scriptInspector.networkDeny')}
          hint={t('scriptInspector.networkDenyHint')}
          data-testid="script-network-deny"
          onChange={(checked) =>
            update(
              { network: checked ? 'deny' : undefined },
              atomicNodeInspectorChange(node.id, 'network', t('scriptInspector.networkDeny')),
            )
          }
        />
        <Switch
          checked={isReadonly}
          disabled={!canAuthor}
          label={t('scriptInspector.readonly')}
          hint={t('scriptInspector.readonlyHint')}
          data-testid="script-readonly"
          onChange={(checked) =>
            update(
              { readonly: checked ? true : undefined },
              atomicNodeInspectorChange(node.id, 'readonly', t('scriptInspector.readonly')),
            )
          }
        />
      </InspectorSection>
    </div>
  )
}

/**
 * Key/value editor for the node's `env` overlay. Kept local rather than
 * promoted to a shared primitive: the only other key/value map in the product
 * (MCP `env`) lives inside `McpFields` with different validation and a
 * different persistence shape, and merging the two would mean inventing a
 * generic that serves neither. If a third appears, that is the moment to
 * extract one.
 */
function ScriptEnvTable({
  env,
  disabled,
  onChange,
}: {
  env: Record<string, string>
  disabled: boolean
  onChange: (next: Record<string, string>) => void
}) {
  const { t } = useTranslation()
  const rows = Object.entries(env)
  return (
    <div className="script-env-table" data-testid="script-env-table">
      {rows.map(([key, value]) => {
        const issue = scriptReservedEnvKeyIssue(key)
        return (
          <div className="script-env-table__row" key={key}>
            <TextInput
              value={key}
              disabled={disabled}
              aria-label={t('scriptInspector.envKey')}
              data-testid={`script-env-key-${key}`}
              onChange={(nextKey) => {
                const next: Record<string, string> = {}
                for (const [k, v] of rows) next[k === key ? nextKey : k] = v
                onChange(next)
              }}
            />
            <TextInput
              value={value}
              disabled={disabled}
              aria-label={t('scriptInspector.envValue')}
              data-testid={`script-env-value-${key}`}
              onChange={(nextValue) => onChange({ ...env, [key]: nextValue })}
            />
            <button
              type="button"
              className="btn btn--xs btn--danger"
              disabled={disabled}
              aria-label={t('scriptInspector.envRemove')}
              data-testid={`script-env-remove-${key}`}
              onClick={() => {
                const next = { ...env }
                delete next[key]
                onChange(next)
              }}
            >
              ×
            </button>
            {issue === null ? null : <p className="form-error">{issue}</p>}
          </div>
        )
      })}
      <button
        type="button"
        className="btn btn--sm"
        disabled={disabled}
        data-testid="script-env-add"
        onClick={() => {
          let i = 1
          while (Object.hasOwn(env, `VAR_${i}`)) i++
          onChange({ ...env, [`VAR_${i}`]: '' })
        }}
      >
        {t('scriptInspector.envAdd')}
      </button>
    </div>
  )
}
