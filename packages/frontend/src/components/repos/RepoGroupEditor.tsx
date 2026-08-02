// RFC-248 T36 —— 仓库组编辑器。
//
// 严格复用公共原语（CLAUDE.md 强制条款）：`<Dialog>` 出 modal chrome、
// `<Field>` / `<TextInput>` / `<TextArea>` / `<Switch>` 出表单、`<Select>` 出
// 下拉（**不用**原生 `<select>`）、`<StatusChip>` 出标记、`<ErrorBanner>` 出
// 错误。本文件不自写任何 overlay / panel / border / focus ring。
//
// 右侧是**实时布局预览**：成员表每次变动 debounce 400ms 打一次
// `POST /api/repo-groups/preview`（纯读干跑，不导入任何仓）。预览用的是服务端
// 真正的展平实现，所以组套组 / 深度上限 / 循环 / 只读并集 / 挂载点冲突全都按
// 真实语义报出来——而不是前端另写一套近似逻辑，然后在保存时才发现两边不一致。

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type {
  CachedRepo,
  RepoGroup,
  RepoGroupLayoutResponse,
  RepoGroupMemberInput,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea, TextInput, Switch } from '@/components/Form'
import { QueryState } from '@/components/QueryState'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { RepoLayoutTree } from '@/components/repos/RepoLayoutTree'

/** 编辑器里的一行成员。与 wire 的 `RepoGroupMemberInput` 同构，外加一个本地 key。 */
type DraftMember = RepoGroupMemberInput & { localKey: string }

export interface RepoGroupEditorProps {
  open: boolean
  onClose: () => void
  /** 传入即为「编辑」，否则为「新建」。 */
  group?: RepoGroup
}

let seq = 0
const nextKey = (): string => `m${(seq += 1)}`

function toDraft(g: RepoGroup | undefined): DraftMember[] {
  if (g === undefined) return []
  return g.members.map((m) =>
    m.kind === 'repo'
      ? {
          localKey: nextKey(),
          kind: 'repo' as const,
          cachedRepoId: m.cachedRepoId,
          ref: m.ref,
          subdir: m.subdir,
          mountPath: m.mountPath,
          readonly: m.readonly,
        }
      : {
          localKey: nextKey(),
          kind: 'group' as const,
          childGroupId: m.childGroupId,
          mountPath: m.mountPath,
          readonly: m.readonly,
        },
  )
}

/** 去掉本地 key，得到可直接上 wire 的成员表。 */
function toWire(members: readonly DraftMember[]): RepoGroupMemberInput[] {
  return members.map(({ localKey: _localKey, ...rest }) => rest)
}

export function RepoGroupEditor({ open, onClose, group }: RepoGroupEditorProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState(group?.name ?? '')
  const [description, setDescription] = useState(group?.description ?? '')
  const [members, setMembers] = useState<DraftMember[]>(() => toDraft(group))

  // 每次重开对话框都从 props 重新播种——否则编辑完 A 再开 B 会看到 A 的残留。
  useEffect(() => {
    if (!open) return
    setName(group?.name ?? '')
    setDescription(group?.description ?? '')
    setMembers(toDraft(group))
  }, [open, group])

  const repos = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
    enabled: open,
  })
  const groups = useQuery<{ items: RepoGroup[] }>({
    queryKey: ['repo-groups'],
    queryFn: ({ signal }) => api.get('/api/repo-groups', undefined, signal),
    enabled: open,
  })

  // debounce 400ms：拖挂载点时每个按键都打一次预览既吵又没意义。
  const wire = useMemo(() => toWire(members), [members])
  const [debounced, setDebounced] = useState<RepoGroupMemberInput[]>(wire)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(wire), 400)
    return () => clearTimeout(id)
  }, [wire])

  const preview = useQuery<RepoGroupLayoutResponse & { pendingImports: number }>({
    queryKey: ['repo-group-preview', JSON.stringify(debounced)],
    queryFn: ({ signal }) =>
      api.post('/api/repo-groups/preview', { name, members: debounced }, signal),
    enabled: open,
    // 预览失败是**用户输入**的问题（成环 / 挂载点冲突 / 超深度），不是网络抖动。
    // 重试只会把同一条 422 再打三遍。
    retry: false,
  })

  const save = useMutation({
    mutationFn: async () => {
      const body = { name, description, members: wire }
      if (group === undefined) return api.post('/api/repo-groups', body)
      return api.put(`/api/repo-groups/${group.id}`, { ...body, expectedVersion: group.version })
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['repo-groups'] })
      onClose()
    },
  })

  const patchAt = (i: number, patch: Partial<DraftMember>): void => {
    setMembers((prev) => prev.map((m, j) => (j === i ? ({ ...m, ...patch } as DraftMember) : m)))
  }
  const removeAt = (i: number): void => setMembers((prev) => prev.filter((_, j) => j !== i))
  const addRepo = (): void =>
    setMembers((prev) => [
      ...prev,
      { localKey: nextKey(), kind: 'repo', ref: '', subdir: '', mountPath: '', readonly: false },
    ])
  const addGroup = (): void =>
    setMembers((prev) => [
      ...prev,
      { localKey: nextKey(), kind: 'group', childGroupId: '', mountPath: '', readonly: false },
    ])

  const nameOk = name.trim().length > 0
  const canSave = nameOk && members.length > 0 && !save.isPending

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        group === undefined ? t('repoGroups.editor.createTitle') : t('repoGroups.editor.editTitle')
      }
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} data-testid="repo-group-cancel">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSave}
            onClick={() => save.mutate()}
            data-testid="repo-group-save"
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      {save.error !== null && save.error !== undefined && <ErrorBanner error={save.error} />}

      <Field label={t('repoGroups.editor.name')} required>
        <TextInput value={name} onChange={setName} data-testid="repo-group-name" />
      </Field>
      <Field label={t('repoGroups.editor.description')}>
        <TextArea value={description} onChange={setDescription} data-testid="repo-group-desc" />
      </Field>

      <div className="repo-group-editor__split">
        <section className="repo-group-editor__members">
          <Field label={t('repoGroups.editor.members')} group>
            <ul className="repo-group-editor__list" data-testid="repo-group-members">
              {members.map((m, i) => (
                <li
                  key={m.localKey}
                  className="repo-group-editor__member"
                  data-testid={`repo-group-member-${i}`}
                >
                  <StatusChip kind="neutral" size="sm">
                    {m.kind === 'repo'
                      ? t('repoGroups.editor.kindRepo')
                      : t('repoGroups.editor.kindGroup')}
                  </StatusChip>
                  {m.kind === 'repo' ? (
                    <Select<string>
                      value={m.cachedRepoId ?? ''}
                      onChange={(id) => patchAt(i, { cachedRepoId: id } as Partial<DraftMember>)}
                      ariaLabel={t('repoGroups.editor.pickRepo')}
                      placeholder={t('repoGroups.editor.pickRepo')}
                      data-testid={`repo-group-member-repo-${i}`}
                      options={[
                        { value: '', label: t('repoGroups.editor.pickRepo') },
                        ...(repos.data?.items ?? []).map((r) => ({
                          value: r.id,
                          label: r.urlRedacted,
                        })),
                      ]}
                    />
                  ) : (
                    <Select<string>
                      value={m.childGroupId}
                      onChange={(id) => patchAt(i, { childGroupId: id } as Partial<DraftMember>)}
                      ariaLabel={t('repoGroups.editor.pickGroup')}
                      placeholder={t('repoGroups.editor.pickGroup')}
                      data-testid={`repo-group-member-group-${i}`}
                      options={[
                        { value: '', label: t('repoGroups.editor.pickGroup') },
                        // 自己不能引用自己——那是一条一眼可见的环，没必要让用户
                        // 选完再被服务端拒。
                        ...(groups.data?.items ?? [])
                          .filter((g) => g.id !== group?.id)
                          .map((g) => ({ value: g.id, label: g.name })),
                      ]}
                    />
                  )}
                  <TextInput
                    value={m.mountPath}
                    onChange={(v) => patchAt(i, { mountPath: v })}
                    placeholder={t('repoGroups.editor.mountPlaceholder')}
                    data-testid={`repo-group-member-mount-${i}`}
                  />
                  {m.kind === 'repo' && (
                    <>
                      <TextInput
                        value={m.ref}
                        onChange={(v) => patchAt(i, { ref: v } as Partial<DraftMember>)}
                        placeholder={t('repoGroups.editor.refPlaceholder')}
                        data-testid={`repo-group-member-ref-${i}`}
                      />
                      <TextInput
                        value={m.subdir}
                        onChange={(v) => patchAt(i, { subdir: v } as Partial<DraftMember>)}
                        placeholder={t('repoGroups.editor.subdirPlaceholder')}
                        data-testid={`repo-group-member-subdir-${i}`}
                      />
                    </>
                  )}
                  <Switch
                    checked={m.readonly}
                    onChange={(v) => patchAt(i, { readonly: v })}
                    label={t('repoGroups.editor.readonly')}
                    data-testid={`repo-group-member-readonly-${i}`}
                  />
                  <button
                    type="button"
                    className="btn btn--xs btn--danger"
                    onClick={() => removeAt(i)}
                    data-testid={`repo-group-member-remove-${i}`}
                  >
                    {t('common.delete')}
                  </button>
                </li>
              ))}
            </ul>
            <div className="repo-group-editor__actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={addRepo}
                data-testid="repo-group-add-repo"
              >
                {t('repoGroups.editor.addRepo')}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={addGroup}
                data-testid="repo-group-add-group"
              >
                {t('repoGroups.editor.addGroup')}
              </button>
            </div>
          </Field>
        </section>

        <section className="repo-group-editor__preview">
          <Field label={t('repoGroups.editor.preview')} group>
            {/* 加载 / 错误 / 空三态全部交给 `<QueryState>`——这是本仓表达
                「查询的三态」的唯一原语（RFC-214 Lock B）。预览的错误就是
                用户输入的错误（成环 / 挂载点冲突 / 超深度），原样展示。 */}
            <QueryState
              query={preview}
              data={preview.data?.repos ?? []}
              emptyText={t('repoGroups.layout.empty')}
              testid="repo-group-preview-state"
            >
              {(repos) => (
                <>
                  <RepoLayoutTree repos={repos} testidPrefix="repo-group-preview" />
                  {(preview.data?.pendingImports ?? 0) > 0 && (
                    <StatusChip kind="info" size="sm" data-testid="repo-group-preview-pending">
                      {t('repoGroups.editor.pendingImports', {
                        count: preview.data?.pendingImports ?? 0,
                      })}
                    </StatusChip>
                  )}
                </>
              )}
            </QueryState>
          </Field>
        </section>
      </div>
    </Dialog>
  )
}
