# RFC-522 数字员工与事件中心的适配器回落改为必填注入（RFC-294 S12 第三步）

- **状态**：In Progress（2026-11-20）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 1 项。
- **前序**：[RFC-521](../RFC-521-composition-adapter-fallback-gate/proposal.md)（S12 第二步）立了组合层适配器回落的全模块门与清单：83 处适配
  器回落按模块指定后继。本 RFC 是第 1 项的第二步，清偿 digital-employee 与 event-center 的 5 处。

## 1. 背景

digital-employee 与 event-center 的组合层在调用方没给时自己造一个适配器：

- 数字员工：员工输入工件库（应用目录下的本机文件库）、程序工件库（同上）与写入切换（按数据库与可选的安装端口）；
- 事件中心：观察者程序（没给就用拒绝一切运行的空实现）与自定义观察者程序工厂（没给就用本机实现）。

daemon 的两种部署（standalone / crewstation）都已在部署选择里显式给出这些对象，回落只服务于没有给全的调用方——用例（约 30 个文件）。回落让漏
接线在运行期才暴露，也让“单机默认值只在 standalone profile”这条规则在模块里留了口子。

## 2. 目标

- **G1 必填注入**：上述 5 处改为调用方必须给出：`composeDigitalEmployee` 的 `inputArtifacts`、`programArtifacts` 与
  `writerCutover`，`composeEventCenter` 的 `observer` 与 `customObserverPrograms`；只为回落存在的 `writerInstallation` 选项与
  `selectLocalCustomObserverProgramFactory` 一并删除。
- **G2 用例显式给出**：用例经两个测试助手给出与此前缺省相同的单机选择。
- **G3 门与后继**：RFC-521 门的登记删去这 5 条，适配器回落总数 83 → 78；余下各步按改动面重排（design D4）。

## 3. 非目标

- 其余模块的回落（后继各步）；任何行为、接口与界面变化。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：这 5 处回落不再存在；两个组合函数的对应选项必填；`writerInstallation` 选项与 `selectLocalCustomObserverProgramFactory` 不再存
  在；RFC-521 门的实测与登记逐条相等，适配器回落 78 条。
- **AC-2**：daemon 的两种部署得到的对象与此前相同（传入的仍是部署选择已给的对象）；用例显式给出的选择与此前缺省时构造的对象逐个相同。
- **AC-3**：event-center 的 infrastructure 不再取本模块组合层的值（只余 `composition/required-ports` 的类型 import）；public surface 不升；
  计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
