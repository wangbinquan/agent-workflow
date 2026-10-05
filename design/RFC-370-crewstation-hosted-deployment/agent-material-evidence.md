# H4/H5 Agent material evidence 切面

本记录属于 RFC-370 阶段 A 的一个 source 子批次。它承接已发布的材料 compiler，覆盖 Task 与系统 Agent 的实际取证消费；尚未关闭完整材料／执行／取证组合、三入口真根、脚本及执行权／恢复，也没有 CS adapter 或 AW-in-CS 部署。

`AgentMaterialEvidence` 和逻辑 live capture request／handle 属于 runtime-management application/ports。本机绑定属于该模块 infrastructure/local；现有 runtime 兼容入口只把明确传入的原 native hooks 与物理 scope 接到该实现。正常中立接口不接收 argv、env、cwd、run directory、binary 或 transcript/database path。

| 事实                 | 实际调用者  | 原行为保持                                                               |
| -------------------- | ----------- | ------------------------------------------------------------------------ |
| usage normalizer     | Task        | 最终 plan env、原纯 normalize fallback                                   |
| native usage capture | Task        | invocation、resume、revision；原 acceptance 后才 begin                   |
| span capture         | Task        | 原实际来源与 root identity                                               |
| live capture         | Task        | 原 cadence、callback、signal、stop 和 dedupe Map                         |
| session capture      | Task        | 逐 epoch 与最终 logical root、选定 persistence、退出后补采               |
| inventory            | Task        | 原 node-kind／pure-mode／读失败分类                                      |
| final events         | Task        | fresh-agent 两道门、原非持久化合成观测                                   |
| child sink capture   | System／MCP | 原两次 optional lookup、sink callbacks、failed reason 和 terminal intent |

runtimeSmoke 原来没有这些取证调用，本批不添加新的捕获行为。它的材料／执行与真实 root 接线仍在完整 H4/H5 后续范围。

可选能力缺省时继续缺省，绑定不提前读取物理 scope，也不伪造空或完整取证。原 hooks 保留 receiver；同步异常、原 Promise、结果和错误对象直接透传。已知逻辑字段及 prototype optional presence 明确投影，物理位置只能来自选定本机 scope。live database fixture 留在 native 侧。

原 live poller 的算法和 NOOP、Claude native 实现、原完整 Task/System 消费算法均有 AST 对拍；原 source oracle 的位置更新，原 case 身份、断言、预算和 STOP／post-run 顺序保持。新回归覆盖实际 OpenCode 富清单、Claude transcript，以及能力缺省、最终 env、继承字段、Promise／错误、callback、sink 和 dedupe。

本批同时处理两项已确认 hosted CI 问题：同模块 span factory 改用 composition 私有入口并移除无跨模块 consumer 的 public export；进程回归采用明确的 nullable matcher 类型，保留原 spawnedAt 等值断言。并行 native pages 的失败及未提交内容不归入本批。

R1 有限 SOURCE PASS 保留；原静态生成在发现新 legacy 文件缺少 owner 登记时 INCOMPLETE，没有提交生成结果。本次把同一 binder 归入既有已登记 runtime gateway，原 index API／DRIVERS 和 binder AST 保持。R2 的功能回执、有效生成、匹配 metadata 与发布 CI 分别留证，不能把其中一项替代完整 A-G。

本机只执行 owned format／lint、纯 AST／JSON／字节及原静态规则。实际行为只认新提交的 GitHub CI；CS 合同与 AW 联合验收继续分列。M0 仍在独立 A-G 后以必要 adapters 先部署，后续逐项接入 M1～M4。

## 有限候选与匹配架构清单

SOURCE15-R2 独立功能 PASS，指纹 `9733b649c8f7ed0dd21796b558a97abd865c70e90be669d23b2268de8afb0887`，15 owned／11 control／14 evidence 首末字节稳定。R1 的 PASS 和原生成 INCOMPLETE 原文／回执均保留；R2 只把同一 binder 放进既有已登记 gateway，完整原 registry、binder 及 Task/System 算法 AST 对拍。

原四条静态规则在 committed `0cb05ac928d5df5368fcbad36dc70b09323657d2` 加冻结 SOURCE15 上执行一次，13 份 private 产物有效；6442 非自有源码均读 committed blobs。并行 native pages 测试和六个新增 native usage 实现未纳入本批，原工作保留。sourceDigest 为 `sha256:a1ae054d5539aa95885e53a945687f6f9c057fe1b6493c9935c42c174954a085`。原完整 validator、129 有序库存／原 why、40 required SPI／69 targets／空 implementation SCC 保持。

原 304 commons 债务仅退役一条实际消失的 OpenCode→TE capture persistence 类型边，余 303 条完整字段和顺序保持；具名登记三个实际 compatibility import 分组（gateway 的 value/type，以及 live poller 的 logical type），由原 helper 投影到六条实际观测边，新总数 306。到期目标是 RFC-370 A-T7 selected material and evidence roots，没有放宽分类器或 owner 注册规则。实际库存 entry1875→1876、imports6283→6300、exceptions5577→5594、owners26718→26730 四项匹配增长，正常后继退役已消费许可；public1148→1147 是实际移除一个无 consumer 的导出。

Windows push/PR 对称增加十个实际 watch paths，原 platform suite 加入三个实际测试。完整原 workflow 可通过逆变换逐字恢复；runner、预算、Bun 版本、SQLite 环境、既有 steps 和所有原断言保持。原 case 身份保持，原 expect AST 数量依次 101／14／27／42；wiring 增补四个实际 normalizer 断言，不移除原断言。

基线 `0cb05ac9` 主 CI37252344342 正式 completed/failure（44 success／6 failure），Windows37252344340 正式 failure。两组实际功能问题由本候选修复：native-process nullable matcher 类型和无 consumer 的 span public export；native pages 失败属于保留的并行开发。旧 failure 不改写成通过。当前匹配 metadata 回执、精确发布 SHA、主 CI 和 Windows 新运行分别留证；纯 AST／字节／JSON 与 format／lint 不替代 hosted CI，不代表完整 H4/H5／A-G 或 RFC Done。

## 2026-10-05 RFC-370 Agent 取证批次 CI 修复

5083d73c5bf1f511329613676127a6dfd33186fb 的主 CI37257533997 为 failure，50 jobs 中45 success／5 failure；Windows37257533971 为 failure。Windows 的平台用例259 pass／3 skip／0 fail与shared2295 pass／0 fail只是对应测试证据，两套 workflow 都在 System plan 的 TS18047 类型检查失败，不能报告整体绿色。主 CI 另有原 RFC-317 R2 三条未登记 type/static-import 差额；native pages 并行失败保留其归属，未收进本批修复。

System 修复只在既有 lazy env 回调保留非空事实，类型擦除后的完整原算法 AST 相等；新增实际回归验证 binding 不提前读取 env，且请求读取后来替换的最终 env。有限 EVIDENCE-CI-REPAIR-DELTA2 功能 PASS，指纹ad65e7e676b3b2a573e0ee19a39a66953bec872cdabc0d8974aa2cd62408e0a0。当前 execution WIP 完整保留，本批只发布已审的一处 System type-only hunk，不创建额外 checkout 或 alternate index。

三条实际 RM evidence application→legacy spanCapture／types／usage 类型出边按原判据具名登记，原306条有序记录及why保留，outbound30→33，总数309；退役目标仍为RFC-370 A-T7 selected material and evidence roots。原规则按 committed68be15bfd1ba7ce8ecb1de6a9d357db7232b6bbb 加 reviewed 两路径数据投影执行一次，13 private产物有效，sourceDigest为sha256:68671bf7bb79b244f46d0da2dd3a5f6c6ab8ae85552712f08c7a7d7f6daeb920。原129库存、全部计数、字段、why及permit不变，无新增长许可；原validator通过。其他共享WIP和未审execution内容排除并保留，不改scanner、断言、预算或旧失败记录。

本机只做owned format／lint与纯AST／JSON／字节、原静态投影，没有AW test／typecheck／build／service。匹配metadata门、精确上库和新exact-SHA CI分别验收。仍在A-T5，完整执行／材料／取证组合、所有真根、脚本、H7与A-G继续；CS adapters、M0首次实际部署和M1～M4尚未完成，本批不关闭RFC。
