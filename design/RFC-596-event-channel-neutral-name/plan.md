# RFC-596 实施计划

依赖：RFC-595。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-596-T1 改名与互译**：业务层通道改名、托管适配器新增互译、三处跨层改经它（design §1）。
- **RFC-596-T2 门、用例与文档**：`counts.json`、已知清单、两个用例的夹具；新增 RFC-596 用例并登记（design §2）。
- **RFC-596-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-596-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 integration 的业务层不再出现部署名字面量；通道是 `admit` / `shadow`
- [x] AC-2 互译全且互逆；配置、表与托管入站的行为不变；相关用例通过
- [x] AC-3 `deployment-mode-branch-sites` 上限 1 → 0；其余计数不升；新增 RFC-596 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

基于 `4daf7840b`；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错（两张对照表以 `satisfies` 钉成全映射，两个夹具改用 `admit` 后照常通过类型检查）；eslint 与 promises 配置无告警；改动的 TS 与 RFC
  文档 prettier 通过。
- **读码核对**：业务层只在 `application/crewStationEventIngress.ts` 判断 `channel === 'shadow'`，改名不影响它；通道类型在端口文件之外没有别的引用，也不经 HTTP / WS
  交出（`routes/` 与 `ws/` 里的 `channel` 是 WebSocket 的频道，无关）；integration 业务层里此前唯一的部署名字面量就是这一处。
- **选出的用例**（候选导出）：按改动路径与名字选出，再加上读托管事件入站 / 收件箱、部署分支检测器、架构报告、结构守卫与读 guard-manifest 的全部用例，共 177 个用例
  文件、1708 条全部通过；`rfc321`（要 git 历史）在主树里 10 / 10。
- **变异**（候选导出里逐个施加、跑指定用例、复原）：三种都被认出——业务端口重新写回部署名（RFC-596 用例与 `rfc376-structural-guards` 都红）；互译把配置里的
  `crewstation` 映成 `shadow`（RFC-596 用例红，`rfc370-m3-event-inbox` 的路由与接纳红 6 条）；收件箱写行时绕过互译。复原后导出无残留。
- **架构报告**（候选对照 `4daf7840b`）：60 个计数里只有 `deployment-mode-branch-sites` 变了（1 → 0，design §14“业务层部署模式分支 = 0”成立）；未消费 public 符号 0；
  public 面 804 不变；public 类型偏差 27 不变；跨 context import 7607 不变。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **接纳与影子不变**：配置里 `crewstation` 的绑定照旧被路由为接纳通道、`shadow` 照旧只记录；入站用例按 `shadow` 分支，逻辑一字未改。
2. **持久值不变**：收件箱写行时把业务名译回 `crewstation` / `shadow`，读行时再译成业务名；表的枚举与配置 schema 原样，存量行无需迁移。
3. **互译**：两个方向都是全映射且互逆（`satisfies` 在编译期保证全，用例逐值核对互逆）。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
