// RFC-269 — code-host call node inspector branch.
//
// 三处是有意为之：
//
//   1. **表单由共享注册表驱动**。字段、必填、选项、哪家显示哪些字段，全部来自
//      `codeHost/actions.ts`，与校验器和执行器读的是同一张表。这里不重写一份
//      「GitLab 要 project、GitHub 要 owner/repo」的知识 —— 那种复制品迟早与
//      执行器分叉，症状是「表单说填对了，运行时 404」。
//
//   2. **不支持的动作置灰而不是隐藏**。GitHub 的 resolve 线程在 REST 面根本
//      不存在（只有 GraphQL）。隐藏它会让人以为「GitHub 没这功能」然后跑去
//      自定义请求里瞎试；置灰 + 说明原因才是诚实的。
//
//   3. **没有 `code-host-calls:author` 时整块只读**。门在持久化原语上，所以
//      无权限用户的编辑会被表单接受、在保存时被拒。整块只读 + 明确横幅是诚实
//      的呈现（与 RFC-253 的脚本面板同款）。

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CODE_HOST_ACTION_DEFS,
  CODE_HOST_METHODS,
  codeHostActionFields,
  codeHostActionSupported,
  codeHostActionsByGroup,
  isCodeHostAction,
  isUnsupportedBinding,
  TRIGGER_CONTEXT_VARS,
  WEBHOOK_VAR_GROUPS,
  type CodeHostAction,
  type CodeHostField,
  type CodeHostMethod,
  type CodeHostProvider,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, Switch, TextArea, TextInput } from '@/components/Form'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { applyTemplateVarInsertion, TemplateVarChips } from '@/components/TemplateVarChips'
import { usePermission } from '@/hooks/useActor'
import {
  atomicNodeInspectorChange,
  continuousNodeInspectorChange,
  type InspectorChangeMeta,
} from './historyMeta'
import { InspectorFieldAnchor } from './InspectorFieldAnchor'
import { InspectorSection } from './InspectorSection'
import { NodeTitleField } from './NodeTitleField'
import type { EditProps } from './types'

const PROVIDERS: readonly CodeHostProvider[] = ['gitlab', 'github']

function rec(node: WorkflowNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>
}

function readParams(node: WorkflowNode): Record<string, string> {
  const raw = rec(node).params
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

interface CustomRequestShape {
  method: CodeHostMethod
  path: string
  body?: string
}

type TemplateInput = HTMLInputElement | HTMLTextAreaElement

interface TemplateTarget {
  key: string
  label: string
  value: string
  commit: (next: string) => void
}

function readRequest(node: WorkflowNode): CustomRequestShape {
  const raw = rec(node).request
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { method: 'GET', path: '' }
  }
  const r = raw as Record<string, unknown>
  const method =
    typeof r.method === 'string' && (CODE_HOST_METHODS as readonly string[]).includes(r.method)
      ? (r.method as CodeHostMethod)
      : 'GET'
  return {
    method,
    path: typeof r.path === 'string' ? r.path : '',
    ...(typeof r.body === 'string' ? { body: r.body } : {}),
  }
}

export function CodeHostCallEdit({ node, definition, onPatch, onHistoryBoundary }: EditProps) {
  const { t } = useTranslation()
  const canAuthor = usePermission('code-host-calls:author')
  const templateInputRefs = useRef(new Map<string, TemplateInput>())
  const [focusedTemplateTargetKey, setFocusedTemplateTargetKey] = useState<string | null>(null)

  const provider: CodeHostProvider = rec(node).provider === 'github' ? 'github' : 'gitlab'
  const rawAction = rec(node).action
  const action: CodeHostAction =
    typeof rawAction === 'string' && isCodeHostAction(rawAction) ? rawAction : 'comment.create'
  const params = readParams(node)
  const request = readRequest(node)
  const allowDestructive = rec(node).allowDestructive === true

  const patch = (next: Record<string, unknown>, meta: InspectorChangeMeta): void => {
    onPatch({ ...node, ...next } as WorkflowNode, meta)
  }
  const patchParam = (name: CodeHostField, value: string, label: string): void => {
    patch(
      { params: { ...params, [name]: value } },
      continuousNodeInspectorChange(node.id, 'code-host-params', label),
    )
  }

  // 上游端口名 = 可用的 {{port}} 变量（与校验器同源：入边的 target portName）。
  const inboundPorts = definition.edges
    .filter((edge) => edge.target.nodeId === node.id)
    .map((edge) => edge.target.portName)
  const uniqueInbound = [...new Set(inboundPorts)].sort()

  const actionOptions = codeHostActionsByGroup().flatMap(({ group, actions }) =>
    actions.map((value) => {
      const binding = CODE_HOST_ACTION_DEFS[value].bindings[provider]
      const unsupported = isUnsupportedBinding(binding)
      const actionKey = value.replace('.', '_')
      return {
        value,
        label: t(`codeHostAction.${actionKey}`, { defaultValue: value }),
        group: t(`codeHostActionGroup.${group}`, { defaultValue: group }),
        disabled: unsupported,
        description: unsupported
          ? t(`codeHostUnsupported.${binding.reasonKey}`, {
              defaultValue: t('codeHostInspector.unsupportedGeneric'),
            })
          : t(`codeHostActionDescription.${actionKey}`, {
              defaultValue: t('codeHostInspector.actionHint'),
            }),
      }
    }),
  )
  const selectedActionDescription =
    actionOptions.find((option) => option.value === action)?.description ??
    t('codeHostInspector.actionHint')

  const fields = codeHostActionSupported(action, provider)
    ? codeHostActionFields(action, provider)
    : []
  const templateTargets: TemplateTarget[] =
    action === 'custom'
      ? [
          {
            key: 'request:path',
            label: t('codeHostInspector.path'),
            value: request.path,
            commit: (path) =>
              patch(
                { request: { ...request, path } },
                continuousNodeInspectorChange(
                  node.id,
                  'code-host-request',
                  t('codeHostInspector.path'),
                ),
              ),
          },
          {
            key: 'request:body',
            label: t('codeHostInspector.body'),
            value: request.body ?? '',
            commit: (body) =>
              patch(
                { request: { ...request, body } },
                continuousNodeInspectorChange(
                  node.id,
                  'code-host-request',
                  t('codeHostInspector.body'),
                ),
              ),
          },
        ]
      : fields
          .filter((field) => field.control !== 'select')
          .map((field) => {
            const label = t(`codeHostField.${field.name}`, { defaultValue: field.name })
            return {
              key: `param:${field.name}`,
              label,
              value: params[field.name] ?? '',
              commit: (next: string) => patchParam(field.name, next, label),
            }
          })
  const activeTemplateTarget =
    templateTargets.find((target) => target.key === focusedTemplateTargetKey) ?? templateTargets[0]
  const bindTemplateInput = (key: string) => (el: TemplateInput | null) => {
    if (el === null) templateInputRefs.current.delete(key)
    else templateInputRefs.current.set(key, el)
  }
  const insertTemplateToken = (token: string): void => {
    if (!canAuthor || activeTemplateTarget === undefined) return
    applyTemplateVarInsertion(
      templateInputRefs.current.get(activeTemplateTarget.key) ?? null,
      activeTemplateTarget.value,
      token,
      activeTemplateTarget.commit,
    )
  }
  const triggerVariableGroups = WEBHOOK_VAR_GROUPS.map((group) => ({
    label: t(
      group.key === 'api'
        ? 'webhookTriggers.fields.varGroupApi'
        : 'webhookTriggers.fields.varGroupContext',
    ),
    vars: group.vars
      .filter((name) => (TRIGGER_CONTEXT_VARS as readonly string[]).includes(name))
      .map((name) => `trigger.${name}`),
  }))

  return (
    <>
      {!canAuthor ? (
        <ErrorBanner error={null} message={t('codeHostInspector.readonlyBanner')} />
      ) : null}

      <InspectorSection title={t('inspector.sectionBasics')}>
        <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
        <Field
          label={t('codeHostInspector.provider')}
          hint={t('codeHostInspector.providerHint')}
          group
        >
          <div className="inspector__resource-reference">
            <div className="inspector__resource-reference-picker">
              <Segmented<CodeHostProvider>
                value={provider}
                ariaLabel={t('codeHostInspector.provider')}
                testidPrefix="code-host-provider"
                disabled={!canAuthor}
                options={PROVIDERS.map((value) => ({
                  value,
                  label: t(`codeHostProvider.${value}`, { defaultValue: value }),
                }))}
                onChange={(value) => {
                  patch(
                    { provider: value },
                    atomicNodeInspectorChange(
                      node.id,
                      'code-host-params',
                      t('codeHostInspector.provider'),
                    ),
                  )
                }}
              />
            </div>
            <a
              href="/settings?tab=codeHosts"
              target="_blank"
              rel="noreferrer"
              className="btn btn--sm btn--ghost inspector__resource-reference-link"
              aria-label={t('codeHostInspector.manageConnectionsAria')}
              title={t('codeHostInspector.manageConnectionsAria')}
              data-testid="code-host-manage-connections"
            >
              {t('codeHostInspector.manageConnections')}
              <span aria-hidden="true">↗</span>
            </a>
          </div>
        </Field>
        <Field label={t('codeHostInspector.action')} hint={selectedActionDescription} group>
          <Select
            value={action}
            options={actionOptions}
            disabled={!canAuthor}
            searchable
            ariaLabel={t('codeHostInspector.action')}
            data-testid="code-host-action"
            onChange={(value) => {
              patch(
                { action: value },
                atomicNodeInspectorChange(
                  node.id,
                  'code-host-params',
                  t('codeHostInspector.action'),
                ),
              )
            }}
          />
        </Field>
      </InspectorSection>

      {action === 'custom' ? (
        <InspectorSection title={t('codeHostInspector.sectionCustom')}>
          <Field label={t('codeHostInspector.method')} group>
            <Select
              value={request.method}
              options={CODE_HOST_METHODS.filter((m) => m !== 'DELETE' || allowDestructive).map(
                (value) => ({ value, label: value }),
              )}
              disabled={!canAuthor}
              ariaLabel={t('codeHostInspector.method')}
              data-testid="code-host-method"
              onChange={(value) => {
                patch(
                  { request: { ...request, method: value } },
                  atomicNodeInspectorChange(
                    node.id,
                    'code-host-request',
                    t('codeHostInspector.method'),
                  ),
                )
              }}
            />
          </Field>
          <InspectorFieldAnchor nodeId={node.id} field="code-host-request">
            <Field label={t('codeHostInspector.path')} hint={t('codeHostInspector.pathHint')}>
              <TextInput
                value={request.path}
                disabled={!canAuthor}
                data-testid="code-host-path"
                inputRef={bindTemplateInput('request:path')}
                onFocus={() => setFocusedTemplateTargetKey('request:path')}
                onChange={(next) => {
                  patch(
                    { request: { ...request, path: next } },
                    continuousNodeInspectorChange(
                      node.id,
                      'code-host-request',
                      t('codeHostInspector.path'),
                    ),
                  )
                }}
              />
            </Field>
          </InspectorFieldAnchor>
          <Field label={t('codeHostInspector.body')} hint={t('codeHostInspector.bodyHint')}>
            <TextArea
              value={request.body ?? ''}
              monospace
              rows={6}
              disabled={!canAuthor}
              data-testid="code-host-body"
              textareaRef={bindTemplateInput('request:body')}
              onFocus={() => setFocusedTemplateTargetKey('request:body')}
              onChange={(next) => {
                patch(
                  { request: { ...request, body: next } },
                  continuousNodeInspectorChange(
                    node.id,
                    'code-host-request',
                    t('codeHostInspector.body'),
                  ),
                )
              }}
            />
          </Field>
          <Field
            label={t('codeHostInspector.allowDestructive')}
            hint={t('codeHostInspector.allowDestructiveHint')}
            group
          >
            <Switch
              checked={allowDestructive}
              disabled={!canAuthor}
              data-testid="code-host-allow-destructive"
              onChange={(checked) => {
                patch(
                  {
                    allowDestructive: checked,
                    ...(!checked && request.method === 'DELETE'
                      ? { request: { ...request, method: 'GET' } }
                      : {}),
                  },
                  atomicNodeInspectorChange(
                    node.id,
                    'code-host-request',
                    t('codeHostInspector.allowDestructive'),
                  ),
                )
              }}
            />
          </Field>
        </InspectorSection>
      ) : (
        <InspectorSection title={t('codeHostInspector.sectionParams')}>
          {!codeHostActionSupported(action, provider) ? (
            <ErrorBanner error={null} message={t('codeHostInspector.actionUnsupported')} />
          ) : null}
          {fields.map((field) => {
            const required = field.requiredFor.includes(provider)
            const value = params[field.name] ?? ''
            const label = t(`codeHostField.${field.name}`, { defaultValue: field.name })
            const hint = t(`codeHostFieldHint.${field.name}`, { defaultValue: '' })
            const common = {
              disabled: !canAuthor,
              'data-testid': `code-host-field-${field.name}`,
            }
            return (
              <InspectorFieldAnchor key={field.name} nodeId={node.id} field="code-host-params">
                <Field label={label} hint={hint.length > 0 ? hint : undefined} required={required}>
                  {field.control === 'select' ? (
                    <Select
                      value={value}
                      options={('options' in field ? (field.options ?? []) : []).map((opt) => ({
                        value: opt,
                        label: t(`codeHostOption.${opt}`, { defaultValue: opt }),
                      }))}
                      disabled={!canAuthor}
                      ariaLabel={label}
                      data-testid={`code-host-field-${field.name}`}
                      onChange={(next) => {
                        patchParam(field.name, next, label)
                      }}
                    />
                  ) : field.control === 'textarea' ? (
                    <TextArea
                      value={value}
                      rows={4}
                      {...common}
                      textareaRef={bindTemplateInput(`param:${field.name}`)}
                      onFocus={() => setFocusedTemplateTargetKey(`param:${field.name}`)}
                      onChange={(next) => {
                        patchParam(field.name, next, label)
                      }}
                    />
                  ) : (
                    <TextInput
                      value={value}
                      {...common}
                      inputRef={bindTemplateInput(`param:${field.name}`)}
                      onFocus={() => setFocusedTemplateTargetKey(`param:${field.name}`)}
                      onChange={(next) => {
                        patchParam(field.name, next, label)
                      }}
                    />
                  )}
                </Field>
              </InspectorFieldAnchor>
            )
          })}
        </InspectorSection>
      )}

      <InspectorSection title={t('codeHostInspector.sectionVars')} collapsed>
        <p className="inspector-hint" data-testid="code-host-vars-target">
          {activeTemplateTarget === undefined
            ? t('codeHostInspector.varsNoTarget')
            : t('codeHostInspector.varsInsertHint', { field: activeTemplateTarget.label })}
        </p>
        <div className="template-var-chips" data-testid="code-host-port-vars">
          {uniqueInbound.length === 0 ? (
            <span className="inspector-hint">{t('codeHostInspector.noInboundPorts')}</span>
          ) : (
            <TemplateVarChips
              vars={uniqueInbound}
              label={t('codeHostInspector.varsHint')}
              onInsert={insertTemplateToken}
              testidPrefix="code-host-port-var"
              disabled={!canAuthor || activeTemplateTarget === undefined}
            />
          )}
        </div>
        <div className="template-var-chips" data-testid="code-host-trigger-vars">
          <TemplateVarChips
            groups={triggerVariableGroups}
            label={t('codeHostInspector.triggerVarsHint')}
            onInsert={insertTemplateToken}
            testidPrefix="code-host-trigger-var"
            disabled={!canAuthor || activeTemplateTarget === undefined}
            titleOf={(name) => {
              const variable = name.startsWith('trigger.') ? name.slice('trigger.'.length) : name
              return t(`webhookTriggers.fields.vars.${variable}`, { defaultValue: variable })
            }}
          />
        </div>
      </InspectorSection>
    </>
  )
}
