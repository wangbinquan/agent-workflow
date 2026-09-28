# RFC-371 计量来源与实施证据

2026-09-28。此表区分源码/文档证据与实机证据；没有真实运行过的组合不记为完整采集。

| 来源                     | 可确认事实                                                                                                        | 接入规则与尚缺证据                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| OpenCode 1.15.5 仓内实录 | `tests/fixtures/opencode-recordings/` 的 step_finish 有稳定 part.id；444 非缓存输入 + 7040 缓存读 + 3 输出 = 7487 | 按 part.id 去重；缺字段仍未知；此样本不能证明所有后续版本、子 Agent 或 provider 行为 |
| AW 现有 OpenCode adapter | `services/runtime/opencode/events.ts` 对提取值累加，缺数值归零                                                    | 新观测合同保留 presence 与稳定 ID，不改变已有执行预算合同                            |
| AW 现有 Claude adapter   | `services/runtime/claudeCode/events.ts` 只累计 result.usage                                                       | 旧结果只能按已证明的 main-loop 范围归因，不能宣称包含所有子 Agent                    |
| CS 现有 businessUsage    | stable identity + nullable 四桶；拒绝 sidechain；业务投影追加 execution 身份                                      | 不能把 execution 前缀当原生恢复会话的累计量重置；CLI 是否提供结构化用量单列能力      |

Claude 官方 [cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) 区分 turn 主循环的 `usage` 与含子 Agent 的累计 `modelUsage`；2.1.277 起恢复会话可恢复历史累计值。assistant 输出计数可能不是最终值。同一消息分片必须去重，不能把父累计与子明细相加。版本/恢复基线不明时标部分或冲突，不猜测差值。此处为上游文档证据，尚不等于本机 Claude 的实机验收。

计量适配必须保存 adapterVersion、原生会话/代次、实际模型、互斥桶 presence、reporting 与包含范围。session 级累计值先按同一原生谱系做差，再归到 invocation；新会话、clear、fork 与恢复边界不能共用一个盲目累计器。金额只接受明确 CNY 或有依据的独立换算结果；厂商外币估算不进入人民币合计。

## 生产进度

- [ ] 固定 adapter 合同样本与故障/恢复用例。
- [ ] 独立部署：本地 source → 持久账本 → 查询/价格/界面。
- [ ] CS 部署：授权 source/valuation → 断线重放 → 同一查询/界面。
- [ ] SQLite / PostgreSQL、托管 / 独立部署均完成真实合同验收。

不得用原型 fixture、领域单测或文档引用替代以上端到端证据。
