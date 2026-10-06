# RFC-371 原 TEMP 批量读取实施记录

本片保留完整统计人口、四桶 Token 与人民币估值，仅减少原 snapshot TEMP 工作区的逐 key 往返。查询继续读到实际 EOF，500 key／100 输入是内存及 SQL 数据包大小，不限制任务、调用、祖先或记录总数。

## 实现与有限审查

原 ReportWorkspace 增加必需 getMany；Task scope、原 Worker 请求协议／通道／host 全部转发同一个 snapshot 连接的真实 Map。原 ancestry digest、完整 native path 验证、coverage AVL、外部排序和 allocation 算法保持。四个私有 helper 维护有界缓存与真实写后读；批读等待期间的本地写、flush、淘汰或旧缺失不能替换新路径和 coverage root。

DESIGN20 与补充 DESIGN7 均为有效有限 PASS。SOURCE21 实现门为有效有限 PASS，无 P1／P2；全部候选与必要原合同共 159 个首末指纹稳定，manifest 为 4e2ee536f36d0a48cd1b0c2b96711692dfee5dad4e65fee29fab3bd44c85c28e。原 23 个测试用例／128 个断言的 AST 逐字保持，四 key initializer 和 selector 其余完整函数体保持，原 native fixture 默认深度 80 的逆向 AST 相同。原规模 workflow 与 fixture 不变。这里只执行自有 format／lint、纯 AST／字节／JSON 构造；没有本机 AW tests、typecheck、build 或压测。

新增双 provider 的真实 TEMP 1201 条 self-total、同批 summary 的 known／unknown provider-model／未知桶、超过 4096 缓存及写后读、5001 淘汰、521 link 严格 native 来源、输入包及取消／失败／EOF 回归。原实际 SQLite native ledger 经过 spool／ACK／projection 后再在两个 provider 上完整报告，522 个实际 native link 按 500＋22 拆包。原 max-one PostgreSQL Worker 使用真实 RPC Map，1201 identity／allocation EOF 全部核对；四桶字面值 721801／2165403／3609005／5052607，总计 11548816，验收配置的已知人民币值 36.09005。新增用例随确切 SHA hosted CI 执行，写好回归不等于已执行或原 100K／10M 已通过。

## 匹配登记

一次完整原 scoped census 使用全部已提交 098481069d318c4d08c7515cf612afe2c4f85f4f 与冻结 SOURCE21，未提交 MCP 及其他并行内容保留并排除。原 scanner、classifier、counter、renderer 和 validator 不变；13 份完整私有输出 sourceDigest 为 sha256:e690ef4dc6ee3ca4764d4d029496e31bfcbb1d6b5ec06f6da275231e6f60a697。源码首末保持，没有生成后的 source delta，没有重复 census。

原 129 有序库存的 id／file／symbol／why、345 authored debts、214 guards、40 SPI／69 targets、原 SCC／Task effects 保持。仅为四私有模块的实际 owners 27087→27097 登记本批一次性匹配增长；其他实测计数不变，前批许可已在 committed base 退役，不重复退役。没有放宽原统计人口、预算或规则。13 元数据与本文／共享 STATE 新前缀使用独立有限门；旧 STATE 的完整 committed 098 正文逐字保留。

## 正式页面与运行记录

用户授权后，本机原 bun dev 使用原数据库与原 7456 已恢复 listening；库版本 241。它运行共享 WIP，不能称干净提交部署，也不将并行启动装配收编为本片贡献。正式页面实际查看 8 个原验证任务／14 次执行：已知 Token 123238＝输入 96095＋缓存读取 21120＋缓存写入 0＋输出 6023，已知人民币估值 ¥0.16583，13／14 次调用有用量或零消耗证明；原缺口及未定价继续明确显示，不能补成零或假完整。

总览实际是有数字的四桶堆叠柱；Token 与成本、任务追踪页不重复总览卡片及质量卡片。真实 sequential-retry 任务 19545 四桶为 12941／5120／0／1484，已知估值 ¥0.040314；两条实际 Agent 执行泳道分别 25707ms、25970ms，按真实顺序绘制。390px 详情页面宽度与 viewport 同为390，宽表在本地容器滚动；键盘 Enter 返回与 ArrowLeft 页签切换已验收。原返回控件实测 115.29×36px，未恢复长条布局。私有截图及 DOM 几何收据保留在 /private/tmp/observability-aw-batched-temp-*20261006-v1.*。窄屏、主题及英文的完整所有页签验收仍继续，不将部分查看写作全部通过。

## 正式 CI、部署与剩余资格

此前 6e7601e7 的主 CI 37423713273 终态 cancelled，18 success／5 failure／27 cancelled，不能称绿色；功能失败日志属已由 098 提交的 Runtime 测试配套与旧源码 reader，本片不修改那些文件。更早 1820 的 root/refreshed-link 原 5000ms timeout 留证，未改预算或重跑掩盖，尚未证明关闭。新 SOURCE21 的正式 whole-repository CI 与原 full-report／self-total 规模资格必须按新确切 SHA 验收。

CS 对应修复 1399645122176afe7602481d303a8d1e3483e074 已提交并远端同步；正式 CI 37425270006 全部6项 success。CS 原完整本机 gate 6219 pass／157 原环境 skip／0 fail，6376 tests、1259 files、289050 expects，候选稳定；三个139镜像构建完成。本机部署单独保留原数据库／PVC／已有任务固定镜像／250迁移校验，更新默认新任务镜像和八个组件，部署结果以独立实况收据为准。CS 原规模 37425761713 正在按原100K／10M、240分钟、100样本与 P95<500ms 判据执行；52c8eb74 的两项四小时 timeout 保留，不因小回归或6项CI通过改记规模成功。

原 full-report 100000 Task／10000000 usage，self-total 10000000 records、独立 identity bitmap／EOF、四桶 10M／30M／50M／70M 总160M与验收人民币500元、真实OS资源记录全部不变。默认 development producer OFF，CS native v2 数值消费者／before-final／seal、实际CLI／算力自测、CS托管AW真实联动和两个RFC退出条件仍开放。验收费率只属于明确标记配置，不代表供应商账单。工作继续，RFC不记 Done。
