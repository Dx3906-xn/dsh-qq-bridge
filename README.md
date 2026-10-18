# dsh-qq-bridge

把 QQ 接进一个 DSH 智能体：谁在私聊里说话、谁在群里 @ 它，它就在自己的会话里想，然后把回答发回去。

它不是「QQ 机器人框架」，而是一条通道。它自己不做协议逆向、不登录账号、不伪装客户端——它连的是 [NapCat](https://github.com/NapNeko/NapCatQQ) 或 LLBot 这类已经登录好的 OneBot 11 后端。所以风险边界很清楚：**登录和设备指纹的问题归后端，桥只负责「收到消息 → 跑一轮 → 发回回答」**。

---

## 为什么是这样

### 一个会话就是一个 DSH session

企鹅号上「跟谁说话」是可以枚举的：私聊是一个人的 id，群是一个群的 id。所以会话 id 直接由它派生：

```
qq:<namespace>:<kind>:<id>      qq:onebot:private:10001
                                qq:onebot:group:67890
```

第一段是 `sessionNamespace`（默认 `onebot`），**刻意不是当前传输的名字**：号是同一个号，换传输不换人，见下面「换传输不换会话」。

四段各自 `encodeURIComponent` 再用 `:` 连起来。**每段都编码**，所以一个 id 里带 `:` 也伪造不出另一个会话的键——这不是洁癖，是「发错人」这个错误的唯一防线。

这个 id 同时是 DSH 的 session id，落在磁盘上，重启后 `resume` 而不是 `create`。**一个桥如果在重启后把对话重新开一遍，对用户来说和失忆没有区别**，而失忆看起来就像记忆插件坏了——所以「先问存储里有没有，再决定 create 还是 resume」这件事值得单独写一段代码。

群是**一个群一个会话**，不是每个成员一个。群里多个人的话进同一个上下文，因为群里的人本来就在同一个房间里；按成员分会话会让 agent 分别回答每个人，而它看见的是同一段对话。

### 群聊默认只在被 @ 时说话，但可以改

三条路线写进配置项 `groupMode`：

| 值 | 行为 | 什么时候用 |
|---|---|---|
| `mention`（默认） | 只有被 @ 才回 | 正常的群。个人号在群里每句都回，结果是被全员静音 |
| `always` | 每条消息都回 | 两三个人的小群当共享记事本用 |
| `off` | 一句都不回 | 挂着看但不说话 |

默认是 `mention`，理由是**社会性的不是技术性的**：它不是一个能力限制，是一个礼貌问题。

`off` 下**即使被 @ 也不回**。@ 不是推翻运维决定的理由——一个人可以在群里 @ 一个明确设置为不说话的号，这是那个人越界，不是配置该让步。

`mention` 放行时会把传输层合成的 `@你` 从文本里剥掉。那个标记不是任何人打出来的字；留着它，模型会学会「别人用第三人称称呼我」。

**手打的 `@LD` 不算 @。** 在 QQ 里从成员列表选中一个人（或者输入 `@` 后从弹出的候选里点选），消息里才会出现一个 `at` 段；直接敲键盘打「@LD」只是四个普通字符，和说「@LD」这个词没有区别。所以 `mention` 模式下后者不会被回应。

这不是缺陷，是唯一可能正确的行为——桥看不到任何能区分「他想 @ 我」和「他在谈论我」的信号，猜错的代价是每一条提到你名字的聊天都触发一次回复。真机联调时我自己就撞上了：手打 `测试带@LD ` 被静默忽略，拉群历史才看出那条消息里根本没有 `at` 段。

排查时不要看会话里的文本，`admit()` 剥标记之后两种来源长得一样。看原始段：`node tools\group-history.mjs <群号>`。

### 工具只有三个，而且刻意少

被外部消息唤醒的 agent，威胁模型和被人敲键盘的 agent 完全不同：它读的是陌生人写的字，而它手上每个工具都是那段字能拉的杆。

所以只有：

- `qq_whoami` — 我是谁、连着哪些会话、今天还能主动发几条
- `qq_send` — 给一个**已经聊过的**会话发一条文字
- `qq_history` — 读回当前会话最近说过的话

**刻意没有**：任选目标、列群、改 `groupMode`、读别人的会话、同意好友申请。

结果是一段提示注入最多能让它往「已经有人在的房间里」多发一句话——和回复路径同权，不多一点。这是设计目标，不是巧合。

好友申请和群邀请在传输层就被丢掉（`notice`/`request` 事件一律不翻译），因为**同意好友是运维的决定，不是 agent 能靠回复同意的事**。

### 空回答不发

模型返回空串时不发任何东西。它可能通过别的通道回了，也可能判断这条不需要回；**编一句填充话比沉默更糟**，因为那句话是凭空造出来的。

反过来，agent 抛异常时**要**说一句「我这边出了点问题，等一下再说。」——静默是错的答案，但每次失败只说一次，不是每次重试说一次。

### 一个会话串行，不同会话并行

同一个 agent 上并发两轮，等于同一个上下文窗口里两段对话交错：模型在回答第二句时已经读到自己还没写完的第一句。所以每条会话一条 Promise 链。

不同会话之间不互相等：一个人慢不该让另一个人等。

---

## 结构

```
lib/
  types.js    JSDoc 契约：QqBackend / QqEvent / QqTarget。没有运行时代码
  text.js     OneBot 消息段 ↔ 纯文本；CQ 码转义；长文本分段
  policy.js   三个决策：这条该不该唤醒、是不是重复、是不是太频繁
  onebot.js   OneBot 11 正向 WebSocket 客户端（可测试：WebSocketImpl 可注入）
  switchboard.js  一个号可以有多条传输；切换是先连后断
  bridge.js   编排：收到 → 投递 → 回答 → 限速 → 分段 → 送出
  host.js     会话 ↔ DSH session：create 还是 resume、怎么成一条 user 消息、哪段算回答
  tools.js    三个工具，以及为什么只有三个
  roster.js   会话名单落盘，让重启后还能主动说话
  index.js    Config + apply：把上面几块接起来；`/qq` 命令也在这里
test/
  *.mjs       断言套件，`npm test` 全跑
  e2e-agent.mjs   真 agent + 真 socket + 假 QQ（要真 key，手动跑）
```

数据流：

```
                                             ┌─ onebot A ─┐
OneBot 后端 ──WS──▶ onebot.js ──QqEvent──▶ switchboard ───▶ bridge.js
                                             └─ onebot B ─┘   │
                                                     （只有一个连着）policy.admit（群模式/白名单/去重/回声）
                                                                 │
                                                             enqueue（每会话串行）
                                                                 │
                                                       host.handle ──▶ DSH session（一轮）
                                                                 │
                                                        回答文本 ◀──┘
                                                                 │
                                                      cleanOutbound → 限速 → 分段
                                                                 │
                                  OneBot 后端 ◀──WS── send_private_msg / send_group_msg
```

`bridge.js` 里没有一次 `import` 到 Cordis 或 OneBot。这不是为了好看：**每个决策都要能在没有模型、没有 socket、没有 profile 的情况下断言**，否则它只能在线上学。

---

## 安装

桥是一个 DSH bundle。在一个 profile 里装它：

```powershell
$env:DSH_HOME = 'D:\A\DSH-L\agent\home'
node D:\A\DSH-L\agent\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile b add D:\A\DSH-L\projects\dsh-qq-bridge
```

然后在 `profiles/<name>/cordis.patch.yml` 里给那一行配参数：

```yaml
- id: qq-bridge
  name: dsh-qq-bridge
  config:
    endpoint: ws://127.0.0.1:3001
    groupMode: mention
    preset: companion        # 用哪个 agent 预设（人设、记忆）
```

后端那边（NapCat）需要开「WebSocket 服务器」，端口对上即可。桥是**正向连接**（主动连后端），所以不用给桥开端口、不用配入站鉴权回调、桥可以随时重启。

---

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就只保留配置，不连 |
| `endpoint` | `ws://127.0.0.1:3001` | OneBot 11 正向 WS 地址 |
| `accessToken` | `''` | 需要时作为 `Authorization: Bearer` 发出 |
| `backend` | `onebot` | 开机先连哪个传输；可填 `backends` 里声明的任一 id |
| `backends` | `{}` | 额外传输，`{ id: { endpoint, accessToken } }`。声明了就能用 `/qq backend <id>` 切过去 |
| `sessionNamespace` | `onebot` | 会话 id 的前缀。**刻意不是当前传输的名字**，改它等于把所有会话改名、把所有人变成初次见面 |
| `groupMode` | `mention` | `always` / `mention` / `off` |
| `allowedGroups` | `[]` | 群白名单；空表示所有群按 `groupMode` 处理 |
| `preset` | `''` | 每个会话用哪个 agent 预设；空用 profile 默认 |
| `provider` / `model` | `''` | 模型路由；空用 profile 当前的默认模型 |
| `workspace` | `''` | 新会话记录的 cwd；空用进程 cwd |
| `language` | `zh` | 信封和工具描述的语言 |
| `minimumGapMs` | `1200` | 同一个会话两次发送的最小间隔 |
| `maxChars` | `1200` | 单条上限，超过在句末切开 |
| `ignoreAutoReply` | `true` | 丢掉对方 QQ 的 `[自动回复]` ，不让它唤醒 agent |
| `dailyProactive` | `0` | 每天允许主动发几条；`0` 是禁止主动 |
| `maxLiveAgents` | `8` | 内存里保留几个热 agent，超出淘汰最久未用的 |
| `rosterPath` | `''` | 会话名单文件；空用 `$DSH_HOME/qq-bridge/conversations.json` |
| `ownerIds` | `[]` | 谁是主人。名单里的号私聊才算主人在说话；空 = 退回旧假设（私聊即主人） |

`dailyProactive` 默认 `0` 是有意的。**主动说话是这个插件唯一由模型发起、而不是由人发起的路径**，所以它默认关着，打开要运维按天给额度。

`ownerIds` 是补上来的，起因是一个真 bug。桥原本用 `own: !group` 判断「这是主人在说话」——**私聊证明的是房间里只有两个人，不是其中一个是主人**。公开账号上任何人都能私聊这个号，所以第一个找上门的陌生人就被当成了主人：B 用主人的昵称称呼他，把主人的私事说给他听，而记忆插件把他说的话记成了主人的自述，连名字都被覆盖了。`own` 现在由这个名单回答，名单为空时保留旧行为，让没有声明过自己的部署不至于突然不认人。**它必须和 dsh-hippo 的 `ownerIds` 一致**：桥用它写消息的 `own` 标志，记忆用它决定一条事实归谁，两边不一致时，桥认为的陌生人在记忆里是主人。


### 换传输不换会话

一个 QQ 号可以被不止一条路摸到：本机的 NapCat、另一台机器上的 LLBot、协议路线不通时换一个端口重启。所以传输是可替换的，而**换的时候进程不重启**——重启还会顺带丢掉每一个热会话和每一轮没说完的话。

```
/qq status              # 现在连的是谁，通不通
/qq backend llbot        # 先连新的，连上了再断旧的
```

三条设计上的取舍：

- **会话 id 跟号走，不跟传输走。** `sessionNamespace` 而不是当前传输的名字进到每一个会话 id 里。否则切一次传输，所有会话改名，每个人都要重新见一次面。
- **先连后断。** 切换失败时留在旧传输上，而不是两边都没有。失败会在回复里说明原因，不谎报成功。
- **只给人用，不给模型用。** 切换没有做成工具：一个被陌生人唤醒的 agent 不该能改变自己被找到的方式，否则一次提示注入就能让整个号停在一个不工作的传输上。


---

## 一些不那么显然的决定

**回声也要拦。** 后端会按自己的账号 id 过滤掉机器人自己发的消息，但那依赖 `get_login_info` 的往返；在连上但还没拿到 id 的那一小段时间里，id 是空的，只看 id 的过滤会把机器人自己的消息当成入站。所以桥另外记住自己发过的文本，见到原样回来就丢。

**长回答按语义切，不按字数切。** 在 `。！？；…，、` 和换行里从后往前找断点；找不到才硬切，且不劈开代理对。拼回去必须等于原文——这条有测试，因为「切消息」这种功能坏起来是丢字，而丢字看起来像模型说话不利索。

**图片不静默丢。** `[CQ:image,...]` 变成 `[图片]`。让模型知道「对方发了张图」比让它以为对方什么都没说更有用。`reply` 引用段直接丢，引用不是内容。

**非文本段不发明。** 不认识的段不输出任何东西。给不认识的段造占位符是往上下文里塞噪音。

**`qq_send` 找不到目标时返回失败，不返回成功。** 一个工具为了「看起来正常」而报告发出去了，是最坏的答案：agent 随后会相信那个人被告知了。

**会话名单是薄的。** 只有 key / kind / id / name，没有消息文本。一份会长出内容的名单会变成另一份必须和会话日志保持一致的东西。

**信封里说「谁」，`source` 里也要说一次。** 文本信封写了 `ㅤ不想（1405337008）：…`，模型读得到，但**记忆插件读不懂**——它只看见一串文本，分不清「主人在说自己的事」和「群友在说群友的事」，于是把后者记成前者的。所以每条注入的消息额外带 `source.speaker = { id, name, kind, own, group? }`。`kind` 必须留在 `'user'`：DSH 会按 message source 的 kind 分流（压缩策略、导出器都认这个键），树外的 kind 会静默掉出全部处理，而 `assertV4MessageSources` 只校验非空且不是 `'plugin'`，其余字段原样保留。（[dsh-hippo](https://github.com/Dx3906-xn/dsh-hippo) 就是按这个字段分主语和场合的。）


**`session/event` 不用。** 会话日志里的消息必须带 id，DSH 在校验时拒收**整个会话**。所以合成消息一律走 `createUserMessage()`，`source.kind` 用标准的 `'user'`——记忆插件、转录导出、压缩策略都按 kind 分流，树外的 kind 会静默掉出全部。

**自动回复不当人话。** 对方 QQ 开着「不在」自动回复时，那句 `[自动回复]你好，我现在有事不在…` 会作为一条真实消息到达。第一次真机联调就撞上了：桥认真回了一句「那我不吵你了」。它不只是多花一次模型调用——agent 有记忆，会把这句话当成对方关于自己的陈述存下来。所以 `admit()` 在开头按 `[自动回复]` 前缀丢掉它（`ignoreAutoReply: false` 可关掉这个过滤）。**只认前缀不认措辞**：`自动回复` 也可以是句子里一个普通词。

---

## 开发

```powershell
cd D:\A\DSH-L\projects\dsh-qq-bridge
npm test                     # 8 个断言套件，不需要 key、不需要号
node test\e2e-agent.mjs      # 真 agent + 真 socket + 假 QQ，会烧 token
```

`npm test` 跑的是 `test/run-suites.mjs`，它把跳过清单写在仓库里并**印出来**：一份只活在别人 shell 历史里的跳过清单会自己长大，直到套件因为没跑而全绿。

两类文件：

- **断言套件**（`text/policy/bridge/onebot/socket/tools/roster/host/switchboard/command.mjs`）：不需要参数，必须全绿。
- **仪器**（`e2e-agent.mjs` 以及假后端 `fake-onebot*.mjs` / `ws-server.mjs` / `helpers.mjs`）：需要参数或真部署，不参与 `npm test`。
- **真机排查脚本**（`tools/`）：需要一个活着的后端，全部只读或只做一次显式动作。

`tools/` 里的五个，按问题选：

| 脚本 | 回答什么问题 |
|---|---|
| `list-groups.mjs` | 这个号在哪些群里、群号是多少、有哪些好友 |
| `watch-events.mjs` | 后端**实际**推来了什么：原始 segment、`at` 数组、`self_id` |
| `group-history.mjs` | 群历史的存储形态：某条消息到底有没有 `at` 段 |
| `send-group.mjs` | 往群里发一条（验证 `send_group_msg` 与回声过滤） |
| `watch-group.mjs` | 那条群消息**有没有唤起一轮**：看会话目录是否长出新文件 |

`watch-events.mjs` 与 `group-history.mjs` 存在的理由值得单独说：**「它到底有没有 @ 我」这个问题不能从会话文本回答**。`admit()` 会把合成的 `@你` 剥掉，所以被 @ 和被手打 `@LD` 的消息在 agent 眼里长得可能一样。只有原始段能分辨。

`watch-group.mjs` 解决另一半：**忽略是静默的**，所以「桥没回」和「桥没收到」在日志里一样安静。它盯着会话目录——桥只在真的把消息交给 agent 时才建会话，因此新文件出现就是「这条唤起了」的诚实信号。

`e2e-agent.mjs` 会自己搭一个一次性 `DSH_HOME`（默认 `<系统临时目录>/dsh-qq-bridge-e2e`）并往里放一个 profile，然后用假 OneBot 服务端驱动：连上、私聊两轮（第二轮必须记得第一轮说的话）、群里不被 @ 时不回、被 @ 时回在该群。它断言的是**库里的行和 socket 上的字节**，不是 agent 说了什么好听的话。

两个跑 e2e 时真踩过的坑：

**不要复制一个活的 DSH home。** `Copy-Item -Recurse` 会顺着 profile 里 `node_modules` 的 junction 展开成几百 MB，而且**筛的是复制那一刻的代码**——改了仓库却没生效，现象是「新功能没起作用」，方向完全指错。所以 e2e 用代码建 home，`node_modules/dsh-qq-bridge` 是指回仓库的 junction。

**这个 home 不能放在仓库里面。** 它的 profile 有一条指回仓库的 junction，于是仓库会通过 `<home>/profiles/qq/node_modules/dsh-qq-bridge` 再出现一次；下一次 `rmSync` + 重建就从「仓库包含 home」变成「仓库包含包含仓库的 home」，一层层套下去直到 Windows 拒绝路径长度。所以默认位置是系统临时目录，传一个仓内路径会被拒绝并说明原因。

删这种带 junction 的目录时，**先 `cmd /c rmdir` 拆掉 junction 再 `Remove-Item -Recurse`**——PowerShell 5.1 会顺着 junction 递归删掉仓库本体。

---

## 状态

能用的：

- OneBot 11 / NapCat / LLBot，正向 WS，断线指数退避重连（1.7×，上限 60s）
- 私聊与群聊，`groupMode` 三档，群白名单
- 一个会话一个 DSH session，重启续接，预设与模型可配
- 三个工具，按后端能力裁剪
- 限速、分段、去重、回声过滤、自动回复过滤、每日主动额度、会话名单落盘
- 传输热切换：`backends` 声明多条路，`/qq backend <id>` 先连后断地换过去，进程不重启
- 10 个断言套件 + 一个真 agent 端到端
- 已在**真 QQ** 上联调通过：NapCat 4.18.38 + 小号登录，私聊收发与记忆注入都正常
- **群聊三档已在真群验过**（群 1070071261）：不 @ 不回，选中 @ 后回在群里且 `@你` 被剥掉，手打 `@LD` 不算 @

还没做：

- **只有 OneBot 这一个协议。** `backends` 切的是同一个协议的几条路（不同的 NapCat、不同机器、不同端口），不是不同的协议。`gui-auto`（GUI 自动化）后端能绕开协议 hook 的风控面，但实现量大，`QqBackend` 接口是给它留的位置。
- **只发文本。** 图片、文件、语音需要先想清楚「模型能不能决定把本地文件发出去」——那是比「它能发一句话」大得多的权限。
- **不管登录。** 桥不启动 NapCat，也不管它的登录态；后端掉线时桥只负责重连。
- **微信没有。** 微信生态是另一套（iLink 长轮询、无法主动推送、不支持群），需要单独一个插件而不是这个插件多一个后端。
- **`relationship` 级别的社交图谱。** 群是一个会话，所以 agent 在群里分不清「谁跟谁熟」；需要的话得在记忆层做，不是这一层。
- **没有协议端的撤回/编辑。** 说错了只能再说一句。
