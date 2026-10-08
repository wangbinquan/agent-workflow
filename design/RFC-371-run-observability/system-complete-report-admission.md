# System 完整报告入口与原始人口核对修复

真实入口验收中，独立意图生成已产生原 System invocation 与实时 Token 记录，但请求它的完整报告返回 404 `Original Task is not available`。源查询已包含 Task/System，缓存 admission、publish 及每次 retained read 却仍直接查普通 Task 表或做 Task-only join。独立 System 报告因此被拒绝；全局报告含 System 时又在人口核对处失败。这是数据链路缺陷，不能以任务成功或已有队列记录视为统计通过。

## 原始查询与报告链路

Task owner 的完整查询提供 `get` 和 `visibleIds`：用同一个原 executor 查询普通任务和 System group，保留既有 Task、System owner、关联父任务的可见语义。运行观测模块通过 bootstrap 注入工厂，在缓存事务、完成发布事务和每个 retained read 的同一 executor 上绑定它。观测模块不再假定每个执行组必须有 Task 物理行，也不新增虚构任务或直接读取 System 私有表。原 user 状态、revision、报告 seal、revision、平台费用可见性与全部旧检查保持。

人口核对遍历封存报告的所有原始 `tasks` keys 到实际 EOF，每批 200 个仅用于数据库读取调度；总数不受该批大小控制。每个 key 都须由原 owner 查询确认，最终以 BigInt 全部人口与原 summary 对账。保留人口不能被重新选取的更新 cohort 替代。服务缓存族升级到 `scope-metrics/9`，避免复用 Task-only 资格语义下的旧终态；旧报告正文不被改写。

关联系统调用仍包含在所属任务的完整明细和整体汇总中，独立调用以各自原 System group 展示；合并统计按原 invocation / native part 身份去重。重试是独立 invocation，续接按原 native baseline 只计新增用量。未知字段保留缺口及全部已知 Token/CNY，不伪装成 0 或完整。

## CI 配套与原算法边界

4efba2f9 hosted CI 已显示 System pending aggregate 漏 mapper 登记、两条新 legacy 越界边，以及原 root helper 的静态序列化识别遗漏。pending 数量使用既有 engine 数字解码器作为显式 mapper，并保留原返回解码。原 System owner helper 已在调用回调前锁住 invocation 聚合根：守卫登记这一真实 opener，新增双 provider 同一 outgoing root 并行 reset 及普通未串行回调负 fixture；原债务人口、全部旧判据和断言保持。

原 usage 正规化与 invocation 序列算法逐字迁入 runtime-management domain，SHA256 `be5bb50bc212abe6cc8e2784db1368c62e22c99a201d1ed36cba8a5cff7aac68` 不变，legacy 文件只经 exact public participant 合同转出原全部符号。System capture 使用同一 public 原语，native System runner 只消费窄的 public observation callback；不新建 R1/R2 债务、不修改旧 Token、模型或续接算法。首轮原静态配套发现 query 出口经诊断 eligibility 重回 runtime driver，形成新的值依赖环；该实际失败保留，修正为已有纯 participant 出口，随后重新生成变化候选的原配套核对。

两个实际 serving root 的 observationReports 原语句各新增一个精确 inverse 登记，原四个 root 的完整 statement 人口、全部既有映射、previousStatement 及 continuation `61e0831e` 摘要保持。所有原报告 provider 回归只追加所需工厂参数；旧 assertions、fixture 人口、原预算与负例不删改。

## 验收与剩余工作

新增双 provider 用例覆盖无 Task 行的独立 System 任务与重试，211 + 3 已知记录、四类 Token、partial facts；另覆盖 203 个混合原始来源跨调度批次全部读取、关联任务明细、旧缓存族保留与已知人民币费用。原 System 来源测试追加 numeric pending 211 → 0 对账。测试在 GitHub 执行；静态源码/配套生成不代签 hosted CI。

本机已真实完成新成功循环、评审批准、两种澄清停止、只读代码托管调用；这批任务的 13 个记忆作业全部 done。独立意图、运行时探测与 MCP 首次/续接也完成，MCP 本次会话已正常结束。临时六个运行时选择只恢复本会话原值，原任务及用量记录保留。正式完整报告逐 part ID、分类 Token、估值、父/Agent 汇总与页面的对账仍进行中；Git、commit/merge、变更叙述、当前八个数字员工及 CS 部署不能代签为已完成。

修复入口后的真实报告已保留已知数据与缺口：意图构建 5 条记录合计 91,246 Token（输入 38,642、缓存读 48,128、缓存写 0、输出 4,476），因原运行时身份未传入而无可用估值；探针 1 条记录合计 8,576 Token，验收人民币估值 ¥0.011218，但其原 native root 证明仍带 `native-process-incomplete`。这些实际失败证明保留，不将已有数据伪装为完整，也不改写原历史回执；运行时身份和完成接线另行修复后须执行新的真实任务。
