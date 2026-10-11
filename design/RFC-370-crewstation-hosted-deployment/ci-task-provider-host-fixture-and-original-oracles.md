# RFC-370 Task provider 装配：真实 CI 夹具及原判据修复

本片仅修复 `ca6f8417e3c4903966e72d21f89264b7756b6586` 的实际 CI 失败。原 Task provider 装配及并行 RFC-371 缓存已于 `4037254b`、紧邻七项许可退役 `ca6f8417e` 发布；后继主 CI `38171413992` 与完整 Windows `38171413874` 暴露以下问题。原 SOURCE／MATCHING PASS、原失败、原生成历史和所有并行输出分别保留，不代签本片。

## 实际问题及修复范围

1. Windows `114564630142` 与 Ubuntu shard 5 `114564631204` 的 29 项新 SQLite provider case 在装配前即失败。`providerGraph` 把 `routeWorkspace` 仅放在 PostgreSQL 接收的顶层，而 SQLite 的 `SqliteTaskRouteLaunchDependencies` 从 `routeLaunch.routeWorkspace` 接收它，最终 `taskRouteWorkspaceParticipant.ts:200` 读取 `repositoryPreparation.legacy.reclaim` 时缺少依赖。现在同一份完整工作区输入按两种 provider 的真实合同分别传入；所有外部协作者有完整类型，未涉及的操作一旦实际执行仍抛出原 “outside provider assembly test” 错误。删除对整份 provider dependencies 的两次 `as unknown as`，保留刻意构造不完整宿主／不兼容输入的原负向用例。原 DB、module、persistence、认领、controller、实际 driver ACK 和全部行为断言保持。

2. Windows 同作业、Ubuntu shard 31 `114564631304` 和 macOS shard 7 `114564631265` 的原 Task lifecycle 源码判据不能还原新增 provider 装配片段。仅在原 `inverseHumanGateTaskSelections` 之前调用已经检视的完整 `inverseTaskProviderHostAssembly`；该 helper 先还原并行 RFC-371 的两个 CLI 根的四个原生 hook，再还原本片 11 份原文件的 177 个有限片段。原 21 个调用、15 个 purpose selection、参数、全源码 bytes／SHA、负向变异及原人数全部保持，不把新源码摘要替换成旧判据的期望。

3. macOS shard 9 `114564631353` 的原 RFC-103 配置透传源码 case 使用固定 `slice(..., ... + 1400)` 窗口；新增 driver binding 片段把原热读配置文本推到了窗口之外。只对该 case 的 `server.ts` 输入调用同一完整 assembly inverse，原 1,400 个 UTF-16 code unit 窗口、起始锚点和全部配置透传断言保持，不扩大窗口。

4. macOS shard 2 `114564631260` 的原账本数量 case 发现 `rfc359-w5-test-engine-hardcoding` 的实际条目数为 342、配套基线仍为 340。联合发布已登记两份 RFC-371 外部 OpenCode 固定 SQLite 文件夹具：`helpers/rfc371PersistentNativeFactFixture.ts: 1` 与 `rfc371-native-source-version.test.ts: 1`。仅以原 `ledgerEntryCount` 取得本份已命名字面量账本数量，同步这一行基线和理由，保留全部原条目、分类、规则及其他行。为本次基线增量显式记录一项短暂 `allowGrowth`，并准备紧邻普通退役提交；原 `ca6f8417e` 的失败记录不补造为通过。使用原 `withArtifactProvenance` 纯函数更新该数据的摘要，不执行新的 census。

5. 主 CI `114564630892` 的唯一 Format check warning 是 `packages/backend/db/migrations/meta/0244_snapshot.json`。该文件已有单独有效、稳定 PASS／零 findings 及根消费记录。完整 JSON 值、31,199 个字符串字面量与 509,642 byte 的非字符串外空白 token 流均保持，仅减少 24,635 个字符串外空白字节。此片复用该格式修复，不重新检视数据库算法。

## 保持与门检视

新 provider fixture 的原 `selected` 及后续全部 case 文本保持；三份测试的原 `expect(...)` 表达式逐项保持。两个旧测试分别通过限定逆变换恢复其完整原 bytes／SHA；新增输入层不执行产品或测试。原 P12 继续验证 11 份完整生产源码的还原、无关 suffix 保留和已引入片段变异拒绝。不得把 source preservation 声明为实际 Task 行为通过。

本片不改生产行为、原测试人数、断言、超时预算、Windows 登记、生成规则、原架构清单或扫描器。只有测试输入、精确配套基线、上述格式及本说明属于本片候选。原 Task 29 provider＋一个 source 的三平台预期 119 次仍需修复后 GitHub Actions 的实际具名日志验收；此前真实失败保留。所有 AW 本机 test／typecheck／build／测试服务／E2E 均未执行，只做限定格式／lint、纯语法与完整内容保持检查。

独立实现门只审功能正确性、完整性与回归；完整 receipt 的分析、每个 owned 结论和全部实际 EOF 身份由根消费后，才进入短暂 shared-main 发布。格式片的独立 PASS 按完整内容复用。精确文件暂存、共享 index／双方 publication lock、提交路径／真实 co-author、紧邻许可退役与 push 前后同步分别验证。

## 仍待验收

RFC-371 的原生页／原报告 Worker 失败、原迁移头 243／244 差额与 `HistoricalNativeVersionObserver` 的 public consumer 归属已交给「设计运行观测统计全景」会话；不在此片接管缓存实现。共同修复或相继精确发布后，新确切 SHA 的完整主流水线、默认完整 Windows 和全部 Task 新旧具名案例必须实际成功，才恢复后续 RFC 生产实施。

完整 H7／十九 owner／三个生产启动根、A-T7／A-G、各层独立 CS adapter、先 M0 实际部署再 M1～M4逐步适配，以及 RFC 完成仍开放。AW 尚未部署到 CS。

## SOURCE-R1 实际失败与后继候选

有限 SOURCE-R1 为有效、稳定 FAIL／一项 P2，根已完整消费正式回执中的九项功能分析、五项 owned 结论、38 项材料三轮 EOF 及 manifest／四份具名材料。该门发现新 typed fixture 的 PostgreSQL 装配遗漏原必填 `workgroupTaskRoom.collaboration`；真实工厂在返回 graph 前无条件读取这一格。现只在 PostgreSQL 实参恢复原 throw-on-use collaboration 槽，原 required 类型、真实 DB／module／driver 和全部旧 case／断言／预算保持。原 R1 失败材料与回执不改写，新增 R2 单独验收。

主流水线最后完成的原 W7／W8 失败另见[活跃度与站点设计](ci-legacy-activity-and-lineage-design.md)：原插入点上方文本增加导致唯一行号登记 2504→2537，SQLite 原活跃度端口直接暴露新增可选参数导致 `.length` 1→2。这两项有限修复保持原判据，按独立设计及后继源码门验收，不折入已冻结的 R1。

该有限 DESIGN-R1 为有效、稳定 PASS／零 findings，十项功能分析与八材料三轮 EOF 已由根消费。已在既有 legacy 装配点落实一参数同步委托，原 await 回调和冻结形状不动；W7 仅更新真实行号和理由，原六个 `expect`、四个 case、完整 AST matcher 与预算逐字保持。纯原 matcher 只解析四份已命名源码字符串，确认四站点三列与新登记完全一致；不是原测试执行或新 census。全部十一份生产 preimage 仍还原到各自完整原 bytes／SHA，新增夹具的原 97、生命周期 170、配置 56 个 `expect` 表达式均保持。R2 实现门及 hosted 行为另验。

本片自身三测试／数量／格式修复没有新生产 census。联合候选另含经独立检视的原活跃度装配修复及缓存会话的真实 public consumer 装配修复，因此双方源码冻结后共同执行一次必要的原 scoped census，并单独检视配套；不得用此前 342 字面量数量纯检查或旧联合发布的生成结果代签新生产输入。maintenance 并行候选完整排除。新确切 SHA 的完整主 CI／完整 Windows 总绿及真实目标执行仍待验，原预算和过去失败继续保留。
