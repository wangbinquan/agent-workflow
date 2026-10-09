# RFC-371 已确认零消耗与未知调用并存

## 实际问题

2026-10-09 原入口失败批次的报告 `496b788e-4dee-42dc-b4a9-bdd26e654da4` 完整包含 8 个工作流任务、其自动触发的 16 组记忆提取、112 次调用和 136 次尝试。10 类原集合、31 个传输页全部 EOF，所有 ID 与原库一致。64 次工作流调用的原生完整空 capture 与原 SDK 根／子会话均证明没有 step-finish，单次指标明确四桶 0、人民币 0；48 次记忆调用没有 capture，仍为未知。旧验证脚本将每次调用都预期为未知的错误已保留并修正，不补写模型或费用记录。

`completeObservationMetrics` 只在已接收记录数大于零时保留部分 Token／CNY。完整空 capture 没有记录，所以与未知调用合并后，已确认的 0 被丢掉。报告仍应不完整，但应能显示这部分实际已知的 0。此修复属于原已批准的“有缺口仍显示已知数值”，不增加统计人口上限，不替换未知数据，不改变任务、调用或尝试计数。

## 证据与汇总合同

- Task builder 在原 `knownZero && rawRecords === '0'` 条件下，登记调用级零消耗证据；仅完整原生／平台证明可产生它。未受理、没有 native 根、partial capture、未知记录、未经归属的零值均不产生证明。
- 内部 fold 增加可选十进制字符串 `knownZeroInvocations` 与 `knownZeroCostInvocations`，默认 0。它们分别计已明确证明四桶零的受理调用，以及原价格可见且原空费用已确认的零调用。平台估值仍未就绪时不能由零 Token 推出费用 0。
- 后者不得大于前者，前者不得大于 observedInvocations；没有零证明的旧 not-ready 响应保持原义。合并只加已确认计数，不能改变已有 records、bucketRecords、金额或缺口。
- 有缺口时，在 tokenCoverage／recordedUsage 中仅正数出现 `knownZeroInvocations`；已有记录的已知桶按原加法保留，没有已知记录的桶只有具备零证明时才显示 0，否则仍是 null。零证明不会把未知记录或未知调用标为完整。
- 可见 CNY 的 costCoverage／recordedCost 仅正数出现 `knownZeroCostInvocations`。没有已定价记录而有零费用证明时，已知金额只能为 0；原 priced／partiallyPriced 记录计数和人民币精度不变。隐藏或未就绪的平台估值没有零费用证明，也不产生该金额。
- `completeMetricsFold` 恢复这两项明确可选字段。旧 ready 的完整零记录指标已证明四桶零，可以恢复其 observed 调用为零 Token 证据；只在原 cost complete 且 amount 为 0 时恢复零费用。旧 not-ready 的 records=0／observed>0 不能单凭计数提升为零证据。
- `qualifiedCostEvidence` 对新增合同做完整功能一致性检查；旧字段与旧响应精确保持，非法／缺失零证据、零计数、过计数或无定价记录的正金额不构成有效部分统计。原 report 不回写、不覆盖，新报告从原同快照完整事实重新生成。

## 页面与时间范围

复用当前 Token 四桶与人民币公共组件。部分已知零值显示 `0`／`¥0`，仍保留不完整说明与调用覆盖率；零记录场景不显示误导的桶 `0 / 0`。只有零费用贡献时用简短中文／英文说明“已确认零费用调用 N · 不代表完整估值”。不增加警告卡片、不改总览专属卡片、柱状图、已批准返回样式或卡片间距。

趋势直接读取原 metrics.recordedUsage 的零证据，旧额外 recordedUsage 合同不扩展。usage 时间分区没有原发生时间时，不凭 acceptedAt 或 capture 时间把零调用归入窗口；本次不改变窗口选择或时间未分配规则。未知来源、记录、时间和历史 owner 的原缺口全部保留。

## 验证与发布

先做限定独立设计门，再实施。增加原完整空 capture 与未知调用并存的 SQLite／PostgreSQL 报告回归；验证任务、尝试、调用、维度及总体合并／恢复，保留原分页 EOF 和全部人口。补单域零值／未知／混合／平台费用未就绪及非法计数负例、公共组件中英显示回归，所有原断言、数值与预算保持。任何新生产变更按原官方 assertion-free 架构配套登记一次，禁止为测试修复再扫描。

AW 不运行本机产品 tests／typecheck／build／services／E2E；只做变更文件静态检查、要求的独立功能复核与精确 hosted CI。正式页只使用原许可身份和已有本机服务。实跑旧失败保留，不重复模型请求以凑绿色；新报告与同一原 SDK／持久事实对拍。默认算力临时切换仍等待直接人类答复；16 个内置 Agent／Git、CS 发布部署及两个 RFC 的其余退出项继续。
