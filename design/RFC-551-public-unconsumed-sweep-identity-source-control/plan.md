# RFC-551 实施计划

依赖：RFC-550。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-551-T1 判据**：类型形状遍历纳入非 private / protected 的构造参数属性（design §1）。
- **RFC-551-T2 撤出**：按 design §2 逐个撤出、挪进内部；迭代复采到两个 context 为 0。
- **RFC-551-T3 门与用例**：`architecture/counts.json` 上限降低；逐名清单 fixture；新增 RFC-551 用例并登记 guard-manifest；随改读旧位置的
  用例与清单。
- **RFC-551-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；按 RFC-533 的口径与 RFC-550 的选法选用例，先跑读源码文本的用例；
  架构报告对照；变异验证。
- **RFC-551-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S9 第七步。

## 验收清单

- [x] AC-1 两个 context 的未消费 public 符号为 0（全仓为 0）；撤出的名字不再从它们的 public 导出；判据把构造参数属性当作实例成员
- [x] AC-2 行为不变
- [x] AC-3 减速带上限随之降低；新增 RFC-551 用例并登记；读旧位置的用例与清单随改
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里
只有本 RFC 的改动，共享 index 为空）；架构报告与变异在候选导出仓库里跑（HEAD `bb34878c7` 加本 RFC 的路径，核对与工作树逐字相同），对照是同一
HEAD 的另一份导出。集中验证查出一处本人缺陷（RFC-550 的用例还钉着 source-control 的上限 8），已改并复验。

- **撤出的实际结果**（以 `bb34878c7` 的导出为基准，逐名清单进 `tests/fixtures/rfc551-withdrawn-public-symbols.json`）：两个 context 的 public 少了
  31 个名字——普查的 17 个里 15 个真正未消费（另两个 `ErrorKind` 经判据修正回到被引用），加四轮“撤出 → 复采 → 再撤”连锁变成未消费的 16 个。
  其中 14 个声明按内容挪进模块内部、17 个转出删掉；identity-access 的 `public/events.ts` 撤空后删除。
- **落位与 design §2 不同的几处**（连锁出来的名字，按实际使用方定）：identity-access 的三个命令类与它们的命令 / 结果类型、访问快照、访问查询
  与它的输入只被已挪走的依赖接口或已删的转出引用，一并删去转出（组合根与用户操作改取 application）；`AdminUserAccessView` 是用户操作投影的
  视图，进 `application/view.ts`；`AuthorityRevisionChanged` 只被事件接收端口引用，随它进 `application/ports/identityAccessEventSink.ts`。
  source-control 的发布模式与发布结果随提交参与者进 `application/ports/repositoryCommit.ts`；凭据选择结果被 domain 的凭据规则使用，进
  `domain/repositoryTransportCredential.ts`（落在 application 会让 domain 取 application），选择端口从 domain 取它。
- **判据修正**（design §1）：只影响四个条目——两个错误类多出字段、两个 `ErrorKind` 多出 public 引用；两个 context 的未消费计数各少 1，
  public 类型偏差、门与其余计数不变。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 33 个 TS 文件（26 个生产文件、7 个用例与测试助手）
  无告警，生产文件另过 promises 配置；prettier：改动的代码、两个 architecture 清单与三件套通过。改写 import 留下的空行已清掉。
- **选择**：按 RFC-533 的口径从 2,994 个用例文件里选出语义层 389 个：改动的 5 个用例、全部 `tests/architecture/`（142 个）、在 import 之外以
  路径点名被改文件的 191 个、点名被撤出名字的 9 个、直接导入被改文件的 54 个、经读被改源码的测试助手的 169 个（改了架构报告，读它的用例都在内；
  层间有重叠）；另补经子进程夹具与测试助手 import 到达运行期有变化的 15 个生产文件的 285 个，合计 674 个。按 RFC-550 的经验先查了按文件记的
  清单（OS 架构清单、commons 内核清单、开放 Record 清单、偏差清单、跨上下文边清单），两个 context 的 public 文件不在其中；读这些 public 文件
  文本的用例里只有 `rfc305` 的导出清单与 `rfc349` 的凭据端口断言要改，开发期已随改。
- **语义层**（SQLite；60 秒；主树 5 个 worker，复跑时不并发其他重活）：674 个文件里 673 个通过。红的一个是**本人遗漏**：
  `rfc550-public-unconsumed-sweep-lock` 钉着 source-control 的上限 8，本 RFC 把它降到 0；改成“不超过 8”并注明由 RFC-551 的用例断言全部为 0，
  两个锁复跑通过，读 guard-manifest 的 22 个用例文件复跑全部通过。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：八种变异各自让 RFC-551 用例红——报告不再遍历构造参数属性（同时让
  `rfc376-structural-guards` 的计数门红）、private / protected 参数属性也被遍历、挪走的端口重新从 public 转出（计数门同样红）、撤出的值回到
  public 的运行时命名空间、撤空的 `public/events.ts` 回来、domain 的凭据规则取 application、public 的用户操作改从 application 转出描述工厂、
  两个 context 之一的减速带上限回到 1。
- **架构报告**（候选与对照各出一份）：未消费 public 符号 17 → 0（全仓为 0）；public 面少 31 个（正是撤出的名字）；后端生产文件净多 4 个（新增
  5、删除 1）；跨上下文 import 清单只是起点从 public 文件换到挪入的内部文件；public 类型偏差（53）、门与其余计数不变。对照导出第一次出数时
  带着 RFC-550 删掉的三个 public 文件（复用旧导出时 `tar -x` 不删上游已删的文件），未消费与不可达都多算了；删掉这三个文件后重出，上面是重出的
  数（`docs/dev-gotchas.md` 已记）。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **结局不变**：挪动的声明逐字搬（事件接收端口与事件、用户操作描述工厂与它的 schema、凭据端口与参与者、提交参与者、端点发现参与者、凭据
  选择结果与发布模式 / 结果的类型），使用方只改 import；新的 public → application 边都是 type-only（用户操作合同推导输入类型），运行期没有新的
  循环。`IdentityUserOperations` 的形状不变（输入类型照旧由同一组 schema 推导）。
- **没有模块外读者受影响**：撤出的每个名字在 `bb34878c7` 都没有模块外生产消费方（架构报告），`tsc` 覆盖 backend 的 src、用例与脚本；e2e 与
  仓根脚本没有取这些名字。public 的运行时命名空间只少了被撤出的值。
- **判据修正**：只把非 private / protected 的构造参数属性当作实例成员，普通构造参数与 private / protected 参数属性不进形状；fixture 与变异
  都钉住了两侧。
- **分层**：挪入的声明落在 application / domain，domain 不取 application（凭据选择结果落在 domain 正是为此）；分层、DAG 与 public 边界的守卫
  照跑通过。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-550 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-551 identity-access 与 source-control 的未消费 public 符号清零（RFC-294 S9 第七步）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
