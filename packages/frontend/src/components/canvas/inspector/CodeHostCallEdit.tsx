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
//   3. **没有 `code-host-calls:author` 时整块不可见**（RFC-270 改判）。初版随
//      RFC-253 的脚本面板做成「整块只读 + 横幅」；RFC-270 把「谁能看」与「谁能
//      写」合并成同一个问题：这里的 path / body / params 就是平台将以管理员
//      token 发出的请求，服务端已经不再把它们下发给无权限的调用方
//      （services/tokenRedaction.ts），面板渲染出来只会是一排 `***`。「不可改」
//      那一半没变，而且现在是构造保证的 —— 没有控件可以输入。

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
  type CodeHostAction,
  type CodeHostField,
  type CodeHostMethod,
  type CodeHostProvider,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, Switch, TextArea, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Segmented } from '@/components/Segmented'
import { Select, type SelectOption } from '@/components/Select'
import {
  applyTemplateVarInsertion,
  TemplateVarChips,
  WebhookTriggerVarChips,
} from '@/components/TemplateVarChips'
import { usePermission } from '@/hooks/useActor'
import { nodeTitle } from '../nodeTitle'
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
  query: Record<string, string>
  body?: string
}

type TemplateInput = HTMLInputElement | HTMLTextAreaElement

interface TemplateTarget {
  key: string
  label: string
  value: string
  allowDirectBinding: boolean
  commit: (next: string) => void
}

interface InboundBinding {
  portName: string
  sources: string[]
  token: string
}

function readRequest(node: WorkflowNode): CustomRequestShape {
  const raw = rec(node).request
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { method: 'GET', path: '', query: {} }
  }
  const r = raw as Record<string, unknown>
  const method =
    typeof r.method === 'string' && (CODE_HOST_METHODS as readonly string[]).includes(r.method)
      ? (r.method as CodeHostMethod)
      : 'GET'
  const query: Record<string, string> = {}
  if (r.query !== null && typeof r.query === 'object' && !Array.isArray(r.query)) {
    for (const [key, value] of Object.entries(r.query as Record<string, unknown>)) {
      if (typeof value === 'string') query[key] = value
    }
  }
  return {
    method,
    path: typeof r.path === 'string' ? r.path : '',
    query,
    ...(typeof r.body === 'string' ? { body: r.body } : {}),
  }
}

export function CodeHostCallEdit({ node, definition, onPatch, onHistoryBoundary }: EditProps) {
  const { t } = useTranslation()
  const canAuthor = usePermission('code-host-calls:author')
  const canManageConnections = usePermission('settings:read')
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

  // 入边的 target portName 才是本节点真正可引用的 {{port}} 名。把 source 与
  // target 同时呈现，避免重命名后的边让作者误拿 source port 猜模板变量。
  const inboundByPort = new Map<string, InboundBinding>()
  for (const edge of definition.edges) {
    if (edge.target.nodeId !== node.id) continue
    const sourceNode = definition.nodes.find((candidate) => candidate.id === edge.source.nodeId)
    const sourceName = sourceNode === undefined ? edge.source.nodeId : nodeTitle(sourceNode)
    const source = [sourceName, edge.source.portName].join(' · ')
    const current = inboundByPort.get(edge.target.portName)
    if (current === undefined) {
      inboundByPort.set(edge.target.portName, {
        portName: edge.target.portName,
        sources: [source],
        token: '{{' + edge.target.portName + '}}',
      })
    } else if (!current.sources.includes(source)) {
      current.sources.push(source)
    }
  }
  const inboundBindings = [...inboundByPort.values()].sort((a, b) =>
    a.portName.localeCompare(b.portName),
  )
  const uniqueInbound = inboundBindings.map((binding) => binding.portName)

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
            allowDirectBinding: true,
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
            // A bare {{port}} is not a valid JSON body skeleton. Authors can
            // still compose it at a deliberate cursor position in Advanced
            // template variables, but the one-click whole-value binding must
            // not manufacture a definition the validator immediately rejects.
            allowDirectBinding: false,
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
          ...Object.entries(request.query).map(([queryKey, value]) => ({
            key: `request:query:${queryKey}`,
            label: `${t('codeHostInspector.query')} · ${queryKey}`,
            value,
            allowDirectBinding: true,
            commit: (next: string) =>
              patch(
                { request: { ...request, query: { ...request.query, [queryKey]: next } } },
                continuousNodeInspectorChange(
                  node.id,
                  'code-host-request',
                  t('codeHostInspector.query'),
                ),
              ),
          })),
        ]
      : fields.map((field) => {
          const label = t(`codeHostField.${field.name}`, { defaultValue: field.name })
          return {
            key: `param:${field.name}`,
            label,
            value: params[field.name] ?? '',
            allowDirectBinding: true,
            commit: (next: string) => patchParam(field.name, next, label),
          }
        })
  const directTemplateTargets = templateTargets.filter((target) => target.allowDirectBinding)
  const activeTemplateTarget = templateTargets.find(
    (target) => target.key === focusedTemplateTargetKey,
  )
  const bindTemplateInput = (key: string) => (el: TemplateInput | null) => {
    if (el === null) templateInputRefs.current.delete(key)
    else templateInputRefs.current.set(key, el)
  }
  const insertTemplateToken = (token: string): void => {
    if (activeTemplateTarget === undefined) return
    applyTemplateVarInsertion(
      templateInputRefs.current.get(activeTemplateTarget.key) ?? null,
      activeTemplateTarget.value,
      token,
      activeTemplateTarget.commit,
    )
  }
  const bindInputToTarget = (binding: InboundBinding, targetKey: string): void => {
    if (targetKey.length === 0) return
    directTemplateTargets.find((target) => target.key === targetKey)?.commit(binding.token)
  }
  const removeInputFromTarget = (binding: InboundBinding, target: TemplateTarget): void => {
    target.commit(target.value.split(binding.token).join(''))
  }
  const unboundInputCount = inboundBindings.filter(
    (binding) => !templateTargets.some((target) => target.value.includes(binding.token)),
  ).length
  const inputGuideState =
    inboundBindings.length === 0
      ? 'empty'
      : directTemplateTargets.length === 0
        ? 'no-target'
        : unboundInputCount > 0
          ? 'unbound'
          : 'bound'
  const inputGuideTone =
    inputGuideState === 'bound'
      ? 'success'
      : inputGuideState === 'unbound' || inputGuideState === 'no-target'
        ? 'warning'
        : 'info'
  const inputGuideTitle =
    inputGuideState === 'empty'
      ? t('codeHostInspector.inputGuideEmptyTitle')
      : inputGuideState === 'no-target'
        ? t('codeHostInspector.inputGuideNoTargetTitle')
        : inputGuideState === 'unbound'
          ? t('codeHostInspector.inputGuideUnboundTitle', { count: unboundInputCount })
          : t('codeHostInspector.inputGuideBoundTitle')
  const inputGuideBody =
    inputGuideState === 'empty'
      ? t('codeHostInspector.inputGuideEmpty')
      : inputGuideState === 'no-target'
        ? t('codeHostInspector.inputGuideNoTarget')
        : inputGuideState === 'unbound'
          ? t('codeHostInspector.inputGuideUnbound')
          : t('codeHostInspector.inputGuideBound')

  // RFC-270 — 无权限就不渲染面板：下面每个字段读的都是服务端已经遮蔽过的值。
  if (!canAuthor) {
    return (
      <EmptyState
        title={t('codeHostInspector.noViewPermission.title')}
        description={t('codeHostInspector.noViewPermission.body')}
        size="compact"
        data-testid="code-host-inspector-no-view-permission"
      />
    )
  }

  return (
    <>
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
            {/* RFC-270 — 这个入口通向 admin-only 的配置页。它对**有**
                `code-host-calls:author` 却**无** `settings:read` 的人可见，
                也就是 manager（`MANAGER_DENIED_PERMISSIONS` 显式拒了
                `settings:read`）——正是今天点进去只会吃 403 的那批人。 */}
            {canManageConnections ? (
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
            ) : null}
          </div>
        </Field>
        <Field label={t('codeHostInspector.action')} hint={selectedActionDescription} group>
          <Select
            value={action}
            options={actionOptions}
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

      <InspectorSection title={t('codeHostInspector.sectionInputs')}>
        <NoticeBanner
          tone={inputGuideTone}
          size="compact"
          title={inputGuideTitle}
          testid="code-host-input-guide"
        >
          {inputGuideBody}
        </NoticeBanner>
        {inboundBindings.length > 0 ? (
          <div className="code-host-input-bindings" data-testid="code-host-input-bindings">
            {inboundBindings.map((binding) => {
              const usedTargets = templateTargets.filter((target) =>
                target.value.includes(binding.token),
              )
              return (
                <div
                  className="code-host-input-binding"
                  key={binding.portName}
                  data-testid={'code-host-input-binding-' + binding.portName}
                >
                  <div className="code-host-input-binding__route">
                    <span
                      className="code-host-input-binding__source"
                      title={binding.sources.join(' + ')}
                    >
                      {binding.sources.join(' + ')}
                    </span>
                    <span className="code-host-input-binding__arrow" aria-hidden="true">
                      →
                    </span>
                    <code
                      className="code-host-input-binding__token"
                      data-testid={'code-host-input-token-' + binding.portName}
                    >
                      {binding.token}
                    </code>
                  </div>
                  <Select<string>
                    value=""
                    ariaLabel={t('codeHostInspector.bindTargetAria', {
                      port: binding.portName,
                    })}
                    data-testid={'code-host-input-target-' + binding.portName}
                    disabled={directTemplateTargets.length === 0}
                    onChange={(targetKey) => bindInputToTarget(binding, targetKey)}
                    options={[
                      {
                        value: '',
                        label: t('codeHostInspector.bindTargetPlaceholder'),
                        disabled: true,
                      },
                      ...directTemplateTargets.map((target) => ({
                        value: target.key,
                        label: target.label,
                        disabled: target.value.includes(binding.token),
                        description:
                          target.value.trim().length === 0
                            ? t('codeHostInspector.bindTargetEmpty')
                            : t('codeHostInspector.bindTargetReplace'),
                      })),
                    ]}
                  />
                  {usedTargets.length > 0 ? (
                    <div
                      className="code-host-input-binding__uses"
                      aria-label={t('codeHostInspector.boundTargets')}
                    >
                      <span>{t('codeHostInspector.boundTargets')}</span>
                      {usedTargets.map((target) => (
                        <button
                          type="button"
                          className="btn btn--xs btn--ghost code-host-input-binding__unlink"
                          key={target.key}
                          aria-label={t('codeHostInspector.removeBindingAria', {
                            port: binding.portName,
                            field: target.label,
                          })}
                          onClick={() => removeInputFromTarget(binding, target)}
                        >
                          {target.label}
                          <span aria-hidden="true"> ×</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
            <p className="inspector-hint">{t('codeHostInspector.inputBindingAdvancedHint')}</p>
          </div>
        ) : null}
      </InspectorSection>

      {action === 'custom' ? (
        <InspectorSection title={t('codeHostInspector.sectionCustom')}>
          <Field label={t('codeHostInspector.method')} group>
            <Select
              value={request.method}
              options={CODE_HOST_METHODS.filter((m) => m !== 'DELETE' || allowDestructive).map(
                (value) => ({ value, label: value }),
              )}
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
          <Field label={t('codeHostInspector.query')} hint={t('codeHostInspector.queryHint')}>
            <div className="form-grid" data-testid="code-host-query-list">
              {Object.entries(request.query).map(([queryKey, queryValue]) => (
                <div className="form-grid--cols-2" key={queryKey}>
                  <TextInput
                    value={queryKey}
                    aria-label={t('codeHostInspector.queryKey')}
                    data-testid={`code-host-query-key-${queryKey}`}
                    onChange={(nextKey) => {
                      if (
                        nextKey === queryKey ||
                        nextKey.trim().length === 0 ||
                        Object.prototype.hasOwnProperty.call(request.query, nextKey)
                      ) {
                        return
                      }
                      const nextQuery: Record<string, string> = {}
                      for (const [key, value] of Object.entries(request.query)) {
                        nextQuery[key === queryKey ? nextKey : key] = value
                      }
                      patch(
                        { request: { ...request, query: nextQuery } },
                        continuousNodeInspectorChange(
                          node.id,
                          'code-host-request',
                          t('codeHostInspector.query'),
                        ),
                      )
                    }}
                  />
                  <div className="form-grid--cols-2">
                    <TextInput
                      value={queryValue}
                      aria-label={t('codeHostInspector.queryValue', { key: queryKey })}
                      data-testid={`code-host-query-value-${queryKey}`}
                      inputRef={bindTemplateInput(`request:query:${queryKey}`)}
                      onFocus={() => setFocusedTemplateTargetKey(`request:query:${queryKey}`)}
                      onChange={(nextValue) => {
                        patch(
                          {
                            request: {
                              ...request,
                              query: { ...request.query, [queryKey]: nextValue },
                            },
                          },
                          continuousNodeInspectorChange(
                            node.id,
                            'code-host-request',
                            t('codeHostInspector.query'),
                          ),
                        )
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      aria-label={t('codeHostInspector.removeQuery', { key: queryKey })}
                      onClick={() => {
                        const nextQuery = { ...request.query }
                        delete nextQuery[queryKey]
                        templateInputRefs.current.delete(`request:query:${queryKey}`)
                        setFocusedTemplateTargetKey((current) =>
                          current === `request:query:${queryKey}` ? null : current,
                        )
                        patch(
                          { request: { ...request, query: nextQuery } },
                          atomicNodeInspectorChange(
                            node.id,
                            'code-host-request',
                            t('codeHostInspector.query'),
                          ),
                        )
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                data-testid="code-host-query-add"
                onClick={() => {
                  let index = Object.keys(request.query).length + 1
                  let key = `param${index}`
                  while (Object.prototype.hasOwnProperty.call(request.query, key)) {
                    index += 1
                    key = `param${index}`
                  }
                  patch(
                    { request: { ...request, query: { ...request.query, [key]: '' } } },
                    atomicNodeInspectorChange(
                      node.id,
                      'code-host-request',
                      t('codeHostInspector.query'),
                    ),
                  )
                  setFocusedTemplateTargetKey(`request:query:${key}`)
                }}
              >
                {t('codeHostInspector.addQuery')}
              </button>
            </div>
          </Field>
          <Field label={t('codeHostInspector.body')} hint={t('codeHostInspector.bodyHint')}>
            <TextArea
              value={request.body ?? ''}
              monospace
              rows={6}
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
            const selectOptions: SelectOption<string>[] = (
              'options' in field ? (field.options ?? []) : []
            ).map((opt) => ({
              value: opt,
              label: t('codeHostOption.' + opt, { defaultValue: opt }),
            }))
            for (const binding of inboundBindings) {
              selectOptions.push({
                value: binding.token,
                label: binding.token,
                group: t('codeHostInspector.upstreamOptionGroup'),
                description: t('codeHostInspector.upstreamOptionDescription', {
                  source: binding.sources.join(' + '),
                }),
              })
            }
            if (
              field.control === 'select' &&
              value.includes('{{') &&
              !selectOptions.some((option) => option.value === value)
            ) {
              selectOptions.push({
                value,
                label: value,
                group: t('codeHostInspector.savedTemplateOptionGroup'),
                description: t('codeHostInspector.savedTemplateOptionDescription'),
              })
            }
            const label = t(`codeHostField.${field.name}`, { defaultValue: field.name })
            const hint = t(`codeHostFieldHint.${field.name}`, { defaultValue: '' })
            const common = {
              'data-testid': `code-host-field-${field.name}`,
            }
            return (
              <InspectorFieldAnchor key={field.name} nodeId={node.id} field="code-host-params">
                <Field label={label} hint={hint.length > 0 ? hint : undefined} required={required}>
                  {field.control === 'select' ? (
                    <Select
                      value={value}
                      options={selectOptions}
                      searchable={selectOptions.length > 8}
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
              disabled={activeTemplateTarget === undefined}
            />
          )}
        </div>
        <div className="template-var-chips" data-testid="code-host-trigger-vars">
          <WebhookTriggerVarChips
            label={t('codeHostInspector.triggerVarsHint')}
            onInsert={insertTemplateToken}
            testidPrefix="code-host-trigger-var"
            disabled={activeTemplateTarget === undefined}
          />
        </div>
      </InspectorSection>
    </>
  )
}
