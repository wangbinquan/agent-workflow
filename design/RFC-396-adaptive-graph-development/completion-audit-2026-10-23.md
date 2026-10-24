# RFC-396 当前完成度与退出条件（2026-10-23）

当前生产与用例候选为 `dfc098c33b3ff94300cf217d9a09298792617a8f`；2026-10-24 05:29 UTC 更新。原逐项审计、R01～R23及历史失败保留，已有候选内容不因共享HEAD变化重跑。R23修复已发布，准确artifact的care旅程、SQLite/PostgreSQL相关回归已通过。

**裁决：RFC保持In Progress。** 准确主CI终态46成功/3失败；Windows新增care用例两次缺少首次profile日志证明，尚未进入CI修复段。Ubuntu/macOS各五个图用例首轮通过。完整graph@2真实GitLab MR/CI、新版托管执行及默认恢复仍无直接接受证据，不能由graph@1或受控外部系统代签。当前结构化证据见[care接受](./graph-care-repair-acceptance-2026-10-23.json)和[准确CI](./r23-ci-acceptance-2026-10-23.json)。

## 1. 逐项完成度

下表“已具备证据”限于所列版本、场景和执行方式。共享应用的实际执行与图类型接线可以组成能力证据，但没有把它写成 graph@2 完整企业旅程已直接通过。

| AC | 要求与当前证据 | 结果及边界 |
| --- | --- | --- |
| AC01 | 新类型、默认岗位、工具注册；实际页面创建员工及受理；真实 launchWork/typeRef、反序重启注册和旧类型兼容。 | 已具备证据。默认 MR 岗位不等于配置了企业 CI；在途岗位保持冻结版本。 |
| AC02 | concern/能力/预算/pin/边际覆盖驱动通用组合；三个真实模型需求得到不同组合，有备选、饱和、顺序和缺口回归。 | 已具备证据。有限启发式选择不承诺数学全局最优，也没有真人理解成本优势结论。 |
| AC03 | 预约、通知、已有模块的真实需求变体；局部读集、依赖闭包、单图及显式更新固定图回归。 | 已具备证据。不以三类案例充当固定业务路由。 |
| AC04 | purpose/sourceIds/concernIds/limitations、版本化表达能力、未覆盖项、非法能力拒绝和语义目录降级。 | 已具备证据。不支持的表达不计为已覆盖或可执行检查。 |
| AC05 | 稳定语义 ID 与布局分版本；同名对象、依赖与行为环区分；300 依赖边变化实际使四图需更新。 | 已具备证据。图一致性不等于业务断言全部正确。 |
| AC06 | 节点、边、路径和视图锚点；人的原话/暂定判断/未知责任贯穿原生协作、保存与实现材料。 | 已具备证据。虚构场景由代理作出的 provisional 判断不是真实业务负责人批准。 |
| AC07 | 提案预览、已读版本过期拒绝、未读并发保留、固定图与三方编辑恢复。 | 已具备证据。固定图不被当作内容正确性证明。 |
| AC08 | 原生审核冻结依据、真实批准读回、拒绝/重审/响应丢失幂等、同 Case 新批准及交付重放。 | 已具备证据。变更依据必须重新批准，不复用旧绿灯发布。 |
| AC09 | 三个真实模型生成代码/测试并消费同一 basis；trace、缺文件/缺 named test 拒绝；托管材料传输读回。 | 已具备证据。真实模型三案例属于 graph@1 内部交付。 |
| AC10 | 结构、设计审核、执行、人工验收分别记录；有限行为检查保留深度/路径/时间/绑定限制。 | 已具备证据。不宣称范围外的全局正确性。 |
| AC11 | 真正执行 profile、退出码、日志与 artifact；准确 tree/basis/profile/environment；失败/未执行/不可读取不误绿。 | R23的准确artifact、SQLite/PostgreSQL回归已通过；Windows新增日志证明仍失败，不能外推全平台完成。准确版本合同保持，不暗换在途profile。 |
| AC12 | 相关语义变化使证据失效、布局不撤销决定；当前 care tree 变化必须重验；人工验收冻结候选。 | R23的准确artifact及双provider回归已通过，新care实际断言新树current、旧树stale。Windows完整care尚未进入修复段，不冒充已接受。 |
| AC13 | 图调用取消/中断、重试/回执重放；准确 artifact 实测关页面、SIGKILL daemon、同 home 无页面恢复同 MR。 | 单机和共享持久化范围已具备证据。新版托管默认恢复归 AC14，尚未直接验收。 |
| AC14 | 普通 Ubuntu CI 分片实际运行 SQLite/PostgreSQL；旧托管 PostgreSQL/传输/审核/profile/内部交付有证据。 | **当前 graph@2 托管缺直接证据**。旧任务仍跑旧镜像，不能称当前版本两部署已全部完成。 |
| AC15 | 桌面与 390/320px、实际文本/控件边界；四种有连线 SVG 的鼠标/Enter/Space；1000 元素、多视图、深依赖测量。 | 已具备证据。大于250元素总览分页；单机固定场景数据不是 p95、峰值内存、泄漏或一般 SLA。 |
| AC16 | 同 Case 的设计、代码、回执、MR与版本入口；真实 Git 发布/冲突/幂等/同树不重复提交。 | 受控 MR 已具备证据。真实企业 MR/CI 仍开放；同树但发布输入变更明确拒绝，不假称更新外部标题/说明。 |
| AC17 | 三个真实 DeepSeek 核心闭环：预约24/0、通知44/0、已有模块13/0；原失败、人工修正和固定组合对照保留。 | 原合同三案例已完成，源码 `ccde54fafcee93c21ca0d66ca79d574f14ef34fc`、graph@1、publication=null。不替代 graph@2 企业旅程。 |
| AC18 | Agent/Workflow/Program 原执行合同、旧脑图/协作门/数字员工；历史读取和反序注册；原 development 双库系统用例仍运行。 | 已具备证据。graph@1 保持冻结语义，没有第二条执行链或静默升级。 |
| AC19 | graph@2 独立验证后接原 publish-mr/observe-mr；默认岗位与待配置 CI 草稿；完整预约页面旅程。 | 已实现并受控验收。不将未配置 CI 岗位写成完整企业 CI 已执行。 |
| AC20 | 同 MR 身份、真实 head/tree、无变化重验、旧新回执重放、中断恢复、真实代码变化子提交。 | 图自身真实 Git 与双库均通过；受控 MR 身份/终态直接证明。 |
| AC21 | Event Center/Attention 后台观察；无页面 daemon 崩溃恢复；共享 Case 终止后零派发/取消执行。 | 默认图 MR 恢复直接通过；Case 取消由共享 OS 双库执行及图接线证明。图辅助调用取消不冒充整个 Case 取消。 |
| AC22 | 线程新版本、classify/acknowledge、no-code/代码修复、原线程回复和自循环抑制。 | 共享系统双库实际执行 + 图路由用例。完整 graph@2 企业评审修复尚未直接验收。 |
| AC23 | CI 日志真实收集、准确 source/target/head、分类/协同/修复/再查；图 beforePublish 独立重验。 | 共享系统双库实际执行 + 图发布门证明。GitHub 仓库 CI 不替代数字人在企业代码平台看护 CI。 |
| AC24 | 当前批准/依据/材料/trace/profile；真实 Git 冲突保留 target-only 文件，错误解法拒绝发布。 | 图自身真实 Git 与双库通过。不承诺模型可解决任意真实冲突。 |
| AC25 | 已配置的外部审批、拒绝/到期/不可用及503恢复；协同子 Case/channel/join；ready/merged/closed。 | 共享系统实际执行 + 图类型接线/终态用例。graph@2 配置审批/协同后的完整直接旅程尚未验收。 |
| AC26 | 同 Case 工作区、主 MR 状态/链接、折叠版本/CI/评审/审批详情、配置入口与明确等待说明。 | 组件和准确 artifact 页面已通过；不以 fixture 页面替代真实企业或新版托管验收。 |

R01～R22 的发现、修复和证据逐项保留在 [全面回顾与 MR 能力补齐](./review-and-mr-parity.md)。后继直连运行新增R23，见[准确产物诊断](./graph-care-projection-diagnostic-2026-10-23.json)；它重新打开发布后当前证据判定的接受条件。R22 的原错误因果和修后真实 SVG、大图结果分别见 [节点诊断](./graph-interaction-diagnostic-2026-10-23.json) 与 [运行验收](./graph-runtime-acceptance-2026-10-23.json)。

## 2. R23改动前后端候选的实际双库证据

[CI 40054322444](https://github.com/wangbinquan/agent-workflow/actions/runs/40054322444) 对应准确提交 `9a900aaa5709b147838f3ea64420050e28468895`。该 SHA 到生产候选 `2e562fb54` 的后端生产/用例、provider harness 和 CI workflow 内容未变，以下已成功结果按候选内容复用。该 run 其他 job 的失败没有被这些结果消除。

| 文件/范围 | 实际成功计数 | job |
| --- | --- | --- |
| rfc396-mr-bridge | 24 SQLite + 24 PostgreSQL | 120753813217，shard21 |
| rfc396-mr-runtime-wiring | 4 SQLite + 4 PostgreSQL + 5纯合同 | 120753813308，shard24 |
| rfc396-mr-job | 1 SQLite + 1 PostgreSQL + 5纯合同 | 120753813173，shard22 |
| rfc396-mr-lifecycle | 12纯 codec/platform；没有 provider 组 | 120753813160，shard23 |
| current-evidence / review-regressions / local-planning / scope-pagination / case-intake | 分别 3 / 16 / 10 / 4 / 4 pass；各含实际两 provider 与纯用例 | shard12/2/20/4/11 |
| 原 development 系统 MR 旅程 | 2 SQLite + 2 PostgreSQL，direct/crewstation 两传输 | 120753813197，shard11 |
| 原 development 冲突系统旅程 | 1 SQLite + 1 PostgreSQL | 120753813266，shard7 |
| 原 development authoring | 26 SQLite + 26 PostgreSQL | 120753813166，shard6 |
| 终态 dispatch / settlement | 分别 14 / 15 pass，包含两 provider | 120753813320 / 120753813254 |

以上计数来自已完成日志的 `(pass)` 行，而非测试名推断。原始日志及带行号的 section 索引位于 `/tmp/rfc396-ac19-26-ci-functional-logs/`。普通 Ubuntu 分片实际注入 `AW_TEST_POSTGRESQL_URL` 并运行两 provider；独立名为 `Backend tests (real PostgreSQL)` 的 job 只跑其固定 RFC357/359 等集合，**不包含 RFC396**，不能单凭其成功认领本 RFC 双库通过。共享系统用例中的 crewstation 是受控传输路径，不是目标实例实际部署。

## 3. 仍需完成的退出条件

1. **Windows care及准确CI归因。** R23已随dfc发布，CI40063460648终态46 success / 3 failure。Windows新care两次停在初次profile证明，原始输出缺失原因尚须直接证据；新用例将保留Node fetch取得的完整artifact响应，因为浏览器trace没有该API回执。历史执行器固定detached行为来自6545db54/e676，execute不在本会话改动内；在未获明确范围授权前不代改。Booking及另两个flaky保留实际失败与重试，不凭文件未改排除生产关联。Static scans仅记失败元数据，汇总失败仍保留。其他定时workflow仍按[CI归因记录](./ci-audit-2026-10-23.md)的注明时间快照记账。
2. **graph@2真实企业MR/CI。** 同一Case串起真实模型/原生设计批准、代码和独立profile、真实MR、真实CI失败日志、分类/修复、重新验证、同MR新head、准确head/target结果与外部终态。专用GitLab571 fixture及runner已真实完成baseline pipeline285/job1155；业务Case尚未创建。准备脚本两处错误已修，05:29 UTC项目接口500阻断接续；正式原行retry未执行。未配置的审批/协同lane仍只引用继承能力证据，不宣称整条直接接受。
3. **新版托管执行与默认恢复。** 04:47～04:50 UTC实际应用503、挂载0可用空间，服务与任务仍是旧镜像。控制面可读不等于应用就绪，profile声明不等于任务升级。恢复后须核对服务与实际任务准确镜像、真实数据库/传输/运行位置、批准材料、MR身份与默认恢复。旧托管内部交付和单机SIGKILL恢复分别保留，不互相替代。
4. **最终关闭记录与发布。** Windows证据、真实企业和托管结论齐备后再更新T20/T21及RFC状态；当前保持In Progress。已验证的代码和历史证据继续有效，当前取证与文档改动另行精确提交，不重建旧任务来抹去失败。

本轮GitLab专用runner与本机验收daemon已正常停止，保留原home、导入批次和失败回执；没有未说明的业务Case或MR。[环境与准备记录](./enterprise-readiness-2026-10-24.json)保留05:41 UTC GitLab500和较早的托管实际核验。待环境恢复后从原台账接续。没有执行共享环境清理、DB直写或旧托管任务强制推进。

## 4. 不应扩大的结论与重复工作

自适应组合的真实变体与固定投影对照已经存在，不能称为理解时间、货币成本或普遍设计质量优势的用户研究。计划中的长期认知收益仍属于后续试用；没有为关闭RFC编造未测数字，也不另开一项未经要求的用户研究作为阻塞。

已通过且候选内容未变的双库、三条原MR浏览器旅程、四类SVG、大图与单机恢复结果继续有效。共享HEAD变化、已有失败仍红或排队时间长都不是重新启动全量门禁的理由。真实企业/托管前提恢复后只执行尚缺的直接验收，并对新发现的本任务缺陷修复和复验相关范围。
