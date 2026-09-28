import { useRef, useState } from 'react'
import { Dialog } from '../../../packages/frontend/src/components/Dialog'
import { Field, TextInput } from '../../../packages/frontend/src/components/Form'
import { TableViewport } from '../../../packages/frontend/src/components/TableViewport'
import { StatusChip } from '../../../packages/frontend/src/components/StatusChip'
import { models, SNAPSHOT, type Usage } from './fixture'

const fields = [
  { key: 'input', label: '非缓存输入' },
  { key: 'read', label: '缓存读取' },
  { key: 'write', label: '缓存写入' },
  { key: 'output', label: '输出' },
] as const
const runtimeProfiles = [
  { model: 'reasoner', name: 'claude-plan', protocol: 'Claude Code', provider: '示例模型服务 A' },
  { model: 'coder', name: 'opencode-code', protocol: 'OpenCode', provider: '示例模型服务 B' },
  { model: 'fast', name: 'opencode-review', protocol: 'OpenCode', provider: '示例模型服务 B' },
]
type Draft = { input: string; read: string; write: string; output: string; effectiveAt: string }
type Version = { model: string; revision: number; effectiveAt: string; rates: Usage }
const initialVersions: Version[] = models.map((m) => ({
  model: m.id,
  revision: 1,
  effectiveAt: '2026-09-01 00:00',
  rates: { input: m.input, read: m.read, write: m.write, output: m.output },
}))
function defaultDraft(id: string, versions: Version[]): Draft {
  const last = versions.filter((v) => v.model === id).at(-1)!
  return {
    input: String(last.rates.input),
    read: String(last.rates.read),
    write: String(last.rates.write),
    output: String(last.rates.output),
    effectiveAt: '2026-09-29 00:00',
  }
}
function validate(draft: Draft, id: string, versions: Version[]): string | null {
  if (
    fields.some(({ key }) => !/^\d+(\.\d{1,6})?$/.test(draft[key]) || Number(draft[key]) > 1000000)
  )
    return '请填写四项非负人民币单价，最多 6 位小数；空值不等于免费，明确免费请填 0。'
  const timestamp = Date.parse(draft.effectiveAt.replace(' ', 'T') + ':00+08:00')
  const latest = Math.max(
    SNAPSHOT,
    ...versions
      .filter((v) => v.model === id)
      .map((v) => Date.parse(v.effectiveAt.replace(' ', 'T') + ':00+08:00')),
  )
  if (
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(draft.effectiveAt) ||
    !Number.isFinite(timestamp) ||
    timestamp <= latest
  )
    return '请输入 YYYY-MM-DD HH:mm，且晚于演示快照 2026-09-28 15:36 和已有版本，时区 UTC+08:00。'
  return null
}
function RateSummary({ rates }: { rates: Usage }) {
  return (
    <div className="obs-pricing-rates">
      <span>输入 ¥{rates.input}</span>
      <span>输出 ¥{rates.output}</span>
      <span>缓存读 ¥{rates.read}</span>
      <span>缓存写 ¥{rates.write}</span>
    </div>
  )
}
export function RuntimePricing({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [versions, setVersions] = useState(initialVersions)
  const [selected, setSelected] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft | undefined>>({})
  const [error, setError] = useState<string | null>(null),
    [message, setMessage] = useState('')
  const trigger = useRef<HTMLButtonElement | null>(null)
  const edit = (id: string) => {
    setDrafts((d) => ({ ...d, [id]: d[id] ?? defaultDraft(id, versions) }))
    setError(null)
    setSelected(id)
  }
  const close = () => {
    setSelected(null)
    onClose()
  }
  const save = () => {
    if (!selected) return
    const draft = drafts[selected]!,
      issue = validate(draft, selected, versions)
    if (issue) {
      setError(issue)
      return
    }
    const revision = versions.filter((v) => v.model === selected).length + 1
    const rates = {
      input: Number(draft.input),
      read: Number(draft.read),
      write: Number(draft.write),
      output: Number(draft.output),
    }
    setVersions((v) => [...v, { model: selected, revision, effectiveAt: draft.effectiveAt, rates }])
    setMessage(
      runtimeProfiles.find((r) => r.model === selected)!.name +
        ' 的 CNY-v' +
        revision +
        ' 已保存，计划于 ' +
        draft.effectiveAt +
        ' 生效；历史费用保持原价。',
    )
    setDrafts((d) => ({ ...d, [selected]: undefined }))
    setSelected(null)
  }
  const profile = runtimeProfiles.find((r) => r.model === selected),
    model = models.find((m) => m.id === selected)
  const draft = selected ? drafts[selected] : undefined
  return (
    <>
      <Dialog open={open} onClose={close} title="工作台设置 · 运行时 · Token 成本" size="lg">
        <div className="obs-page-stack">
          <p>
            配置入口：工作台设置 → 运行时 → 选择运行时 → Token 成本。管理员维护；单位统一为
            <strong>人民币元 / 百万 Token</strong>。
          </p>
          <p className="obs-caption">
            运行时注册项 + 模型服务 +
            实际模型分别定价。以下运行时与价格均为虚构示例，未读取真实运行时注册表。
          </p>
          {message && (
            <div role="status" className="obs-pricing-message">
              {message}
            </div>
          )}
          <TableViewport label="运行时人民币单价" minWidth="sm">
            <table className="data-table data-table--compact obs-table">
              <thead>
                <tr>
                  <th>运行时</th>
                  <th>模型服务 / 模型</th>
                  <th>单价 · 元 / 百万 Token</th>
                  <th>价格版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {runtimeProfiles.map((p) => {
                  const m = models.find((v) => v.id === p.model)!,
                    pending = versions.filter((v) => v.model === p.model && v.revision > 1).length
                  return (
                    <tr key={p.name}>
                      <td>
                        <strong>{p.name}</strong>
                        <div className="obs-small obs-muted">{p.protocol}</div>
                      </td>
                      <td>
                        {p.provider}
                        <div className="obs-small obs-muted">{m.name}</div>
                      </td>
                      <td>
                        <RateSummary rates={m} />
                      </td>
                      <td>
                        CNY-v1
                        <div className="obs-small obs-muted">
                          {pending ? pending + ' 个待生效版本' : '当前生效'}
                        </div>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={(e) => {
                            trigger.current = e.currentTarget
                            edit(m.id)
                          }}
                        >
                          配置单价
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableViewport>
          <h3>价格版本历史</h3>
          <TableViewport label="人民币价格版本历史" minWidth="sm">
            <table className="data-table data-table--compact obs-table">
              <thead>
                <tr>
                  <th>运行时</th>
                  <th>版本</th>
                  <th>生效时间 · UTC+08:00</th>
                  <th>单价 · 元 / 百万 Token</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {[...versions].reverse().map((v) => (
                  <tr key={v.model + v.revision}>
                    <td>{runtimeProfiles.find((p) => p.model === v.model)!.name}</td>
                    <td>CNY-v{v.revision}</td>
                    <td>{v.effectiveAt}</td>
                    <td>
                      <RateSummary rates={v.rates} />
                    </td>
                    <td>
                      <StatusChip kind={v.revision === 1 ? 'success' : 'info'} size="sm">
                        {v.revision === 1 ? '当前生效' : '待生效'}
                      </StatusChip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
          <p className="obs-caption">
            CrewStation 托管模式设计：平台价格与用量作为同一笔消耗来源，AW
            按任务/Agent归因，不再次累加估算。平台未返回价格时显示未定价；此联动尚未接入。
          </p>
          <p className="obs-caption">
            价格变更仅影响生效后新受理的执行，不触发模型测试或运行时重启。演示修改保留在当前页面会话，刷新恢复示例。
          </p>
        </div>
      </Dialog>
      <Dialog
        open={open && !!selected}
        onClose={() => setSelected(null)}
        title={'配置 Token 单价 · ' + (profile?.name ?? '')}
        size="md"
        triggerRef={trigger}
        closeOnOverlayClick={false}
        footer={
          <>
            <button type="button" className="btn btn--primary" onClick={save}>
              保存演示版本
            </button>
            <button type="button" className="btn" onClick={() => setSelected(null)}>
              取消
            </button>
          </>
        }
      >
        {draft && selected && (
          <div className="obs-page-stack">
            <p>
              {profile?.protocol} · {profile?.provider} · {model?.name}
              <br />
              <strong>人民币（CNY） · 元 / 百万 Token</strong>
            </p>
            <div className="obs-pricing-fields">
              {fields.map((f) => (
                <Field key={f.key} label={f.label + '单价'} hint="元 / 百万 Token，0 表示明确免费">
                  <TextInput
                    value={draft[f.key]}
                    onChange={(value) => {
                      setDrafts((d) => ({ ...d, [selected]: { ...draft, [f.key]: value } }))
                      setError(null)
                    }}
                  />
                </Field>
              ))}
            </div>
            <Field label="生效时间" hint="YYYY-MM-DD HH:mm · UTC+08:00">
              <TextInput
                value={draft.effectiveAt}
                onChange={(effectiveAt) => {
                  setDrafts((d) => ({ ...d, [selected]: { ...draft, effectiveAt } }))
                  setError(null)
                }}
              />
            </Field>
            <p className="obs-caption">
              保存追加一个待生效版本；历史仍使用 CNY-v1。关闭后重新打开保留未保存的输入。
            </p>
            {error && <p role="alert">{error}</p>}
          </div>
        )}
      </Dialog>
    </>
  )
}
