import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Card } from '../../../packages/frontend/src/components/Card'
import { PageHeader } from '../../../packages/frontend/src/components/PageHeader'
import { Field, TextArea } from '../../../packages/frontend/src/components/Form'
import '../../../packages/frontend/src/styles.css'
import './prototype.css'

type View = { id: string; title: string; kind: string; why: string; nodes: string[] }
const examples = [
  {
    title: '会议室预约',
    goal: '让同事找到房间并预约，明确冲突时如何处理。',
    initial: [
      {
        id: 'journey',
        title: '一次预约怎样完成',
        kind: '流程',
        why: '先澄清操作和失败分支，当前一张图足够。',
        nodes: ['选择时间与房间', '检查可用时段', '确认预约'],
      },
    ],
    extra: [
      {
        id: 'race',
        title: '两个人同时预约会怎样',
        kind: '时序',
        why: '新增并发约束，原流程没有表达同时竞争。',
        nodes: ['甲与乙同时提交', '原子占用时段', '胜者成功 · 败者提示冲突'],
      },
      {
        id: 'rules',
        title: '冲突时按什么规则决定',
        kind: '决策表',
        why: '优先级与例外需要逐项比较，而非继续增加流程分支。',
        nodes: ['普通预约 → 先到先得', '已确认预约 → 不自动抢占', '紧急会议 → 人工协调（暂定）'],
      },
    ],
    change: '补充：多人可能同时预约；紧急会议能否覆盖已有预约尚未决定。',
    question: '紧急会议遇到已确认预约时，允许自动抢占吗？',
    source: '用户需求：多人可能同时预约；紧急会议规则尚未决定。',
    test: '同一时段并发提交时只能有一个成功预约。',
  },
  {
    title: '异步通知',
    goal: '正确处理支付通知的重复、乱序及退款。',
    initial: [
      {
        id: 'events',
        title: '重复与乱序通知怎样到达',
        kind: '时序',
        why: '事件到达顺序是主要疑点，先表达相互作用。',
        nodes: ['收到支付通知', '查验事件与订单', '幂等更新并回执'],
      },
      {
        id: 'status',
        title: '订单何时可以改变状态',
        kind: '状态',
        why: '时序不能单独说明哪些状态迁移被允许。',
        nodes: ['待支付', '已支付', '已关闭'],
      },
    ],
    extra: [
      {
        id: 'refund',
        title: '退款与迟到支付通知如何相遇',
        kind: '状态',
        why: '退款引入新状态边界，补充原模型的例外路径。',
        nodes: ['已支付 → 退款中', '退款中 → 已退款', '已退款 + 迟到支付 → 保持已退款'],
      },
    ],
    change: '补充：已退款订单还会收到迟到的支付成功通知。',
    question: '退款完成后再次收到支付成功通知，应忽略还是人工复核？',
    source: '代码事实：通知处理器已记录事件 ID；退款行为待确认。',
    test: '迟到支付通知不能把已退款订单恢复成已支付。',
  },
  {
    title: '旧模块改造',
    goal: '替换仓储接口，同时保持现有调用方行为。',
    initial: [
      {
        id: 'deps',
        title: '哪些调用会受接口变化影响',
        kind: '关系',
        why: '现有模块改造优先明确影响范围，部署方式没有变化。',
        nodes: ['订单服务', '仓储接口', '存储适配器'],
      },
    ],
    extra: [
      {
        id: 'contract',
        title: '旧新返回结果如何对应',
        kind: '决策表',
        why: '发现空结果语义变化，需要显式对比契约。',
        nodes: ['找到记录 → 返回记录', '未找到 → null', '读取失败 → 保留原错误语义'],
      },
    ],
    change: '补充：新接口把未找到改为抛错，旧调用方期望 null。',
    question: '未找到记录时，新接口要延续 null 语义吗？',
    source: '代码事实：订单服务对 null 有明确分支。',
    test: '未找到记录时返回 null，已有调用方回归保持。',
  },
]

function Prototype() {
  const [scenario, setScenario] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState('journey')
  const [element, setElement] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string[]>([])
  const [answer, setAnswer] = useState('')
  const [saved, setSaved] = useState('')
  const [maturity, setMaturity] = useState('未标记')
  const [savedMaturity, setSavedMaturity] = useState('未标记')
  const [phase, setPhase] = useState<'design' | 'preview' | 'review' | 'approved' | 'result'>(
    'design',
  )
  const [revision, setRevision] = useState(1)
  const [notice, setNotice] = useState('当前组合覆盖已知问题；发现新约束后可以调整。')
  const [missing, setMissing] = useState(false)
  const [dark, setDark] = useState(false)
  const example = examples[scenario]!
  const views: View[] = [...example.initial, ...(expanded ? example.extra : [])]
  const view = views.find((candidate) => candidate.id === selected) ?? views[0]!
  function switchScenario(index: number) {
    setScenario(index)
    setExpanded(false)
    setSelected(examples[index]!.initial[0]!.id)
    setElement(null)
    setPinned([])
    setAnswer('')
    setSaved('')
    setMaturity('未标记')
    setSavedMaturity('未标记')
    setPhase('design')
    setRevision(1)
    setMissing(false)
    setNotice('已切换案例，各案例的组合由关注问题决定。')
  }
  function revise() {
    setExpanded(true)
    setRevision((value) => value + 1)
    setPhase('design')
    setNotice('调整预览已应用：补充有额外价值的视图；原图、固定项与人的回答保留。')
  }
  return (
    <main className="page graph-prototype" data-theme={dark ? 'dark' : 'light'}>
      <PageHeader
        title="图驱动研发工作区"
        meta="RFC-396 · 可交互设计原型"
        actions={
          <button
            className="btn btn--sm"
            onClick={() => {
              document.documentElement.dataset.theme = dark ? 'light' : 'dark'
              setDark(!dark)
            }}
          >
            切换外观
          </button>
        }
      />
      <p className="graph-prototype__demo">
        原型演示：使用固定案例说明交互；不调用模型、不生成真实代码、不代表验证通过。
      </p>
      <div className="segmented" aria-label="需求案例">
        {examples.map((item, index) => (
          <button
            key={item.title}
            className={
              index === scenario ? 'segmented__item segmented__item--active' : 'segmented__item'
            }
            aria-pressed={index === scenario}
            onClick={() => switchScenario(index)}
          >
            {item.title}
          </button>
        ))}
      </div>
      <div className="graph-prototype__toolbar">
        <span>
          设计版本 {revision} · {views.length} 个视图
        </span>
        <button
          className="btn btn--sm"
          onClick={() => {
            setMissing(!missing)
            setNotice('材料缺口单独保留，不能用模型猜测补齐。')
          }}
        >
          {missing ? '恢复已知材料' : '预览材料不足'}
        </button>
        <button
          className="btn btn--sm"
          onClick={() => {
            setRevision(revision + 1)
            setPhase('design')
            setNotice('语义已改变：相关视图待更新，旧批准仍只属于旧基线。')
          }}
        >
          预览语义变化
        </button>
      </div>
      <p role="status">{notice}</p>
      <div className="graph-prototype__columns">
        <aside>
          <Card title="目标与关键问题">
            <p>{example.goal}</p>
            <p>{expanded ? example.change : '先解决当前最重要的不确定性。'}</p>
            {missing && (
              <p className="graph-prototype__gap">
                未知：缺少可靠业务规则。下一步应向人提问；当前不能形成实现依据。
              </p>
            )}
            <button className="btn btn--primary" disabled={expanded} onClick={revise}>
              补充约束并调整组合
            </button>
          </Card>
          <Card title="当前图组合">
            {views.map((item) => (
              <button
                className="graph-prototype__view btn"
                key={item.id}
                aria-pressed={view.id === item.id}
                onClick={() => {
                  setSelected(item.id)
                  setElement(null)
                }}
              >
                <strong>{item.title}</strong>
                <span>
                  {item.kind}
                  {pinned.includes(item.id) ? ' · 已固定' : ''}
                </span>
              </button>
            ))}
          </Card>
        </aside>
        <section>
          <Card
            title={view.title}
            actions={
              <button
                className="btn btn--xs"
                aria-pressed={pinned.includes(view.id)}
                onClick={() =>
                  setPinned(
                    pinned.includes(view.id)
                      ? pinned.filter((id) => id !== view.id)
                      : [...pinned, view.id],
                  )
                }
              >
                {pinned.includes(view.id) ? '取消固定' : '固定视图'}
              </button>
            }
          >
            <p>{view.why}</p>
            <div
              className={`graph-prototype__diagram graph-prototype__diagram--${view.kind}`}
              aria-label={`${view.kind}视图`}
            >
              {view.nodes.map((node, index) => (
                <div className="graph-prototype__node-row" key={node}>
                  <button
                    className="btn graph-prototype__node"
                    aria-pressed={element === node}
                    onClick={() => {
                      setElement(node)
                      setNotice('已定位语义对象；下方可查看来源并围绕它继续澄清。')
                    }}
                  >
                    {node}
                  </button>
                  {index < view.nodes.length - 1 && (
                    <button
                      className="btn btn--xs"
                      aria-label={`选择关系：${node}到${view.nodes[index + 1]}`}
                      onClick={() => setElement(`${node} → ${view.nodes[index + 1]}`)}
                    >
                      ↓
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button className="btn btn--sm" onClick={() => setElement(view.nodes.join(' → '))}>
              选择整条路径
            </button>
          </Card>
          <Card title="围绕选中内容澄清">
            <p>{element ?? '可选择对象、关系、路径或整个视图。'}</p>
            <p>{example.question}</p>
            <Field label="你的原话" hint="保留未知与暂定判断，确认回答不代表事实已验证。">
              <TextArea value={answer} onChange={setAnswer} rows={4} />
            </Field>
            <div className="segmented" aria-label="决定成熟程度">
              {['未标记', '暂定', '已决定'].map((value) => (
                <button
                  key={value}
                  className="segmented__item"
                  aria-pressed={maturity === value}
                  onClick={() => setMaturity(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <button
              className="btn btn--primary"
              disabled={!answer.trim()}
              onClick={() => {
                setSaved(answer)
                setSavedMaturity(maturity)
                setRevision(revision + 1)
                setPhase('design')
                setNotice('原话和成熟程度已保存；负责人、时机等未知仍未填写。')
              }}
            >
              保存回答
            </button>
            {saved && (
              <blockquote>
                {saved}
                <br />
                成熟程度：{savedMaturity} · 负责人：未指定
              </blockquote>
            )}
          </Card>
        </section>
        <aside>
          <Card title="来源与关联">
            <p>{element ?? view.title}</p>
            <p>{example.source}</p>
            <p>同一语义对象跨视图引用；展示名称变化不改变身份。</p>
            <p>验收场景：{example.test}</p>
            <button
              className="btn btn--sm"
              onClick={() => {
                setSelected(views[0]!.id)
                setNotice('已回到该对象的来源视图。')
              }}
            >
              定位来源视图
            </button>
          </Card>
          <Card title="实现依据与交付">
            {phase === 'design' && (
              <>
                <p>先复核本次范围、已采纳判断、未知和验收方式。</p>
                <button
                  className="btn btn--primary"
                  disabled={missing || !saved}
                  onClick={() => setPhase('preview')}
                >
                  预览实现依据
                </button>
                {!saved && <p>请先保存一个真实判断，再预览示例基线。</p>}
              </>
            )}
            {phase === 'preview' && (
              <>
                <p>预览：设计版本 {revision}；尚未提交审核。</p>
                <p>原话：{saved}</p>
                <p>成熟程度：{savedMaturity}</p>
                <p>验收：{example.test}</p>
                <button className="btn btn--primary" onClick={() => setPhase('review')}>
                  提交此基线审核
                </button>
                <button className="btn" onClick={() => setPhase('design')}>
                  返回设计
                </button>
              </>
            )}
            {phase === 'review' && (
              <>
                <p>待审核：设计版本 {revision}</p>
                <p>已采纳原话：{saved}</p>
                <p>验收：{example.test}</p>
                <p>未决：负责人、实施时机；保留原状。</p>
                <button
                  className="btn btn--primary"
                  onClick={() => {
                    setPhase('approved')
                    setNotice('示例审核已批准此版本。还没有开始生成代码。')
                  }}
                >
                  批准此基线（演示）
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setPhase('design')
                    setNotice('拒绝回执已保留，旧审核结束；回到设计后生成新版本再提交审核。')
                  }}
                >
                  拒绝并返回设计
                </button>
              </>
            )}
            {phase === 'approved' && (
              <>
                <p>基线版本 {revision} 已批准。</p>
                <button
                  className="btn btn--primary"
                  onClick={() => {
                    setPhase('result')
                    setNotice('仅演示结果：代码生成与程序验证分别呈现。')
                  }}
                >
                  开始实现（演示）
                </button>
              </>
            )}
            {phase === 'result' && (
              <>
                <p>候选代码：已生成（演示）</p>
                <p>结构检查：通过（演示）</p>
                <p>程序验证：失败（演示）</p>
                <p>人工验收：未执行</p>
                <p>失败：{example.test} 未满足。</p>
                <button
                  className="btn btn--sm"
                  onClick={() => {
                    setElement(example.test)
                    setNotice('已从失败证据回到对应验收义务，原设计要求没有被自动放宽。')
                  }}
                >
                  从证据定位设计
                </button>
              </>
            )}
          </Card>
        </aside>
      </div>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Prototype />)
