# 2026-10-07 原生运行验收与当前交付状态

截至 2026-10-07 07:02 UTC，两 RFC 保持 In Progress。代码发布、CI、实际服务、原始记录对账和浏览器布局验收分别判断；已知数字持续显示并标注缺口，不能把不完整采集写成完整，也不能把“缺完整证明”处理为零 Token 或零费用。

## AW 已发布与可核对数字

取消后补采与采集明细展示已发布 [`2e3b68b2cbd170b557f8b9c2c5f17112f35ca1de`](https://github.com/wangbinquan/agent-workflow/commit/2e3b68b2cbd170b557f8b9c2c5f17112f35ca1de)，25 个精确文件，native SOURCE8、UI SOURCE4 和 META13-v2 分别有效 PASS；META13-v1 的原 P2 留存。该提交只允许原 before-spawn 受理且实际同一 child 已 reap/drain 的末尾数字进入原账本，不恢复 Task 写权限或取消状态。采集明细显示任务受理名以及“根会话 / 用量记录”，不把根数伪装为扫描会话数。

[`CI 37582444063`](https://github.com/wangbinquan/agent-workflow/actions/runs/37582444063) 仍等待完整终态；同 SHA 的 [`visual 37582444087`](https://github.com/wangbinquan/agent-workflow/actions/runs/37582444087) 已 completed/success。已按原默认预算触发 Windows、maintenance full 100 clients / 180 seconds、evidence 2 GiB、full E2E、WebKit 和两种完整统计规模的 hosted 验证。启动或排队不是通过；原 25da 主 CI 和 Windows 的失败保持，不能借后继结果回写成成功。未运行本机 AW tests、typecheck、build、E2E、压测或新服务。

原单任务、并行双 Agent 和串行双 Agent 的三个真实完成任务分别为 `01M4A8JRRAQSJED9SWSCN7E4EC`、`01M4A8XPWPHT67X0YECEDXX3K6`、`01M4A8XQ70CSFEYRYTC98TSS3V`。五个原生调用共 14 条数字记录，全部原报告 section 和原 OpenCode SQLite 来源读到实际 EOF；记录 ID 无漏项或重复，分类与模型推理输出合并口径逐条对齐：

| 范围 | 输入 | 缓存读取 | 缓存写入 | 输出（含推理） | 总 Token | 人民币验收估值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 单任务 | 30,157 | 2,880 | 0 | 555 | 33,592 | ¥0.066194 |
| 并行双 Agent | 27,880 | 14,080 | 0 | 657 | 42,617 | ¥0.068056 |
| 串行双 Agent | 27,184 | 15,104 | 0 | 1,304 | 43,592 | ¥0.072352 |
| 三任务汇总 | 85,221 | 32,064 | 0 | 2,516 | 119,801 | ¥0.206602 |

费率属于明确标记的 `obs-native-20261007/r1` 验收配置：每百万 Token 输入 ¥2、缓存读取 ¥0.5、缓存写入 ¥3、输出 ¥8，不能代表供应商账单，也不改已有运行时费率。旧任务 `01M4AA646EQERECVAAK24GGFMK` 的第二轮在原 600000ms 时间预算取消后被旧 Task fence 拒绝，实际首轮已知 12,662 Token / ¥0.040948 仍保留，不补造丢失的原完成证明。

## 同会话续接与真实取消仍待完成证明

修复后的原任务 `01M4AHQA8CN97DGFSP5E6RT9DB` 第一轮完整为 12,345 Token；在同一个 `ses_eeae42004ffeT3M85Ds29jmqcX` 原生根续接，两条实际子会话分别返回 42。操作者仅通过原任务 API 取消，原 child PID 94495 的同 nonce settled receipt 显示真实 reap / drain，final ACK 覆盖 3 个原会话、31 个 parts、6 个 step 到 EOF。六条原数字 ID 与投影逐一相等，没有重计第一轮 baseline：输入 41,494、缓存读取 20,800、缓存写入 0、输出 5,009、总计 67,303；已受理 CNY 估值为 ¥0.133460。

该例未判通过：root completion 尚未写入，随后原 Bun watch daemon 在 06:51:37 UTC 重载。原冻结报告 `1a09fcf7-3758-48d9-84f9-e710f4bca1d7` 保持 `native-capture-unobserved`，通过正式已知用量/费用字段和任务明细展示上述数值，不写成完整采集。实际模型额外执行了一次 `echo`，违反本例“不运行 shell”的提示要求，原事件保留，不称没有执行工具。已在重载后启动 `01M4AJHDF2C78XYD98YDC7KD67` 沿用原工作流/版本/预算复验，尚未取得末尾结果。不会因为开发重载就删除或替换原失败任务。

## CS 部署与当前修复

原发布 `ed95bd7846d50e346bc64e5a4f9a54b12ba68917` 的六项 exact-SHA CI 全部成功，已本机部署八个约定组件，并核对实际 OCI revision、258 个已提交迁移和 spool 写入。其先前真实 E2E timeline zoom 超时与原预算保持；新增诊断不等于已解释旧偶发失败。新的挂载修复尚未发布或部署。

验收专用算力 `01a114a9-4ba8-7000-a4bb-7985dac02376` / `obs-native-development-20261007` r2 的真实模型测试已 ready，原 `rfc027-live-agent/r4` 配置不变。开发 native producer 默认关闭，仅明确的该项目/该算力/r2 被准入。两真实 Agent 执行 Pod 均 Ready，但 Agent 一直 preparing；原完整事件回放各只有 runnerState，原两块新 emptyDir 目录实际权限均为 0777，原严格初始化因此拒绝。不能把没有启动模型当成零消耗。

新修复仅检查原两块挂载均空且 writable 模式准确为 0777 后初始化为 0700，再执行原类型/所属 Runner/独立绑定/原 journal/Pod 标记/reopen 检查。原四条回归完整保留，两条真实文件系统新回归最终 6 pass / 0 fail / 58 expects；首轮 red 与新权限 fixture 的中途失败均留存。有限 CS SOURCE23 有效 PASS。针对这一新依赖候选，唯一一次完整 `bun run check` 已于 06:48:05 UTC 开始，仅使用原非生产验证 PG 55335；原 N6 已成功完整 gate 不重跑。完成后还须本次发布的完整 CI、本机部署、新固定镜像的验收算力修订、正常/续接/取消实际任务以及项目和系统两级四类 Token/CNY/泳道对账，原失败资源通过原 API 清理。

## 仍需要的退出证据

- 新 AW 精确提交的主 CI、原默认定时配置和完整规模终态及原始报告；旧失败/取消保持。
- 同会话续接/真实取消的最终 capture seal 与完整源对账；开发重载、丢失 ACK 和未知尾部需真实记录，不手工写零或造完成。
- CS 新挂载修复的发布/CI/部署，以及新真实任务的两级统计、算力与项目名称、分类明细和时间泳道。
- SQLite / PG 的 100K Task、10M usage 完整规模和实际响应预算；传输分页不能限制总人口，也不能用小样本替代。
- 实际正式页面的明暗/双语/宽窄屏/键盘/返回/卡片间距和网络验收。本机浏览器工具多次连接超时并重置，当前没有锁屏证据；旧隐藏页 width=0 的 DOM 核对不当作可见布局验收。
- AW 在 CS 托管部署的实际联合准入由 RFC-370 owner 交付的接口为前提；本会话继续自己的独立统计和 CS 两级工作，不收编其未提交文件，不发送不必要跨会话消息。
- remaining-work 中 AW-R02～12 与 CS 相关关闭条件逐项取得证据后再关闭，不恢复已取消的 CSV、顶部工作流筛选、“更多筛选”或关注任务长卡片。
