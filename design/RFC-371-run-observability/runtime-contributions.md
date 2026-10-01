# RFC-371 运行时受理原名与任务贡献

状态：AW-R08 第一批独立设计门已 PASS（2026-10-01，冻结设计 SHA-256 `2fabe391604f416f3ce0c16fa618fe894e749e9bc736718ca7390689298350b6`）；22 路径的实现与回归候选已落地，精确格式/lint 通过，独立实现复核与 hosted 精确 SHA CI 待完成。沿用用户对完整 RFC 的实施、上库授权。服务端维度筛选、模型/用途下钻及最终验收仍继续，不以本批替代整个 AW-R08。

## 用户看到的行为

运行与观测统计 → 用量分析 → 运行时分布，优先显示任务选择该注册项时冻结的名称，并保留注册 ID、配置修订和协议。历史调用没有冻结名称时明确显示“受理名称未采集”；不查询当前目录补写历史名称。未登记的协议回退、CS 托管平台来源分别保持独立说明，不能把 CS installation ID 当成某个算力档位。

运行时名称复用任务列表的无边框文字按钮。点击后使用公共 Dialog 展示该运行时在当前任务样本中的四桶 Token、人民币、质量与各任务贡献。一个任务用了两个运行时，弹窗中每行只显示选中运行时的贡献；打开任务详情后明确进入该任务的全部直接消耗，返回恢复运行时弹窗、筛选、主内容区和弹窗滚动及焦点。

旧版本响应没有任务贡献字段时显示“任务贡献尚未提供”，禁止用任务总消耗替代。总览达到已有读取预算时，弹窗同样标示部分结果。不会恢复 CSV、关注任务卡片、更多筛选或顶层工作流输入框。

## 原受理事实与兼容

1. runtime-management 的 `RuntimeObservationIdentity` 增加可选 `acceptedName`。仅真实注册项解析时从同一 `RuntimeRow.name` 填入；未知/未登记回退仍没有注册身份。
2. 沿用原 node-run 的 `runtime_params_json.__observation` 冻结机制，首次选择、同一行重试/恢复和新行继承使用同一快照。旧 JSON 没有名称则一直没有；解析不得再次 resolve 当前目录。名称损坏仅省略这项显示元数据，合法 ID/修订仍保留，不能因此重新选择运行时或单价。
3. runner 原受理入口通过现有 `RuntimeObservationIdentity` 公开合同传递字段，不增加 services facade、provider 分叉或新调用入口。
4. `ObservationExecutionAuthoritySchema` 的本地 runtime 增加可选、有界非空 `acceptedName`，严格旧响应、旧回执与旧价格版本继续合法。名称不参与注册身份、价格选择或分组键，但原受理文档的整体幂等比较仍冻结该事实；相同 invocation 改写名称应冲突。
5. 不新增数据库列或迁移，不回填旧历史。删除后以相同名称重建注册项仍为新 ID，不能合并或继承旧价格；配置修订保持原值。

## 同快照的分组与贡献

共享 `ObservationRuntimeIdentity` 值合同和 `observationRuntimeKey` 仅包含 `authority/sourceId/registrationId/configurationRevision/protocol` 五项。后端两处和前端使用同一纯键，名称、任务 ID、Token、费用和质量均不进入该键。

`ObservationRuntimeSummary` 增加可选 `acceptedNames`、本地已登记调用的 `unnamedInvocations` 和 `tasks: {taskId, metrics}[]`。名称来自组内每个已受理 invocation，去重并稳定排序；不能从第一个全局运行时推断其他组名称。混合旧/新回执合并同一个身份组，保留未采集名称的调用数，不能重复 Token。

run-observability 的 taskObservations 在原 `loadTask` 选择、包含范围去重和 CNY 估值之后按运行时身份分组，保留四桶未知/零/下界和金额隐藏语义。observationOverview 在同一 repeatable-read 快照、同一已授权任务样本中附上每个任务的原分组 metrics，再聚合；组汇总等于任务贡献汇总，不读取其他 owner 私表，不引入可变目录联查，也不触发实时模型/采集。

预算沿用现行 200 任务、10,000 invocation、20,000 record；不新增逐任务请求或弹窗请求。超限、撤权与金额隐藏沿用原查询语义，并传播 partial/truncated。CS 金额仍完全由平台事实提供；没有向本地 CNY 定价回退。CS 模型 opaque ref 不解析成实际模型名。

本批 `runtime` URL 参数仅是只读弹窗的身份键，不是服务端筛选参数；不在 25 行任务分页后过滤来伪造完整列表。当前搜索/状态/仓库/历史 workflow URL 兼容不变，服务端维度筛选由 AW-R08 后续设计单独闭环。

## 页面与返回

- 用量页运行时名称为标准任务文字按钮；原受理名、ID/修订/协议与名称缺失说明均可读。各组的金额只显示人民币。
- 新 `ObservationRuntimeDetails` 复用 Dialog、Card、NoticeBanner、TableViewport 与现有 TaskRows；禁止页尾追加详情或新弹窗样式。旧响应/无匹配键/部分样本各有明确空态。
- URL 保留 `runtime` 与原 from/to/period/tab/q/status/repository；切页签、换范围/条件和清除筛选会清除弹窗键。弹窗打开/关闭不重置内容滚动。
- `useObservationReturn` 在打开任务时记录原 main/window、运行时 Dialog body 的滚动与任务触发者；返回相同范围且数据/弹窗已挂载后恢复。范围变化清除恢复记录。关闭弹窗通过显式 triggerRef 回到运行时按钮；原按钮消失时用该卡片稳定焦点入口。
- 中文/英文、浅/深色、390/1280px、长列表末行、Enter/Tab/Esc 和任务详情返回由 hosted 浏览器用例验证。本机不启动 AW 服务、构建或测试。

## 精确源码落位

runtime-management public/application 冻结注册事实；run-observability application 查询其自身受理/账本快照；shared 承担跨进程值合同；frontend 承担显示与路由状态。沿用 RFC-294 的现有公开合同方向；两处旧 services 文件仅补其已有冻结/受理接线，不新增横向依赖、global singleton 或持久 writer。不为本批领取 RFC-294 wave 完成信用。

实施路径以私有冻结清单为准，包括两个 shared schema、runtime-management 的 public/types 和 application/runtimeRegistry、services/nodeRunMint 与 runner、run-observability 两个查询用例、观测组件/路由/双语及专用返回 hook。测试使用现有 runtime-freeze、rfc371-invocation-observations、rfc371-task-observations、rfc371-observation-overview、前端 rfc371-run-observability 与 e2e/rfc371-run-observability；不增加真实平台资源或身份切换。

官方 canonical/治理产物只从 HEAD 加本批精确源码的内存候选生成，不读并行 resource-catalog 四条 WIP；保留所有既有治理记录，按实际产物差异登记到精确清单。不能用重生全仓工作树或放宽基线来通过 CI。

## 必须保留的回归证据

1. 双 provider：首次原名冻结，注册配置变化/删除后恢复和继承不变；同名重建是新 ID，旧无名称/损坏显示元数据不补写目录或改变身份。
2. 严格合同接受旧回执与新原名，拒绝越界/空名称；相同 invocation 原名冲突不改旧文档/价格，稳定原键重放成功。
3. 一个任务多个运行时、多个任务同一运行时、同 ID/修订混合旧/新名称、同名不同 ID/修订、local/CS 同形字符串：组与每任务贡献按完整键精确对账，BigInt 和 pico 元无精度损失。
4. 未知/已知零、未定价、部分桶、隐藏/撤回金额、没有当前目录、200+任务预算均不假装完整；任务名称/状态/仓库限定仍一致。
5. 运行时末行弹窗仅显示该组任务的贡献；进入任务全量详情再返回保留弹窗和上下文；旧响应不回退任务总量；同一 Dialog 关闭/返回焦点真实可见，390px 无水平溢出，卡片使用标准间隔。

先独立设计门，再源码与回归一起实施；完成独立实现门与精确格式/治理生成后精确提交推送，唯该 SHA 的 GitHub Actions 终态及 hosted E2E 作为 AW 权威验证。失败的门和原失败用例均保留，不降低 CI、断言或定时矩阵。


## 2026-10-01 最小补充与第一轮实现门

独立实现 v1 为 FAIL，保留三项 P2：两个回归夹具的协议被推导成 string、新公共 Dialog 未登记双向清单、四份治理 JSON 内容摘要未刷新。最小设计补充独立 PASS 后，将 `overlay-ux-inventory.test.ts` 加为唯一第 22 个实施路径，精确登记 task-execution 族的一次 Dialog 调用；仅保留 fixture 协议字面量，产品 schema/扫描/断言不变。官方内存生成沿用 `--snapshot-sha 7886ac97b979bee331738a9c2486e6b4f3bac114` 的 provenance 分支，保存原 origin 与三条明确单次增长原因。修正后的实现 v2 与精确提交 hosted CI 另行验收，v1 失败不改写为成功。
