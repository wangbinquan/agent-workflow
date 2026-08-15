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

import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CODE_HOST_ACTION_DEFS,
  CODE_HOST_METHODS,
  codeHostJsonBodyIssue,
  codeHostActionFields,
  codeHostActionSupported,
  codeHostActionsByGroup,
  isCodeHostAction,
  isUnsupportedBinding,
  projectCodeHostTemplates,
  type CodeHostAction,
  type CodeHostField,
  type CodeHostMethod,
  type CodeHostProvider,
  type RuntimeTemplateAuthorityKey,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { ConfirmButton } from '@/components/ConfirmButton'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, Switch, TextArea, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { RuntimeParameterPicker } from '@/components/RuntimeParameterPicker'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { buildRuntimeParameterCatalog } from '@/components/runtime-parameters/catalog'
import type { RuntimeParameterTargetMode } from '@/components/runtime-parameters/target'
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
  commit: (next: string) => void
}

interface InboundBinding {
  portName: string
  sources: string[]
  token: string
}

interface InactiveTemplateValue {
  key: string
  path: string
  value: string
  clear: () => void
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
  const patchParamAtomic = (name: CodeHostField, value: string, label: string): void => {
    patch(
      { params: { ...params, [name]: value } },
      atomicNodeInspectorChange(node.id, 'code-host-params', label),
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
  const parameterCatalog = buildRuntimeParameterCatalog(
    {
      audience: 'workflow-inspector',
      surface: 'code-host',
      t,
    },
    {
      local: inboundBindings.map((binding) => ({
        id: `local:node:${node.id}:input:${binding.portName}`,
        source: 'current-node',
        field: binding.portName,
        token: binding.token,
        label: t('runtimeParameters.localInputLabel', { port: binding.portName }),
        description: t('runtimeParameters.localInputDescription'),
        aliases: binding.sources,
      })),
    },
  )

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
                atomicNodeInspectorChange(
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
                atomicNodeInspectorChange(
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
            commit: (next: string) =>
              patch(
                { request: { ...request, query: { ...request.query, [queryKey]: next } } },
                atomicNodeInspectorChange(
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
            commit: (next: string) => patchParamAtomic(field.name, next, label),
          }
        })
  const bindTemplateInput = (key: string) => (el: TemplateInput | null) => {
    if (el === null) templateInputRefs.current.delete(key)
    else templateInputRefs.current.set(key, el)
  }
  const removeInputFromTarget = (binding: InboundBinding, target: TemplateTarget): void => {
    target.commit(target.value.split(binding.token).join(''))
  }
  const unboundInputCount = inboundBindings.filter(
    (binding) => !templateTargets.some((target) => target.value.includes(binding.token)),
  ).length
  const inputGuideState =
    inboundBindings.length === 0 ? 'empty' : unboundInputCount > 0 ? 'unbound' : 'bound'
  const inputGuideTone =
    inputGuideState === 'bound' ? 'success' : inputGuideState === 'unbound' ? 'warning' : 'info'
  const inputGuideTitle =
    inputGuideState === 'empty'
      ? t('codeHostInspector.inputGuideEmptyTitle')
      : inputGuideState === 'unbound'
        ? t('codeHostInspector.inputGuideUnboundTitle', { count: unboundInputCount })
        : t('codeHostInspector.inputGuideBoundTitle')
  const inputGuideBody =
    inputGuideState === 'empty'
      ? t('codeHostInspector.inputGuideEmpty')
      : inputGuideState === 'unbound'
        ? t('codeHostInspector.inputGuideUnbound')
        : t('codeHostInspector.inputGuideBound')

  const activeTemplateKeys = new Set(
    projectCodeHostTemplates(node).active.map((entry) => entry.key),
  )
  const inactiveTemplateValues: InactiveTemplateValue[] = [
    ...Object.entries(params).map(([name, value]) => ({
      key: `param:${name}`,
      path: `params.${name}`,
      value,
      clear: () => {
        const nextParams = { ...params }
        delete nextParams[name]
        patch(
          { params: nextParams },
          atomicNodeInspectorChange(
            node.id,
            'code-host-params',
            t('codeHostInspector.clearInactiveHistory', { path: `params.${name}` }),
          ),
        )
      },
    })),
    {
      key: 'request:path',
      path: 'request.path',
      value: request.path,
      clear: () =>
        patch(
          { request: { ...request, path: '' } },
          atomicNodeInspectorChange(
            node.id,
            'code-host-request',
            t('codeHostInspector.clearInactiveHistory', { path: 'request.path' }),
          ),
        ),
    },
    ...Object.entries(request.query).map(([queryKey, value]) => ({
      key: `request:query:${queryKey}`,
      path: `request.query.${queryKey}`,
      value,
      clear: () => {
        const nextQuery = { ...request.query }
        delete nextQuery[queryKey]
        patch(
          { request: { ...request, query: nextQuery } },
          atomicNodeInspectorChange(
            node.id,
            'code-host-request',
            t('codeHostInspector.clearInactiveHistory', { path: `request.query.${queryKey}` }),
          ),
        )
      },
    })),
    {
      key: 'request:body',
      path: 'request.body',
      value: request.body ?? '',
      clear: () => {
        const nextRequest = { ...request }
        delete nextRequest.body
        patch(
          { request: nextRequest },
          atomicNodeInspectorChange(
            node.id,
            'code-host-request',
            t('codeHostInspector.clearInactiveHistory', { path: 'request.body' }),
          ),
        )
      },
    },
  ].filter((entry) => entry.value.length > 0 && !activeTemplateKeys.has(entry.key))

  const parameterPicker = (
    authority: RuntimeTemplateAuthorityKey,
    key: string,
    label: string,
    value: string,
    mode: RuntimeParameterTargetMode,
    commit: (next: string) => void,
    validateNext?: (next: string) => string | null,
  ) => (
    <RuntimeParameterPicker
      authority={authority}
      entries={parameterCatalog}
      target={{
        id: `${node.id}:${key}`,
        label,
        mode,
        value,
        revision: value,
        element: () => templateInputRefs.current.get(key) ?? null,
        commit,
        validateNext,
      }}
      testId={`code-host-runtime-parameter-${key.replaceAll(':', '-')}`}
    />
  )

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
            {/* RFC-270/RFC-305 — 配置入口只由 `settings:read` 决定；
                `code-host-calls:author` 不能替代该权限。 */}
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
        {inactiveTemplateValues.length > 0 ? (
          <NoticeBanner
            tone="warning"
            size="compact"
            title={t('codeHostInspector.inactiveValuesTitle', {
              count: inactiveTemplateValues.length,
            })}
            testid="code-host-inactive-values"
          >
            <p>{t('codeHostInspector.inactiveValuesBody')}</p>
            <ul className="code-host-inactive-values">
              {inactiveTemplateValues.map((entry) => (
                <li
                  className="code-host-inactive-values__item"
                  key={entry.key}
                  data-testid={`code-host-inactive-value-${entry.key.replaceAll(':', '-')}`}
                >
                  <span className="code-host-inactive-values__value">
                    <code>{entry.path}</code>
                    <code title={entry.value}>{entry.value}</code>
                  </span>
                  <ConfirmButton
                    size="sm"
                    variant="danger"
                    label={t('codeHostInspector.clearInactive')}
                    confirmLabel={t('codeHostInspector.confirmClearInactive')}
                    ariaLabel={t('codeHostInspector.clearInactiveAria', { path: entry.path })}
                    confirmAriaLabel={t('codeHostInspector.confirmClearInactiveAria', {
                      path: entry.path,
                    })}
                    confirmationKey={JSON.stringify([
                      node.id,
                      provider,
                      action,
                      entry.key,
                      entry.value,
                    ])}
                    onConfirm={entry.clear}
                    data-testid={`code-host-clear-inactive-${entry.key.replaceAll(':', '-')}`}
                  />
                </li>
              ))}
            </ul>
          </NoticeBanner>
        ) : null}
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
            <p className="inspector-hint">{t('codeHostInspector.inputBindingAdvancedHint')}</p>
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
            <Field
              label={t('codeHostInspector.path')}
              hint={t('codeHostInspector.pathHint')}
              action={parameterPicker(
                'workflow:http-path',
                'request:path',
                t('codeHostInspector.path'),
                request.path,
                'insert-at-caret',
                (path) =>
                  patch(
                    { request: { ...request, path } },
                    atomicNodeInspectorChange(
                      node.id,
                      'code-host-request',
                      t('codeHostInspector.path'),
                    ),
                  ),
              )}
              group
            >
              <TextInput
                value={request.path}
                data-testid="code-host-path"
                aria-label={t('codeHostInspector.path')}
                inputRef={bindTemplateInput('request:path')}
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
          <Field label={t('codeHostInspector.query')} hint={t('codeHostInspector.queryHint')} group>
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
                    <Field
                      label={t('codeHostInspector.queryValue', { key: queryKey })}
                      action={parameterPicker(
                        'workflow:http-query',
                        `request:query:${queryKey}`,
                        t('codeHostInspector.queryValue', { key: queryKey }),
                        queryValue,
                        'insert-at-caret',
                        (nextValue) =>
                          patch(
                            {
                              request: {
                                ...request,
                                query: { ...request.query, [queryKey]: nextValue },
                              },
                            },
                            atomicNodeInspectorChange(
                              node.id,
                              'code-host-request',
                              t('codeHostInspector.query'),
                            ),
                          ),
                      )}
                      group
                    >
                      <TextInput
                        value={queryValue}
                        aria-label={t('codeHostInspector.queryValue', { key: queryKey })}
                        data-testid={`code-host-query-value-${queryKey}`}
                        inputRef={bindTemplateInput(`request:query:${queryKey}`)}
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
                    </Field>
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      aria-label={t('codeHostInspector.removeQuery', { key: queryKey })}
                      onClick={() => {
                        const nextQuery = { ...request.query }
                        delete nextQuery[queryKey]
                        templateInputRefs.current.delete(`request:query:${queryKey}`)
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
                }}
              >
                {t('codeHostInspector.addQuery')}
              </button>
            </div>
          </Field>
          <Field
            label={t('codeHostInspector.body')}
            hint={t('codeHostInspector.bodyHint')}
            action={parameterPicker(
              'workflow:http-json-body',
              'request:body',
              t('codeHostInspector.body'),
              request.body ?? '',
              'insert-at-caret',
              (body) =>
                patch(
                  { request: { ...request, body } },
                  atomicNodeInspectorChange(
                    node.id,
                    'code-host-request',
                    t('codeHostInspector.body'),
                  ),
                ),
              (next) =>
                codeHostJsonBodyIssue(next) === null
                  ? null
                  : t('runtimeParameters.invalidJsonTarget'),
            )}
            group
          >
            <TextArea
              value={request.body ?? ''}
              monospace
              rows={6}
              data-testid="code-host-body"
              aria-label={t('codeHostInspector.body')}
              textareaRef={bindTemplateInput('request:body')}
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
            const selectOptions = ('options' in field ? (field.options ?? []) : []).map((opt) => ({
              value: opt,
              label: t('codeHostOption.' + opt, { defaultValue: opt }),
            }))
            const label = t(`codeHostField.${field.name}`, { defaultValue: field.name })
            const hint = t(`codeHostFieldHint.${field.name}`, { defaultValue: '' })
            const common = {
              'data-testid': `code-host-field-${field.name}`,
            }
            return (
              <InspectorFieldAnchor key={field.name} nodeId={node.id} field="code-host-params">
                <Field
                  label={label}
                  hint={hint.length > 0 ? hint : undefined}
                  required={required}
                  action={parameterPicker(
                    'workflow:http-param',
                    `param:${field.name}`,
                    label,
                    value,
                    field.control === 'select' ? 'replace-whole-value' : 'insert-at-caret',
                    (next) => patchParamAtomic(field.name, next, label),
                  )}
                  group
                >
                  {field.control === 'select' ? (
                    <Select
                      value={value}
                      options={selectOptions}
                      searchable={selectOptions.length > 8}
                      ariaLabel={label}
                      data-testid={`code-host-field-${field.name}`}
                      renderUnknownValue={
                        value.includes('{{') ? (savedValue) => <code>{savedValue}</code> : undefined
                      }
                      onChange={(next) => {
                        patchParam(field.name, next, label)
                      }}
                    />
                  ) : field.control === 'textarea' ? (
                    <TextArea
                      value={value}
                      rows={4}
                      {...common}
                      aria-label={label}
                      textareaRef={bindTemplateInput(`param:${field.name}`)}
                      onChange={(next) => {
                        patchParam(field.name, next, label)
                      }}
                    />
                  ) : (
                    <TextInput
                      value={value}
                      {...common}
                      aria-label={label}
                      inputRef={bindTemplateInput(`param:${field.name}`)}
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
    </>
  )
}
