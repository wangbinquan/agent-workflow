# RFC-370 Purpose bootstrap 所有权补正

状态：DESIGN1-D2 有效稳定 PASS；有限实现候选已落地，源码门／匹配生成／正式 CI 待验证。SOURCE60-R2 的有效稳定功能 PASS 与 SOURCE60-R1 两项 P2／FAIL 均保留。本补正继续原获批 purpose／staging 重构范围；完整 H7、A-G、CS adapters 与 M0～M4 仍开放。

## 实际生成失败

共享 main 已在不改变本任务源码的前提下前进到 `15265ef2b1d435741e4e98e8c0b11c0ccf35d9e6`。SOURCE60-R2 的一次原 scoped census 采用该完整 committed base 加冻结的 44 production／15 test 输入，原四份生成规则不变，在 owner registry 拒绝新增 `services/developmentPurposeSelection.ts`。失败日志、started 标记和原源码门回执完整保留；没有完整 generated metadata，也未写共享 matching。

该 helper 同时选择 Integration program family 与 DA content／staging，并读取 native 环境与默认内容位置，属于 bootstrap 装配。实际旧规则已经把 `server.ts`、`cli/start.ts`、`cli/postgresqlDaemonApplication.ts` 列为 bootstrap；未登记的 legacy services 文件也没有默认归属。

## 补正方案

把三个 selection interface、内部完整 pair 校验和 `composeDevelopmentPurposeRoot` 从本任务尚未提交的新 services 文件移入既有 `server.ts` bootstrap；三个 actual roots 及三个本任务 fixture 从同一 bootstrap 导出读取。保留同一个选择函数，不复制三个默认装配，不新增模块内的跨 owner 装配器。旧 services 文件是本任务未提交的在制品，全文先冻结留证，确认引用全部迁移后删除；它不是已发布的兼容 API。

默认 EvidenceArtifactPort 的 `new EvidenceStore(join(appHome, 'evidence'))` 创建效果由 DA `infrastructure/local/evidenceStaging.ts` 提供 typed `createLocalEvidenceArtifactPort(appHome)`，再经 DA `composition/evidenceStaging.ts` 导出给 bootstrap。该 composition 同时转发原 file document writer 工厂。bootstrap 的 lazy `artifacts()` 使用该工厂，仍在原第一次需要内容的位置创建同一 EvidenceStore，输入已提供 evidenceArtifacts 时保持原对象；三个 selected purpose 的 factory、program、namespace、writer 与子装配 identity 完整保持。

DA 的两个完整 staging 校验 helper 通过既有 exact `public/participants.ts` 转发；Integration application 两个调用者及 bootstrap 都从这个 exact participant 面消费。原 `public/evidenceStaging.ts` 的完整 helper 正文及 DA 内部调用不变，原 completeness、receiver、失败文案和先校验再分配语义保持。沿用现有 integration → development-automation 的 offered consumption，未改变 owner／DAG 规则。

除了上述装配地址、一个 typed native creator 和 exact 转发，本补正不改变九 schema／结果政策、native preparation／process 正文、original getter 修复、业务物化／manifest／approval 政策、staging 清理分支或 ACK 次序。所有已有用例／expect／预算保持；fixture 仅更新导入地址，原三 root／子装配完整正文逆向继续作为内容 oracle。

## 实施与验证

设计门接受后，做上述有限生产修正，保存完整前后正文及精确地址／creator 逆变换；保留原 SOURCE60-R2 PASS、R1 FAIL 与第一次 census FAIL。新的源码候选独立复核该必要差额，复用未变的功能分析，所有实际入口首末完整 EOF 与 candidate 内容绑定。

仅针对自有变更做 format／lint、纯 source parse／AST／字节核对，实际应用行为由发布后 exact-SHA hosted CI 验收。production 内容确实变化后，新的最终候选只执行一次原 scoped census，输出先留私有文件，再做有限 matching 功能门及精确发布。原四份规则与生成判据保持；按真实 classic primitives 核对边界，不能把 canonical role 当作经典债务。

D2 的完整获准正文在源码前独立冻结；上述 helper 完整迁移与 exact participant 转发现为后继源码差额。原两个兼容 P2 的修复和九操作／内容／清理回归全部保留，尚未宣称新最终候选通过 census 或 CI。
