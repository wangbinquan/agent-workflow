import { useState } from 'react'
import {
  GraphDesignDocumentSchema,
  type GraphDesignDocument,
  type GraphObligation,
} from '@agent-workflow/shared'
import { Dialog } from '@/components/Dialog'
import { Field, TextArea, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { NoticeBanner } from '@/components/NoticeBanner'
import { ErrorBanner } from '@/components/ErrorBanner'
import { graphDocumentChanges, type GraphVerificationProfile } from './graphDesignModel'

export function GraphDesignEditDialog({
  document,
  selectedIds,
  profiles,
  onSave,
  onClose,
  busy,
  zh,
  saveError,
}: {
  document: GraphDesignDocument
  selectedIds: string[]
  profiles: GraphVerificationProfile[]
  onSave(value: GraphDesignDocument): Promise<boolean>
  onClose(): void
  busy: boolean
  zh: boolean
  saveError?: unknown
}) {
  // The snapshot stays intact when live updates arrive or saving reports a conflict.
  const [draft, setDraft] = useState(() => structuredClone(document))
  const [preview, setPreview] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [source, setSource] = useState(JSON.stringify(document, null, 2))
  const [error, setError] = useState<unknown>(null)
  const changes = graphDocumentChanges(document, draft)
  const update = (change: (value: GraphDesignDocument) => void) =>
    setDraft((previous) => {
      const next = structuredClone(previous)
      change(next)
      return next
    })
  return (
    <Dialog
      open
      onClose={onClose}
      title={zh ? '修改设计并预览影响' : 'Edit design and preview changes'}
      size="lg"
      dismissDisabled={busy}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {zh ? '取消' : 'Cancel'}
          </button>
          {preview ? (
            <>
              <button type="button" className="btn" onClick={() => setPreview(false)}>
                {zh ? '继续编辑' : 'Edit'}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || !changes.length}
                onClick={() =>
                  void onSave(draft).then((saved) => {
                    if (saved) onClose()
                  })
                }
              >
                {zh ? '保存这些修改' : 'Save these changes'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => {
                try {
                  if (advanced) setDraft(GraphDesignDocumentSchema.parse(JSON.parse(source)))
                  setError(null)
                  setPreview(true)
                } catch (error) {
                  setError(error)
                }
              }}
            >
              {zh ? '预览修改' : 'Preview changes'}
            </button>
          )}
        </>
      }
    >
      <div className="graph-design graph-design__stack">
        <NoticeBanner tone="info">
          {zh
            ? `基于版本 ${document.revision}。保存会重新检查版本；冲突时输入保留。人工原话只能从原问题追加澄清。`
            : `Based on revision ${document.revision}. Input is preserved on conflicts. Human answers are changed through their original questions.`}
        </NoticeBanner>
        {error != null && <ErrorBanner error={error} />}
        {saveError != null && <ErrorBanner error={saveError} />}
        {preview ? (
          <>
            <p>
              {zh
                ? `${changes.length} 项内容变更，相关图和证据将重新判定有效性。`
                : `${changes.length} changes; affected views and evidence will be re-evaluated.`}
            </p>
            {changes.map((change) => (
              <section key={change.id}>
                <strong>{change.id}</strong>
                <div className="graph-design__diff">
                  <pre>{change.before}</pre>
                  <pre>{change.after}</pre>
                </div>
              </section>
            ))}
          </>
        ) : (
          <>
            {draft.elements
              .filter((element) => !selectedIds.length || selectedIds.includes(element.id))
              .map((element) => (
                <section key={element.id} className="graph-design__stack">
                  <Field label={zh ? `元素：${element.id}` : `Element: ${element.id}`}>
                    <TextInput
                      value={element.label}
                      onChange={(label) =>
                        update((value) => {
                          value.elements.find((e) => e.id === element.id)!.label = label
                        })
                      }
                    />
                  </Field>
                  <Field label={zh ? '说明' : 'Description'}>
                    <TextArea
                      value={element.description}
                      onChange={(description) =>
                        update((value) => {
                          value.elements.find((e) => e.id === element.id)!.description = description
                        })
                      }
                    />
                  </Field>
                  {element.kind === 'assumption' && (
                    <>
                      <Field label={zh ? '成立条件' : 'Conditions'}>
                        <TextArea
                          value={element.condition}
                          onChange={(condition) =>
                            update((value) => {
                              const item = value.elements.find((e) => e.id === element.id)
                              if (item?.kind === 'assumption') item.condition = condition
                            })
                          }
                        />
                      </Field>
                      <Field label={zh ? '仍未知的内容' : 'Unknowns'}>
                        <TextArea
                          value={element.unknowns}
                          onChange={(unknowns) =>
                            update((value) => {
                              const item = value.elements.find((e) => e.id === element.id)
                              if (item?.kind === 'assumption') item.unknowns = unknowns
                            })
                          }
                        />
                      </Field>
                    </>
                  )}
                </section>
              ))}
            {draft.concerns.map((concern) => (
              <section key={concern.id} className="graph-design__stack">
                <strong>{concern.statement}</strong>
                <Field label={zh ? '重要程度' : 'Priority'}>
                  <Select
                    value={concern.priority}
                    onChange={(priority) =>
                      update((value) => {
                        value.concerns.find((c) => c.id === concern.id)!.priority = priority
                      })
                    }
                    options={[
                      { value: 'required', label: zh ? '必须覆盖' : 'Required' },
                      { value: 'important', label: zh ? '重要' : 'Important' },
                      { value: 'optional', label: zh ? '可选' : 'Optional' },
                    ]}
                  />
                </Field>
                <Field label={zh ? '处理状态' : 'Disposition'}>
                  <Select
                    value={concern.disposition}
                    onChange={(disposition) =>
                      update((value) => {
                        value.concerns.find((c) => c.id === concern.id)!.disposition = disposition
                      })
                    }
                    options={[
                      { value: 'open', label: zh ? '待解决' : 'Open' },
                      { value: 'addressed', label: zh ? '已解决' : 'Addressed' },
                      { value: 'deferred', label: zh ? '暂缓' : 'Deferred' },
                      { value: 'out-of-scope', label: zh ? '不在范围' : 'Out of scope' },
                    ]}
                  />
                </Field>
                <Field label={zh ? '处理理由' : 'Reason'}>
                  <TextArea
                    value={concern.dispositionReason ?? ''}
                    onChange={(reason) =>
                      update((value) => {
                        value.concerns.find((c) => c.id === concern.id)!.dispositionReason = reason
                      })
                    }
                  />
                </Field>
              </section>
            ))}
            {draft.obligations.map((obligation) => {
              const verification = obligation.verification
              const setVerification = (next: GraphObligation['verification']) =>
                update((value) => {
                  value.obligations.find((o) => o.id === obligation.id)!.verification = next
                })
              return (
                <section key={obligation.id} className="graph-design__stack">
                  <strong>{obligation.statement}</strong>
                  <Field label={zh ? '验证方式' : 'Verification'}>
                    <Select
                      value={
                        verification.kind === 'execution'
                          ? verification.profileRef.id
                          : verification.kind
                      }
                      onChange={(key) => {
                        const profile = profiles.find((p) => p.id === key)
                        setVerification(
                          profile
                            ? {
                                kind: 'execution',
                                profileRef: {
                                  id: profile.id,
                                  revision: profile.revision,
                                  digest: profile.digest,
                                },
                                testRefs: [],
                              }
                            : key === 'manual'
                              ? {
                                  kind: 'manual',
                                  instructions: obligation.statement,
                                  owner: null,
                                  when: null,
                                }
                              : { kind: 'unassigned', reason: '' },
                        )
                      }}
                      options={[
                        { value: 'unassigned', label: zh ? '尚未安排' : 'Unassigned' },
                        { value: 'manual', label: zh ? '人工验收' : 'Human acceptance' },
                        ...profiles.map((profile) => ({
                          value: profile.id,
                          label: `${profile.name} · v${profile.revision}`,
                        })),
                      ]}
                    />
                  </Field>
                  {verification.kind === 'execution' && (
                    <Field label={zh ? '测试引用（每行一项）' : 'Test references (one per line)'}>
                      <TextArea
                        value={verification.testRefs.join('\n')}
                        onChange={(value) =>
                          setVerification({
                            ...verification,
                            testRefs: value.split('\n').filter(Boolean),
                          })
                        }
                      />
                    </Field>
                  )}
                  {verification.kind === 'manual' && (
                    <>
                      <Field label={zh ? '验收步骤' : 'Acceptance steps'}>
                        <TextArea
                          value={verification.instructions}
                          onChange={(instructions) =>
                            setVerification({ ...verification, instructions })
                          }
                        />
                      </Field>
                      <Field label={zh ? '负责人（未知可留空）' : 'Owner (leave empty if unknown)'}>
                        <TextInput
                          value={verification.owner ?? ''}
                          onChange={(owner) =>
                            setVerification({ ...verification, owner: owner || null })
                          }
                        />
                      </Field>
                      <Field
                        label={
                          zh ? '复核时间（未知可留空）' : 'Review date (leave empty if unknown)'
                        }
                      >
                        <TextInput
                          value={verification.when ?? ''}
                          onChange={(when) =>
                            setVerification({ ...verification, when: when || null })
                          }
                        />
                      </Field>
                    </>
                  )}
                </section>
              )
            })}
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                setSource(JSON.stringify(draft, null, 2))
                setAdvanced((value) => !value)
              }}
            >
              {zh ? '编辑完整语义模型' : 'Edit the full semantic model'}
            </button>
            {advanced && (
              <Field
                label={
                  zh
                    ? '语义模型（含关系和子模型）'
                    : 'Semantic model (including relations and submodels)'
                }
              >
                <TextArea value={source} onChange={setSource} monospace rows={20} />
              </Field>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
