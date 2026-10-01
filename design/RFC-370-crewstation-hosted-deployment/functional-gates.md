# RFC-370 独立功能评审记录

2026-10-01。按 `CLAUDE.md` 的双门及 `docs/dev-gotchas.md` 的独立子代理备选执行；openai-codex 插件工具本会话未提供。评审均在既有 primary checkout/main 按精确路径只读完成，未创建隔离 checkout，未运行本机 AW 测试、类型检查、构建或服务。仅审功能；正式行为、完整 A-G 和实际 CS 联合验收单独记录。

## 设计门

首轮 `/root/rfc370_design_gate` 只读审查 proposal、design、plan、seam-assessment、rfc035-storage 及所引用的实际 AW/CS 合同。结论 FAIL，一项 P2：同 producer 绑定一个 endpoint 无法保留既有同 provider 多 endpoint 的规则和观测范围。具体输入为 GitLab endpoint A/B 分别处理 repo A/B，迁到共享 producer 后单绑定会漏掉一个 source；AW 原 schema 只对 urlToken 唯一，观测键包含 endpoint。

已补正 H8 来源配置与一对多路由绑定；逻辑事件回执冻结完整目标集合（包括空集合），每目标独立受理和恢复，跨订阅新 delivery 复用同一集合，路由修改不扩充旧事件。第二轮指出 MR 受理已提交但 observation 尚未持久化时不能完成目标；已明确 admitted／pending-publication 与持久待发布输入、稳定 key、两类 observe 回执补齐，再标 completed。改稿已由同一独立评审者复读并给设计门 PASS，无剩余可构造失败输入；审查 design blob `1e8674e12d442fe677f637cbed22b5cbc766d3f7`、proposal blob `13a3d0745ccbc13b9ab7d0d07e41137a1508f923`。此结论仅覆盖设计，不代表 A-G 或部署。以下八项纳入 B-T5 正式回归和实际链路验收：

1. 同 producer 的两个不同 repo 分别进入两个 endpoint。
2. 同 repo 显式绑定两个 endpoint，各保留一次观测和各自规则。
3. 一个目标成功、另一个失败，仅恢复未完成目标。
4. 接收提交后丢 ACK、ACK 后重启，完整目标集合不变。
5. 两个订阅为同 eventId 产生不同 deliveryId，每个 endpoint 只受理一次。
6. 接收后新增、删除或编辑 route，旧 event 重投沿用原集合和 binding revisions；已删除 source 保留终态原因。
7. 空集合事件接收后新增 route，旧 event 不触发；历史补发属于显式业务 replay。
8. MR 受理后未 observe、第一类 observe 已提交而第二类未提交、observe 已提交但目标回执未记录时崩溃；重启补足相同 observation key，保留既有 MR 受理及各 endpoint 去重。

CS 当前合同核对点为 `85ee9254a175848d65105d16327e00afbc47cc08`；RFC035 关键合同相对已记录 `35cf5a47` 未变。平台已有验收不作为 AW 联合验收。

## Intent 内容与 scratch 候选实现门

`/root/intent_functional_gate`：PASS，限定未发布的 21 个源代码/测试路径，基准 `ce8a6310adb9576559f4d5100d4916635a104720`；评审候选指纹 `9872857c3af575cad239efb57f590aea66aa42872be66194aef7ca6005c410aa`。无可构造失败输入的功能 finding。

已读全部候选及必要生产 composition、journal codec、SQL persistence、shared schema 和原 provider 回归。确认先 journal 后 stage，逐项 await owner/content/completion；提交前两层补偿、提交后 committed 重试、原 metadata/version 判据、旧整批 unmark→顺序发布→事务收尾、boot active journal 和 scratch 等待/计数/标记。新真库夹具符合原 schema，屏障在 finally 释放。两个启动根及维护 worker 的默认文件接线已核对；完整 H6 尚未覆盖，正式行为待本批 exact-SHA CI。

## 任务操作配置候选实现门

`/root/task_config_functional_gate`：PASS，限定未发布的 14 个源代码/测试路径，同一基准；评审候选指纹 `602107a187bf78f4106795cd021ed221647be59b154357dc26bd1775e3454b53`。无可构造失败输入的功能 finding。

确认六处 mint 冻结原位 await，commit patterns 按次热读和复制；默认文件/失败回退保持，所选 query 失败不读本机配置；driver 每次重新绑定能力，child launch/resume 经同一 driver，能力不进入继承 run-config。真双 provider/双 runtime mint 与 persistence 回归及原源码锁已核对。新测试尚未完整驱动 TaskEngine，接线结论来自源码追踪；正式行为待该批 exact-SHA CI。此结果不能关闭全 H1 或 A-G。
