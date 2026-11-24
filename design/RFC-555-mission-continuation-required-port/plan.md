# RFC-555 实施计划

依赖：RFC-554。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-555-T1**：integration 的 required-ports 交出续接端口；development-automation 新增指定 adapter 并把逻辑挪进去，infrastructure 只做绑定；
  目标 DAG 与 design 的 Mermaid 同批登记虚线边（design §1）。
- **RFC-555-T2 门与用例**：两份精确清单与 `counts.json` 降低；读旧位置的用例随改；新增 RFC-555 用例并登记 guard-manifest。
- **RFC-555-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-555-T4 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S9 第十步。

## 验收清单

- [x] AC-1 development-automation 只在指定 adapter 里按类型取 integration 的 required-ports；续接的 infrastructure 文件不再取 integration
- [x] AC-2 行为与装配不变
- [x] AC-3 目标 DAG 与 Mermaid 同批登记；跨 context 内部文件对 15 → 14；清单与减速带随之更新；新增 RFC-555 用例并登记；读旧位置的用例随改
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里
只有本 RFC 的改动，共享 index 为空）；读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `a74820d0b` 加本 RFC 的路径，用本地提交固化，
核对与工作树逐字相同），对照是同一 HEAD 的另一份导出。

- **本人缺陷一处（已修复并复验）**：`rfc294-design-parity` 另有一个 design 边总数的精确计数（105），新边让它变成 106，选集运行里红；补上计数与
  RFC-555 注释后该文件 4 / 4。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 9 个 TS 文件（3 个生产文件、6 个用例与架构文件）无告警，
  生产文件另过 promises 配置；prettier：改动的代码、两个 architecture 清单与三件套通过（RFC-294 design 只按精确替换加一行，不跑 prettier 写）。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 184 个（经夹具与测试助手补出的都已在选集里），
  修复前 183 个通过、红的一个即上面的计数；修复后该文件通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：四种变异各自让 RFC-555 用例红，另有一个既有门同时红——infrastructure 文件重新取
  integration 的 application/ports（`rfc376-structural-guards` 同红）、adapter 改成值导入 required-ports（同红）、目标 DAG 删去这条边
  （`rfc294-design-parity` 同红）、adapter 以外的文件按类型取 required-ports（`rfc376-structural-guards` 同红）。
- **架构报告**（候选与对照各出一份）：`cross-context-internal-file-pairs` 15 → 14；`targetEdges` 105 → 106；生产文件 +1（新 adapter）；其余门与计数
  不变。adapter 取 required-ports 的边在报告里是 `required-implementation`、没有清偿波次（原先那条是 `temporary-internal-debt`，W4-E8）。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `2263968b9`（实现，父提交是 `a74820d0b`）：exact SHA 主 CI run 45310123056 68 / 70 通过（含全部后端分片与真实 PostgreSQL、三个平台的构建与
  全部 e2e 分片）。红的两格都是环境性的：`Markdown link check (design/)` 是 `design/RFC-378-mindmap-decision-review/research.md` 里外部 GitHub
  链接回 503（本 RFC 不碰该文件），`CI required` 是汇总 job，随前者红；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **结局不变**：match / consume 的逻辑逐字挪进 adapter（按 MR 认领匹配、唤醒判定、显示名、按投递去重的唤醒提示）；infrastructure 用同一个
  `createMissionPersistence(db)` 绑定；development-automation composition 的转出与 bootstrap 把它交给 integration 组合根的装配不变。新用例用内存里的
  Mission 存储复核了匹配、reopen 信号与唤醒提示。
- **形状**：端口的事实源仍是 integration 的 application/ports，经 required-ports 交给指定 adapter；adapter 按端口类型标注，签名漂移在编译期报错。

## PR / 提交

一个提交（CLAUDE.md 的默认：单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交——RFC-554 的 CI 还在排队，
它的转 Done 随下一个 RFC 的提交。`refactor(backend): RFC-555 development-automation 经 integration 的 required-ports 实现 Mission 续接（RFC-294
S9 第十步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
