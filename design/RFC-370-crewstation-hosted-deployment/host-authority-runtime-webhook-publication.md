# RFC-370 H7 Runtime/Webhook 执行权切面发布候选

SOURCE11-R3 的独立有限功能复核已通过，原 R1/R2 失败与修正证据完整保留。本批提供 RuntimeSession 的可选完整 handle selection，以及 Integration 自有的失权停止派发/真实排空切面；实际 bootstrap 尚未接入完整十九个 handles，H7、A-T7、A-G 与 CS 部署仍开放。

## 行为与回归

所选 RuntimeSession 在资源阶段保持 HTTP/WS 可用，执行阶段使用同一 generation 的原 context，按原顺序启动并在每个 await 前后检查是否仍可派发。失权先停止新派发，再等待原 owner 的真实 ACK；迟到 start、失败重试与旧 context 不得重开新一代。正常 pause/stop/shutdown 保留原职责。停止和排空分别记录实际 ACK 的模式，避免等待中的正常停止完成后冒充失权 ACK。

Integration 的新中立 application port 由独立 composition 实现。Webhook worker 在原 claim、guard list 和 barrier 等 await 后重验派发资格；已发出的 apply 仍接收真实结果，失权不批量取消任务。原正常 stop、扫描顺序、错误预算及原 public 合同保持。新增两 provider 的 RuntimeSession 回归和实际 Webhook worker 联合回归，覆盖正常停止/排空与失权交错。Windows 原触发路径与平台命令加入两套测试，原完整 YAML 逆变换相等。

## 唯一原静态生成与配套

一次原 scoped census 固定 6825e230ca358ffb18c2d823ac9c6a568a6d3561，叠加六个冻结生产文件与两个冻结测试文件；其余 6701 个源码读取该提交的完整 blob，Intent 在制品排除。原四条规则逐字保持，十三产物只写私有文件。sourceDigest 为 sha256:c73b8ce0d63e535c56fdd7e17701ac289f0ce2e0ab1076b3864496203b82eb4e，没有因 HEAD 移动重跑。

全部旧 import/exception/owner 行保持：CLI 新增三个 SO public 类型引用，imports 6795→6798、exceptions 5966→5969；新增四个 CLI 符号与两个 Integration port owner，owners 27405→27411。原 public 形状及签名保持，五个旧行只更新实际 consumer 投影，新增 MrTerminalControlRuntime，public 1234→1235。background 仍为 366，仅原 worker 两处 timer 物理行锚点移动。

原生成器的 mutation 完整 opaque 行按原结果保留，总数 1954→1955；不另解释其政策字段。全体原 SCC、target、facade、effects、commons、guard 与其它 payload 保持。经典完整边界数组逐项相等，本批 scoped inbound/outbound 为 1/0，保留已有 CLI type edge。

129 项有序 ledger 的 id、why、其它字段保持，仅五项实测增长加入本次消费声明；正常后继退役，不再生成 census。旧 STATE/plan 全文及并行输出保持，仅追加本批事实。

## 验收边界

源码有限复核与纯 AST/字节/JSON 检查不等于 CI 绿；配套有限门、精确路径上库、远端同步与精确 SHA 的 GitHub Actions 分别验收。本机未运行 AW tests、typecheck、build、service 或 E2E。

后续继续真实启动根与提前恢复、Task 原事务与 admission、其余 owner 和 UI、完整 A-T7/A-G；完成 Stage A 后编写各层独立 CS adapter，先 M0 实际部署，再逐步 M1–M4。当前 AW 尚未部署 CS，RFC 保持 In Progress。
