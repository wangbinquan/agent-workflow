# RFC-343 — Intent Apply 恢复正确性（RFC-294 P0-B）

- 状态：Done（2026-08-30；RFC-294 P0-B、canonical replay 与 exact-SHA hosted closeout 已完成）
- 授权：用户于 2026-08-29 明确要求“开始落地剩余 P0”
- 同步基线：`69eaf95488c86c5190fd7ff1360cf272b7826979`
- 主实现：`f21d6142a3c15f93a51fb21dcac063f22d3a94f3`
- current canonical：`f94290d715365ee6c46e927c211a00326834157b` →
  `d2a4cc742c6dbb318b237ede15155b354cd79584` → `67a97480c5944c723d3ee08490631e4db768a5c6`，source digest
  `sha256:3714450fee40135133fb94fb846d6f4f32369d00625d8f7249e6049a80c73805`
- hosted closeout：Main CI `33268925250` 与同一 exact SHA 的 8 个定时 workflow 全部 terminal success
- 前置：RFC-234、RFC-271、RFC-293、RFC-294
- 范围：Intent apply session lock、compensation terminality、versioned journal artifact、prepared/committed convergence、
  crash/corruption/mutation tests

## 1. 问题

Intent Apply 已有 durable journal，但四处实现细节让 recovery contract 弱于其宣称的语义：

1. session lock 的 cleanup 与 map 中实际 promise chain identity 不一致，可能留下 residue 或错误清除后继；
2. compensation 失败仍把 journal 无条件标成 terminal `failed`，后续 converger 无法恢复；
3. `skill-version-stage` journal artifact 是不完整/隐式 JSON，committed recovery 缺少重放完整版本所需字段；
4. convergence 把旧 audit row 当本轮成功结果，或在 durable commit 后 throw 时反向补偿已提交事实。

## 2. 目标

- per-session 串行锁只由 map 当前实际 chain 清理，高基数完成后 residue=0；
- compensation 任一失败时保持 prepared/retryable，只有全部补偿成功才进入 terminal failed；
- journal artifact 使用显式 version=1 codec，完整保存可恢复的 skill/plugin facts；
- prepared 与 committed convergence 都能幂等收敛，corrupt/lossy artifact fail closed 且保留 retryability；
- durable commit 之后的异常不得触发补偿；重复 convergence 不重复发布版本或误报成功。

## 3. 非目标

- 不提前实现 RFC-294 W6 的统一 Bundle Apply engine；两套引擎可暂时共存。
- 不改变 Intent workbench 的 REST/UI wire、审批模型或用户功能。
- 不增加 migration；现有 journal artifact text 列承载 versioned envelope。
- 不做额外门检；只验证 apply/recovery 的功能与一致性。

## 4. 裁决

### D1 — lock map 保存并比较同一个 tail chain

每个 session 新请求链到当前 tail；cleanup 只在 `map.get(sessionId) === chain` 时删除。测试导出的只读计数/重置 seam 只用于
锁 residue mutation proof，不进入生产调用。

### D2 — durable artifact 是 compensation 与 recovery oracle

一旦 operation journal 已持久化 artifact，补偿/收敛不依赖本次进程的 success-only memory map。crash/restart 后同一 codec
能还原 operation 所需事实。

### D3 — compensation failure 不是 terminal failure

prepared operation 的补偿逐项尝试。任一补偿失败时保留非 terminal journal state 与 error，converger 下次重试；禁止把
“回滚也失败”写成不可再处理的 `failed`。

### D4 — skill-version artifact 必须完整且带版本

V1 envelope 保存完整 `StagedSkillVersion`，包括 skill identity/name、operation/publish identity、版本序号、content hash，
以及 live/version/staging path 和 no-op snapshot。DB commit 已持久化的 source/author/changelog/createdAt 继续以
`skill_versions` row 为权威，不在 recovery artifact 里复制一份可漂移的事实。
legacy empty/plugin/skill-create artifact 可无损兼容；历史 lossy skill-version array 无法证明完整事实，必须 fail closed。

### D5 — committed recovery 只 roll forward

operation 的 durable commit 一旦存在，就只把尚未发布的 committed artifact roll forward。commit 后 throw、进程退出或重复 converge
都不能补偿/删除已提交版本，也不能从旧 audit row 重发 stale version。

## 5. 验收标准

- **AC-1**：同 session 严格串行，不同 session 可并行；最后一个 chain 完成后 lock map=0。
- **AC-2**：高基数 session corpus 完成后零 residue；改回错误 identity 比较时测试变红。
- **AC-3**：compensation fault 后 journal 保持可重试，下一轮 convergence 最终 settle failed。
- **AC-4**：V1 skill-version artifact roundtrip 保留全部字段；字段删改、unknown version、corrupt JSON 均被拒绝。
- **AC-5**：prepared/committed crash points 重放幂等；durable commit 后 throw 不触发 compensation。
- **AC-6**：完整 committed skill-version tail 只发布缺失版本，重复 convergence 不增加版本/审计。
- **AC-7**：artifact parse corruption 不计 convergence success，不把 row 终结成假完成。
- **AC-8**：发布 SHA 的 hosted CI 终态成功后才关闭 RFC-294 P0-B。

## 6. 完成记录

AC-1～AC-8 已在 final implementation exact SHA `67a97480c5944c723d3ee08490631e4db768a5c6` 闭合。该 SHA 的 Main CI
`33268925250` terminal success；e2e-full `33268950624`、e2e-webkit `33268950212`、evidence `33268949064`、
git-protocols `33268950157`、integration-opencode `33268949548`、maintenance-soak `33268952181`（同 SHA attempt 2）、
visual `33268950915` 与 windows-platform `33268951134` 也全部 terminal success。RFC-343 据此 Done，并只关闭 RFC-294
P0-B；W6 仍须另立独立 implementation RFC。
