# 配置包（导出 / 导入）

> RFC-271 交付。表达层与引擎见 [`resource-bundles.md`](./resource-bundles.md)。

把一个工作流（或任意一类资源）连同它**递归依赖的一切**打成一个 zip，在实例之间
搬运。

## 1. 包长什么样

```
manifest.yaml   包元信息、requirements、被脱敏字段索引
README.md       中英双段，给人读
bundle.json     机器契约（ResourceBundle）
skills/…        技能文件树，二进制原样
```

`manifest` 与 `README` 给人看，`bundle.json` 给机器——两者刻意分开，避免"为了让人
读懂而改了机器格式"或反过来。

### manifest 字段

| 字段                 | 含义                                                           |
| -------------------- | -------------------------------------------------------------- |
| `formatVersion`      | 比本实例高就拒绝导入                                           |
| `root`               | 这个包是围绕谁导出的                                           |
| `resources[]`        | 闭包成员（slug / type / name）                                 |
| `requirements`       | **导入方需要自备**的东西，不是包的内容                         |
| `secrets[]`          | 被脱敏字段的**位置**（没有值）                                 |
| `danglingCallRefs[]` | 解析不到的 call 目标（late-bound，导入后仍按名字在启动期解析） |

`requirements` 单列的理由：执行档名、插件来源、仓库自带技能、MCP 形态、工作组的
人类成员 username——这些**不在包里**，导入方要自己有。分开列出来，预检就能看到
"我这台机器缺什么"，而不是等运行时才炸。

### 权属：包里没有

包**不携带任何权属信息**（owner / visibility / grant 一个都没有）。导入之后所有
资源归**导入者**所有、可见性私有。带上它们只会诱导导入侧去"还原"一个在本实例上
根本不存在的主体。

这条也解释了一个看起来奇怪的导出限制：**闭包里出现两个同 `(类型, 名字)` 的资源
就整体拒绝导出**。源实例上它们能共存是因为名字是 `(owner, name)` 复合唯一；进了
包 owner 没了，就剩两个都叫 `lint` 的条目，导入方无从分辨。这种包在语义上不可
表示，与其让导入侧去猜，不如根本不产出。构造场景真实存在：工作流引用代理 A（用
Alice 的 `lint`）和代理 B（用 Bob 的 `lint`）。

## 2. 导出

`GET /api/{类}/:id/export-package`（六条），或 CLI。

可选 `?expectedVersion=` / `?expectedSnapshotHash=`：**只 fence root**，对不上给 409
（`package-root-changed`）。防的是「你看着 v1 按了导出，实际拿到 v2」。

闭包成员**取最新、不 fence**——这与任务执行同语义（执行期非 root 依赖同样取最新）。给成员
也 fence 会要求客户端先知道整个闭包才能给出期望值，而闭包正是导出这一步才算出来的。

### 谁能导出

一条原则：**这个人具备整棵树的权限才能导出**，遇到自己没权限的资源就整体不能导出。

- **行级可见性**（含传递依赖）是唯一的读侧判据。闭包里任何一条解析不出可导出的
  行 ⇒ 整包 422。
- **可见即有读权限**：能看见别人的资源就能把它导出来。因此**不做**类型级
  `*:read` 校验——`isVisibleRow` 的 owner/public/grant 判定本身就是读权限模型，
  类型级权限点管的是"能不能走这一类的列表/详情路由"。（这条有一条反向锁测试守着，
  防止后来者以"补齐权限校验"为由加回去。）
- **特权节点分轴**：含脚本节点要 `scripts:author`，含代码平台节点要
  `code-host-calls:author`，两轴独立。

如实记录一处后果：缺 `mcps:read` 的令牌能通过导出间接读到该 MCP 的**非密钥**配置。
缓解是①该 MCP 必须对令牌所属用户 ACL 可见才进闭包，②密钥字段全部已脱敏。

### 存在性不泄漏

"资源不存在"与"存在但你看不见"产出**同形**的错误；name 域的 call 目标零匹配与
全不可见产出**逐字节相同**的包。zip 因此是 store-only + 固定时间戳 + 条目字典序
——带了当前时间或让顺序随调用方漂移，"逐字节相同"就无从断言。

### 脱敏

被替换成占位符的是**值**，结构一律保留：

| 载体                                                                | 处理                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| MCP `config.env.*` / `headers.*`                                    | 值 → 占位符，键保留                                            |
| MCP `oauth.clientSecret`                                            | 值 → 占位符，**`oauth` 仍是对象**                              |
| MCP `command` argv 内嵌 token                                       | 只替换命中的**那一个** token，argv 结构与长度不变              |
| plugin `spec` 的 git URL 凭据                                       | 与 `requirements.pluginSources` 走**同一条**（两处都不含密钥） |
| URL userinfo                                                        | 整段去掉，URL 仍是合法 http(s) URL                             |
| plugin `spec` / `options`、agent `frontmatterExtra`、脚本节点 `env` | 键名命中或高熵 ⇒ 值替换                                        |

**枚举字段绝不脱敏**：把 `type:'remote'` 换成占位符会让导入侧的判别联合直接崩，
而它本来就不是密钥。

硬性要求：脱敏**之后**每个文档仍要能通过它自己的严格 schema。仓里给模型看的
`projectMcpForDump` 是**展示投影**（`oauth` 变成字符串、argv 变成
`‹redacted›-arg-N`、URL query 整段删掉），**不是可导入投影**——复用它会同时造成
密钥泄漏面错配、合法配置丢失、导入解析失败三种后果。

> ⚠️ **技能文件树不扫描**。包里的技能文件按原样打包；如果作者把凭据硬编码在技能
> 文件里，那会原样进包。这是**作者责任**，不是平台会替你兜住的事。

技能内容**不在 DB 里**——`skills` 表只有 `managed_path`，SKILL.md 与全部辅助文件都在
`${appHome}/skills/{id}/files/` 下。导出读整棵树写进 zip 的 `skills/<slug>/files/…`，
**不设大小上限**（一个技能带多大的辅助文件是作者的事，截断会产出一个「看起来成功」的残包）。
SKILL.md 结构化进 payload（frontmatter + 正文），不重复打包一份。

symlink 逃逸在导出这条路径上被挡住：技能目录里一个 `secret -> ~/.ssh/id_rsa`，在线读取只
泄漏给该技能的读者，打进 zip 却会被搬到另一台机器。读取复用 `realpathInside` 的边界。

## 3. 导入

两步：`POST /api/resource-packages/preview` → `POST /api/resource-packages/commit`。
文件由前端持有并传两次，服务端不存暂存态。

### 逐条决策

预检对包里每一条列出本地同名候选（**可以多个**）与允许的动作：

| 动作        | 条件                                                       |
| ----------- | ---------------------------------------------------------- |
| `new`       | 令牌有该类的 `*:create`                                    |
| `reuse`     | 本地有可见的同名资源（**不需要写权限**——它一个字节都不写） |
| `overwrite` | 本地有**你自己拥有**的同名资源，且令牌有该类的 `*:update`  |

**别人的资源可以复用，但不给覆盖选项**——这是两条独立的规则，不是一条。

写权限与界面完全一致：界面上没有 `agents:create` 就没有「新建」按钮，这里也不给 `new`。
某个条目**一个动作都不剩**时整包拒绝（`package-write-forbidden`），而不是跳过它——少掉的
那条是别人的传递依赖，装出来必然悬空。

### human 成员要逐个选映射

工作组的 human 成员在包里带的是**源实例的 username**，本机的 `user_id` 与它没有任何关系。
预检把每个 human 成员列成一个待映射的槽，导入方逐个选绑到哪个本地用户，或选**不加入**。
本地恰好有同名 active 用户时预填为建议值，但仍要用户拍板——同名不等于同一个人。

映射**只对真正会落地的工作组要求**：选了 `reuse` 的工作组不产 op、不写任何成员行，
所以既不要求映射、也不消费客户端附带的映射。

槽位上的 `required` 字段是**兼容既有 wire 契约**的遗留位，当前合法包里恒为 `false`：
canonical 工作组要求 leader 必须是 **agent 成员**（`schemas/workgroup.ts` 的
`leader must be an agent member`），所以 human 槽不可能是 leader。读旧 preview token 时
仍按其中的值执行必填约束（`package-human-mapping-required`）。

映射的**候选基线**同样进 `previewToken` 签名面。不签它，客户端就能把某个成员映射到一个
预检里从未列为候选的 user id——与下面 `expect` 那一版绕法同构。

### 两次之间靠什么绑定

- **`importId`**：幂等键，原样回传。没有它，commit 成功但响应丢失后重传同一个包
  会**再建一遍资源**。
- **`previewToken`**：把**整套确认基线**签死（`importId ‖ actor ‖ packageDigest ‖
exp ‖ canonical(每条目的候选 id / 各候选 expect / 允许动作)`）。

后者的两版错误写法值得记下来，因为它们看起来都挺合理：

1. "preview 下发包摘要、commit 重算比对"——证明不了任何事：客户端可以同时换掉
   文件**和**摘要。
2. "只签 packageDigest"——包一个字节没改也能绕：把 decision 里的 `expect` 换成
   用户**从未确认过**的那一版，签名仍有效、owner 与 allowedActions 也仍通过，于是
   CAS 覆盖了另一个内容。

**用户的选择是自由的，可选项与它们的基线是签死的。**

### 提交时的顺序

① 验签 → ② **duplicate lookup 先于过期检查** → ③ 仅首次 claim 才查 `exp`。

②③ 反过来写，「commit 成功但响应丢失、用户过了有效期再重试」会撞在过期上而
**进不了 replay**——用户看到错误，而资源其实已经建好了。

### 崩溃之后

apply journal（`resource_bundle_applies`）逐次记录尝试。启动与每小时收敛：
`prepared`/`applying` 逆序补偿后标 failed，`committed` 重放幂等尾。带 **active
set + 10 分钟下限**——一个慢 npm 安装跨过小时 tick 是活着的操作，不是崩溃。

补偿未成功时**不终态化**：保留可重试状态，否则那次的残留再也不会被重试，而粗粒度
GC 又被任一非终态 run 挡住，结果是永久残留。

## 4. CLI

```
agent-workflow package export --as-user <u> --type <t> (--id <id> | --name <n>) --out <f.zip>
agent-workflow package import --as-user <u> --file <f.zip>
    (--plan <out.json> | --apply <in.json> | --on-conflict <new|reuse|overwrite>)
```

- **`--as-user` 强制**。CLI 直接读写本机 DB，但仍解析成真实 Actor 并套用与 HTTP
  **相同**的可见性与归属规则——它不是绕过判据的通道。非 `active` 用户直接拒绝：HTTP 侧
  session lookup 对停用用户返回 null，只查「行存在」会让 CLI 给一个停用主体造出可写 Actor。
- **`--id` 存在的理由**：同一个 owner 可以有两个同名工作流（`workflows.name`
  非唯一），`--name` 命中多行时命令**报错并列出候选**，不猜。
- **导入默认两阶段**：`--plan` 写出决策计划（含 human 成员映射）且**不提交任何东西**，
  复核后 `--apply` 提交。计划里带着那次预检的 `previewToken`——`--apply` 消费的是**用户
  复核过的那份基线**，不是重算一遍。
- `--on-conflict` 是一刀切逃生口。三者互斥，且**三个都不给是错误**：导入会创建和覆盖资源，
  没有静默默认这一档。

## 5. 失败原因对照

| 错误码                              | 含义                                                                |
| ----------------------------------- | ------------------------------------------------------------------- |
| `package-export-ref-unavailable`    | 闭包里有你看不见的资源（含传递）                                    |
| `package-duplicate-resource-name`   | 闭包里两个同 (类型,名字) —— 包无法表示                              |
| `package-privileged-node-forbidden` | 含脚本 / 代码平台节点但缺对应权限                                   |
| `package-format-unsupported`        | 包的 formatVersion 比本实例高                                       |
| `package-unlisted-entry`            | 包里有未在 manifest/bundle 登记的条目                               |
| `package-invalid`                   | manifest / bundle.json 结构或引用有问题                             |
| `package-preview-token-invalid`     | 验签失败 / 换了包 / 换了人                                          |
| `package-preview-expired`           | 预检过期（**仅首次提交**会这样）                                    |
| `package-decision-missing`          | 有条目没给决策                                                      |
| `package-decision-not-allowed`      | 动作不在服务端重算的允许集合里                                      |
| `package-decision-unconfirmed`      | 目标不在确认过的候选里                                              |
| `package-selected-target-changed`   | reuse 目标在预检之后变了                                            |
| `package-overwrite-not-owned`       | 覆盖目标不归你所有                                                  |
| `package-write-forbidden`           | 令牌缺该类写权限，且没有可复用的同名资源                            |
| `package-decision-duplicate`        | 同一条目给了多条决策（不靠「后写覆盖」收场）                        |
| `package-root-changed`              | root 在你加载之后变了（`expectedVersion` / `expectedSnapshotHash`） |
| `package-human-mapping-missing`     | 有 human 成员没给映射                                               |
| `package-human-mapping-required`    | 槽位标了 `required` 却选了「不加入」（仅旧 token 可能触发）         |
| `package-human-mapping-invalid`     | 映射目标不是 active 用户                                            |
| `package-human-mapping-unconfirmed` | 映射的成员不在确认过的槽位里                                        |
| `bundle-apply-unsettled`            | 同一 importId 有一次未结的尝试                                      |
| `bundle-apply-failed-replay`        | 同一 importId 上次失败了（不会静默重跑）                            |
