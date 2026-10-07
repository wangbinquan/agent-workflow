# H7 Intent queued admission 的执行权切面

本片沿已批准的 H7 D1/D2 设计，给实际 queued-resumption owner 增加同一 grant 的实时受理条件。只拥有队列批次的配置读取与 resume 受理生命周期；已经派发的 Intent turn、递归 successor、人工触发和系统执行仍由实际 Intent dispatch/turn owner 接线，不以这个队列切面声明整个 intent group 已就绪。

## 实际入口与独立选择

`intent/application/queuedResumption.ts` 已拥有 pending ID、单一 lifetime、配置读取、批次受理、错误报告及 stop/drain。`intent/composition/queuedResumption.ts` 的原 `runtimeFactory.start()` 由两个实际 provider root 使用。保留其无参 native 入口与原完整批次、错误和 drain 行为，增加独立 `startAuthority({ current })` 入口；`current` 是中立的同步函数，由 bootstrap 捕获原 exact grant context。Intent application 不导入 SO 实现、CS DTO、数据库或 CLI lifetime 类型，也不从 provider/config 名称推导执行权。

所选 lifetime 保留其原 current 函数，到后继 start/drain 前不替换成新 grant。原 `start()` 使用原 native 条件。composition 在原 frozen runtimeFactory 上显式暴露 `startAuthority`，没有 selected-to-native fallback；参数不是修改原 native start 调用形式所需的额外选项。

## 即时检查与真实排空

所选 enqueue 在失权或 stopped 时只将 ID 放入原 pending Set，不启动 read/resume。已登记批次在配置读取前和 awaited read 后检查其原 lifetime 的 current；未获受理时将该批全部 ID 留回原 pending Set，不丢弃、不伪造 resume ACK。原 Set 去重、frozen ID 拷贝及下一 lifetime 的实际配置读取保持。

current 在读取配置期间失效时，即使 SO 的串行 quiesce 尚未到达该 owner，也不能受理新 resume。后继 grant 必须先 stop/drain 旧 lifetime，再以新的原配置实际重读 retained IDs；旧 handle 的重复 drain 不清除新 lifetime。配置读取/已受理 resume/error-report ACK 仍由原批次 Promise 拥有，stop 不把迟到 Promise 当作已 drain。

该 owner 的原 stop 仅关闭新的队列受理并保留未受理 ID，原 drain 等待完整批次和错误报告。两个方法不取消已运行 turn，因此真实 root 的 authority-loss 配对可以显式调用这个 exact handle 的 stop/drain；不能把其他 owner 的 bulk cancel 混入此面。已经受理的 resume batch 按原 provider settle，其内部每个 turn 的即时检查属于后继实际 dispatcher 接线，队列 drain ACK 不替代 turn terminal ACK。

## 回归及交付

新增独立 hosted 套件覆盖所选 standby 零 read/resume、held config 后失权且 quiesce 尚未到达、retained IDs 在新 grant 下重读、已受理 resume 的真实 drain、旧 handle 重复 drain 与新 lifetime 的隔离、native 原行为。既有 `rfc370-intent-queued-resumption.test.ts` 全文及其实际双 provider 根断言/数据库回归保持。原 Windows 路径与命令只追加新套件，所有旧 case 和预算保留。

设计先经独立功能门，再实施和实现门。正式测试以新 exact-SHA hosted CI 为准；本机只做目标格式/lint、纯 AST/byte 对照以及最终生产候选的一次原 scoped census。实际十九 owner 根选择、所有 Intent turn admission、Task 同原事务、UI、完整 H7/A-G、CS adapters 与 M0～M4 继续，AW 尚未部署 CS。

## 当前实现候选

DESIGN1-R1 已经独立功能门 PASS，原十项实际文件和三个包装由根会话完整 EOF 绑定后才实施。application 和 composition 已增加独立入口，捕获原 current 函数并保留原 receiver；旧批次、enqueue、start/stop/drain 和 composition 完整体在只去除新增 selected 条件后与原 AST 完全一致，既有 queued-resumption 用例全文保持。五条新回归已写，目标格式/lint 和纯 AST/byte 对照通过，尚未运行正式测试。

本片 SOURCE4 只评审两条生产源码、一份新套件和本记录。Windows 新套件追加在当前 Runtime/Webhook 候选发布后单独冻结并复核，以保留该候选完整原 YAML；发布前合并两份有效门结论。源码及最终配套、exact-SHA CI、真正 root/turn 受理与完整阶段退出仍分别验收。
