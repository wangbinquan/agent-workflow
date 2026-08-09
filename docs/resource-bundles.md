# 资源表达层（`ResourceBundle`）

> RFC-271 交付。本文描述**表达**与**引擎**，不描述配置包的文件格式——那在
> [`resource-packages.md`](./resource-packages.md)。

平台里「一次落多个资源」的场景不止一个（意图会话的确认提交、配置包导入、将来的
模板实例化）。它们共用同一套表达与同一个引擎，而不是各写一遍——**各写一遍的代价
不是重复代码，是每一份都要独立踩一遍两阶段提交、补偿、幂等的坑**。

## 1. 引用（`ResourceRefAst`）

一个引用只有八种形态。**形态本身就携带"这个引用意味着什么"**：

| 变体            | 含义                           | 典型出处                           |
| --------------- | ------------------------------ | ---------------------------------- |
| `id`            | canonical 资源 id              | 运行期一切引用                     |
| `name`          | 裸名字                         | 历史 wire 形态                     |
| `selector`      | 名字 + 可选 owner 用户名       | 工作流 YAML 导出                   |
| `handle`        | `res#<type>#<n>`               | 意图会话的清单句柄                 |
| `local`         | 包/草稿**内部**的 slug         | bundle、intent 的 `$new:`          |
| `external`      | 指向本实例已有行               | bundle 的 update 目标              |
| `call`          | 调用目标（名字权威 + id hint） | `call-workflow` / `call-workgroup` |
| `project-skill` | **不是资源**：仓库自带技能     | `agents.skills` 的 project 分支    |

最后一条最容易做错：`project-skill` 没有 DB 行、没有 ACL、没有 owner。把它表达成
`{k:'name',type:'skill'}` 等于宣称"库里应该有这么一行"，于是闭包遍历会去查、查不到
就判成不可见而整包拒绝——一个**假阳性**。`isNonResourceRef()` 是配套的跳过判据。

### 1.1 每个域一个 codec

wire 拼写是**六个域各自**的事（intent 的 `$new:` / `res#type#n`、import 的
selector、runtime 的裸 ULID、bundle 的 `local:`/`external:`、agent-skill 槽的
`project:`、call 槽的 `name:`）。`ref/codecs.ts` 是这些拼写的唯一词典：

- **跨域形态必须 parse 失败**。`local:x` 出现在身份槽里不是"宽容一点也能跑"，
  而是调用方用错了域。
- 域是**收窄**不是放宽：编码方向同样拒绝拿错变体，不做静默降级。

### 1.2 解析契约（`RefResolution`）

解析由**五个属性**定死，分两层：

| 层     | 属性           | 含义                                        |
| ------ | -------------- | ------------------------------------------- |
| 域级   | `freeze`       | 是否按任务冻结（只有 call 域是 `per-task`） |
| 域级   | `aclAt`        | 可见性判定的时点/主体                       |
| 调用级 | `purpose`      | dispatch / validate / preview / export      |
| 调用级 | `onMissing`    | fail / skip / dangle                        |
| 调用级 | `failureOwner` | node / wrapper / task / caller              |

**两层不能混**。把 `onMissing` 塞进域级，等于宣称"这个域永远只有一种调用方式"——
反例就在仓里：同一条 `dependsOn` 引用，保存期校验要硬失败，而 tolerant UI preview
要静默跳过。

解析器**返回 typed Result，绝不 throw**。直接抛会被 `runScope` 冒泡成任务级
"scheduler error"，把 node/wrapper 级的失败归属整个吃掉。

## 2. `ResourceBundle`

```
bundle = { bundleVersion, ops[], rootRef }
op     = 12 个分支（六类 × create/update）
```

- **create** 带 `slug`（包内标识），**禁止**带 `target`/`expect`；
- **update** 带 `target`（`external:` 形态）+ 该类型**完整**的 `expect` token。

"完整"是有具体内容的：代理的 mutation revision 是 `updatedAt` **和**
`aclRevision` 两个，少一个就漏漂移；技能只改描述会推进 `metaRevision` 而
`contentVersion` 不变，所以两个都要。

payload 逐字段对齐**正式的** create/snapshot schema，不是 intent 版——例如 agent 的
`network` 字段 intent 版没有，照抄会让导入后静默回落成 `deny`。

## 3. `BundleApply` 引擎

`services/bundle/`。五段生命周期：

```
① claim      journal 插入 'prepared'，UNIQUE(scope,key) 幂等
② pre-stage  FS / 安装副作用，每项**动手前**先把补偿信息写进 journal
③ big tx     CAS → provider 二次校验 → 各 commit 内核 + 引用 ACL + owner 断言
             + receipt + journal 'committed'，全部同事务
④ 幂等尾     publish / broadcast，失败无害
⑤ 收敛       启动 + 每小时
```

### 3.1 承重不变量（改引擎前先读这一节）

完整清单在 `design/RFC-271-resource-config-package/invariants.md`（14 条，11 条归
引擎，逐条标注了落点与锁它的测试）。最容易在重构里丢掉的四条：

- **重放是三态**，不是"总是返回 receipt"：`committed` 给原回执、`failed` 报 409、
  `prepared`/`applying` 报未结。第三种**拒绝而不是猜**——重跑会把一次可能已部分
  落地的 pre-stage 再来一遍。
- **duplicate 查询先于其它校验**。排在后面，一次已提交的重放会因为此后状态变化
  而报错，而不是返回原回执。
- **DB 提交之后的任何异常都不得补偿**。`committedReceipt !== null` 是错误处理的
  分水岭——写 catch 块时把补偿一并放进去是最自然的手滑，而那会把一次**已经成功**
  的操作回滚掉。
- **串行键 ≠ 幂等 namespace**。按资源实例串行；拿常量 scope 当串行键，一个慢 npm
  安装会堵死所有人完全无关的操作。

### 3.2 Provider 契约

场景差异全部收进 `BundleApplyProvider`：幂等身份、串行键、执行 actor、
`resolveExternal`、`readSkillFile`、`resolveHumanMember`，外加三个事务钩子。

`resolveHumanMember` 存在的理由：工作组的 human 成员在 wire 上带的是**源实例的
username**，canonical 层要的是本地 `userId`。原样透传既过不了正式 schema，也会在
`workgroup_members` 里留一条永远解析不出人的行。配置包侧把它接到「用户在导入时逐个
拍板」的映射上；返回 `null` 表示该成员不加入，lower 会整条剔除（并连带把指向它的
`leaderDisplayName` 置空）。

`revalidateInTx` **不是可选装饰**：它在 CAS 之后、任何 commit 内核之前跑。
pre-stage 窗口（npm 安装 / 技能暂存）足够长，claim 期校验过的东西可能已经过期。
配置包在这里复核 reuse 目标——那些条目**不产 op**，没有任何 commit 内核会替它们
把关，留空等于全 reuse 的包完全免检。

## 4. 补偿 oracle 必须 record-before-act

任何外部副作用**之前**，先把"足以精确补偿它"的信息持久化。

只把路径挂在抛出的错误上不够：进程可能在 `mkdir` 之后、返回/抛错之前被 SIGKILL，
那一瞬间没有任何异常对象存在过。插件安装因此要求调用方**预铸** generation id
（`plannedGenerationDir()` 让你在动手前算出精确路径）——只记 `{pluginId}` 的话，
崩溃后收敛器不知道该删哪个目录，而粗粒度 GC 又被任一非终态 node run 挡住，
结果是目录永久残留且 journal 无法证明补偿完成。

**记的信息要够「推完」，不只够「回滚」。** 技能版本的 artifact 落的是完整的
`StagedSkillVersion`，不是补偿用得到的那三个字段：abort 只需要 `stagingDir`，而
**committed 之后的重放需要 publish**，publish 要 `newVersion` / `newHash` /
`versionDir` 等全套。只记三个字段的话，一次「DB 已提交、publish 前崩溃」的 run 会留下
一个已入库但内容未发布的技能版本，而收敛器看得见那条 committed 行却推不完它。

### 4.1 两侧对称：补偿没做干净就不许终态化

收敛器一侧早就是这样（补偿抛错 ⇒ 保留非终态，下轮再试），**apply 的 catch 一侧同样**。
两侧写法不对称的后果很具体：catch 里补偿失败却照样 `settleFailed`，而收敛器显式跳过
`failed` 行 ⇒ 那次的残留再也不会被重试，粗粒度 GC 又被非终态 run 挡住 ⇒ 永久残留，
且 journal 反过来宣称「这次什么都没留下」。

代价是同一个幂等键在收敛前重放会拿到 `bundle-apply-unsettled`——那正是事实。

### 4.2 收敛器必须真的被调用

`convergeResourceBundleApplies` 挂在 daemon 启动与每小时后台任务上（`cli/start.ts`，
与 intent 那条并列、各自 try/catch）。没接线的收敛器等于没有：一次崩在 pre-stage 与
big tx 之间的 daemon 会永久留下插件 generation / 暂存技能目录，且那个 importId 每次
重放都答 `bundle-apply-unsettled`。加收敛器时**同一个 PR 里 grep 一次它的调用点**。
