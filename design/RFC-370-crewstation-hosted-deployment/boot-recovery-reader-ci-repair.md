# RFC-370 启动恢复完整根 reader 的 CI 修复

状态：阶段 A 的有限 CI 后继；零 production 改动，不代表 A-G 或 CS 部署完成。

## 正式失败与修复

启动恢复发布 `42458d5274f41d55bc9de88dc5c7986de108127b` 的 Windows run `37472664591` 正式 failure；job `112299909896` 的 RFC-254 platform suites 中，唯一失败为 MCP reader 的 `all three native roots retain every original body statement and argument`。前一 boot 逆向更新 ObjectLiteral 后，下一 verification 逆向读取 synthetic node 的 `parent`，在 TypeScript `isCallExpression` 内抛出 `TypeError: undefined is not an object (evaluating 'node.kind')`。该套件实际 593 pass、3 skip、1 fail；失败保持原记录。主 run `37472664663` 的 14:01 UTC 冻结快照仍为 queued／null，不记全仓绿。

MCP 的两份连续变换 helper 优先使用当前 parent，缺失时从 `ts.getOriginalNode(node).parent` 保留原调用者定位，显式检查 undefined 后调用 TypeScript predicate。未改变三根的任何原完整函数摘要、参数、语句数量、选择或透传判据。新增一条连续 AST 变换回归，真实制造第一次更新的 synthetic parent 缺失并保留 original parent，要求两次逆向均命中且最终完整函数摘要恢复。全部旧 51 expect、测试名、预算及完整旧 reader 字节逆向保持，新增 6 expect。

## 同因 W29 reader 后继

初轮 SOURCE4-R1 已有效稳定 PASS，19 项首末完整读取 6257717 bytes，指纹 `1d29228f94c5915a336b2946ee98a8f4b4164d930eda7a39dd77c1b3592654f3`，回执 28403 bytes／SHA256 `47fabb1957b337c813fe1ccb4a85898df66d3131baf44115590b196d26626bb7`。MCP 和 ledger 内容不变，复用该有限功能结论。

继续用纯 AST 读取实际 PG 根，独立发现 W29 的 boot→verification 逆向具有同一潜伏 TypeError；没有运行本机 AW 测试。只在其两个 helper 使用同样的原 parent 元数据，新增一条实际 PG 根回归。完整旧 W29 文本／AST 可逆，旧 80 expect 全保留，新增 5 expect；四个原完整根摘要分别为 PG `9130fad695ac09680662e30fdd71ed0175a058a27c3c56dc2091ca1fead78e3d`、SQLite deps `9e66815ed188a808cda5a6a3ecc4e45df3a7997122576773c157d8dcdc96fa0d`、API mounts `b03484e283ed230b7a1df205cd3d5034da8aef31abdb0fcebba45d1aae4cd61c`、Event Center `08f37a0d92c9ec7f81a354e138d1bd5e18ffed631e3a676ed1120eb5eecb0c0c`，均保持旧判据。私有 `-w29-proof-r1.json` 实际读取和连续变换 PASS，原错误与修复证明分别保留。

候选因此明确扩为五路径；后继有限门只审 W29、本文档和共享 STATE 必要差额，原 MCP／ledger 作为已审未变 control，未变 H7 生产／census 不重复。新增回归功能执行仍由新确切 SHA hosted CI 验收。

## 架构元数据

本片只正常退役前次 H7 实测增长已消费的五项 `allowGrowth`：mutation-entrypoints、background-jobs、cross-context-observed-imports、architecture-exceptions、module-symbol-owners。129 有序 ledger ID、全部 why、基线、计数及其它原字段逐项保持；恢复这五项即与原 ledger JSON 相同。13 matching 产物和四原 census 规则不变。

原发布 H7 到并行 `7fb0bb9f3f2600b9ca6eb6579cc3a88d35e01749` 的三个完整 production root tree、四原规则及三个额外生成输入 Git OID 相同，共十项。故复用发布时 `sha256:d05ef6a5d7e5bc34e3826afb624edc3390efa8fa11f79bd325b01261f4ba9a50` 人口，不重复 census。起初旧基准检查因 peer 已推进在写入前失败，私有脚本原样留证；仅有限重绑上述同人口证据，不制造 clean tree。

## 有限验证与交付

私有 `/tmp/aw-rfc370-boot-recovery-reader-ci-repair-proof-r1.json` 为纯 AST／字节／JSON PASS：原错误可重现；修复后的连续变换、全部三个实际根完整摘要、旧文件逆向及五许可退役对拍通过。仅 owned format／lint；没有本机 AW tests、typecheck、build 或 service。新增 hosted 回归仍须由后继 exact-SHA CI 验收。

独立实现功能门只核对本片 reader、ledger、该文档及完整共享 STATE 的追加，production 根仅作原摘要 control，不重新检视未变 H7 source gate。发布只允许上述四路径加同因修复的 W29 reader，共五路径；自定义观察器设计和任何并行输出保留在原处。共享 STATE 旧正文全部字节保持。实施门、实际 commit／remote 同步和 hosted exact-SHA CI分别留证；旧 failure／queued 不改写为成功。

完整 H7 执行权和后台生命周期、其余 purpose callers、A-T7／A-G 未完成；CS adapter 尚未开始，AW 尚未部署 CS。后续继续按 M0 首次部署，再增量 M1～M4，不记 RFC Done。
