# RFC-551 identity-access 与 source-control 的未消费 public 符号清零（RFC-294 S9 第七步）

- **状态**：In Progress（2026-11-23）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9（public 合同收敛）第 3 项“未消费 public 符号
  清零”；design §14“未消费 public 符号 → 0”。
- **前序**：[RFC-480](../RFC-480-te-collaboration-public-unconsumed-sweep/proposal.md)（撤出规则与判据修正的做法）、
  [RFC-550](../RFC-550-public-unconsumed-sweep-ten-contexts/proposal.md)（另外十个 context 清零，本 RFC 是它留下的两个）。

## 1. 背景

RFC-550 之后，架构报告的未消费 public 符号只剩 17 个：identity-access 9 个、source-control 8 个。其中两个不是真的未消费：
`UserAccessErrorKind` 与 `RepositoryTransportCredentialErrorKind` 是 public 错误类（`UserAccessError`、`RepositoryTransportCredentialError`）
构造参数属性 `readonly kind` 的类型，而这两个类有模块外读者。报告的类型形状遍历不进类的构造参数属性，于是只经它们引用的类型被误报——
与 RFC-480 修过的“不进数组、元组与泛型实参”同属判据盲区。其余 15 个确实没有模块外读者：转出 7 个，直接声明在 public、只有本模块在用的
8 个。

## 2. 目标

- **G1 判据**：报告的类型形状遍历把类的非 private / protected 构造参数属性当作实例成员（与属性声明相同），修正后重采；两个 `ErrorKind`
  回到“被 public 签名引用”。
- **G2 撤出**：按 RFC-480 的规则处理其余的——转出删掉、使用方改取定义处；只有本模块在用的声明按内容挪进模块内部；撤出 → 复采 → 再撤，
  迭代到两个 context 为 0。全仓未消费 public 符号由此为 0。
- **G3 结局不变**：只挪位置与改 import，不改行为。
- **G4 门与用例**：两个 context 的减速带上限降到 0；新增 RFC-551 用例（撤出的名字不再从两个 context 的 public 导出、挪入的声明在新位置、
  判据认得出构造参数属性），逐名清单进 fixture；读旧位置的用例与清单随改。

## 3. 非目标

- S9 的其他项：public 类型污染清单（`PUBLIC_SURFACE_DEBT`）、`public/operations` 的整体豁免收窄（含 `DrizzleOidcProviderRepository`
  改为端口）、跨 context 内部文件对。
- 凭据、身份与授权的行为与判定（本 RFC 只挪类型与转出的位置，不改任何实现）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：两个 context 的未消费 public 符号为 0（全仓为 0）；撤出的名字不再从它们的 public 导出；判据把构造参数属性当作实例成员。
- **AC-2**：行为不变（只挪位置、改 import）。
- **AC-3**：减速带上限随之降低；新增 RFC-551 用例并登记 guard-manifest；读旧位置的用例与清单随改。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
