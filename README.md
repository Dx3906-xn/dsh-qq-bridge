# dsh-qq-bridge

把 QQ 接进一个 DSH 智能体：谁在私聊里说话、谁在群里 @ 它，它就在自己的会话里想，然后把回答发回去。

它不是「QQ 机器人框架」，而是一条通道。它自己不做协议逆向、不登录账号、不伪装客户端——它连的是 [NapCat](https://github.com/NapNeko/NapCatQQ) 或 LLBot 这类已经登录好的 OneBot 11 后端。所以风险边界很清楚：**登录和设备指纹的问题归后端，桥只负责「收到消息 → 跑一轮 → 发回回答」**。

---

## 为什么是这样

### 一个会话就是一个 DSH session

企鹅号上「跟谁说话」是可以枚举的：私聊是一个人的 id，群是一个群的 id。所以会话 id 直接由它派生：

```
qq:<backend>:<kind>:<id>        qq:onebot:private:10001
                                qq:onebot:group:67890
```

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
  bridge.js   编排：收到 → 投递 → 回答 → 限速 → 分段 → 送出
  host.js     会话 ↔ DSH session：create 还是 resume、怎么成一条 user 消息、哪段算回答
  tools.js    三个工具，以及为什么只有三个
  roster.js   会话名单落盘，让重启后还能主动说话
  index.js    Config + apply：把上面几块接起来
test/
  *.mjs       断言套件，`npm test` 全跑
  e2e-agent.mjs   真 agent + 真 socket + 假 QQ（要真 key，手动跑）
```

数据流：

```
OneBot 后端 ──WS──▶ onebot.js ──QqEvent──▶ bridge.js
                                              │
                                     policy.admit（群模式/白名单/去重/回声）
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
| `groupMode` | `mention` | `always` / `mention` / `off` |
| `allowedGroups` | `[]` | 群白名单；空表示所有群按 `groupMode` 处理 |
| `preset` | `''` | 每个会话用哪个 agent 预设；空用 profile 默认 |
| `provider` / `model` | `''` | 模型路由；空用 profile 当前的默认模型 |
| `workspace` | `''` | 新会话记录的 cwd；空用进程 cwd |
| `language` | `zh` | 信封和工具描述的语言 |
| `minimumGapMs` | `1200` | 同一个会话两次发送的最小间隔 |
| `maxChars` | `1200` | 单条上限，超过在句末切开 |
| `dailyProactive` | `0` | 每天允许主动发几条；`0` 是禁止主动 |
| `maxLiveAgents` | `8` | 内存里保留几个热 agent，超出淘汰最久未用的 |
| `rosterPath` | `''` | 会话名单文件；空用 `$DSH_HOME/qq-bridge/conversations.json` |

`dailyProactive` 默认 `0` 是有意的。**主动说话是这个插件唯一由模型发起、而不是由人发起的路径**，所以它默认关着，打开要运维按天给额度。

---

## 一些不那么显然的决定

**回声也要拦。** 后端会按自己的账号 id 过滤掉机器人自己发的消息，但那依赖 `get_login_info` 的往返；在连上但还没拿到 id 的那一小段时间里，id 是空的，只看 id 的过滤会把机器人自己的消息当成入站。所以桥另外记住自己发过的文本，见到原样回来就丢。

**长回答按语义切，不按字数切。** 在 `。！？；…，、` 和换行里从后往前找断点；找不到才硬切，且不劈开代理对。拼回去必须等于原文——这条有测试，因为「切消息」这种功能坏起来是丢字，而丢字看起来像模型说话不利索。

**图片不静默丢。** `[CQ:image,...]` 变成 `[图片]`。让模型知道「对方发了张图」比让它以为对方什么都没说更有用。`reply` 引用段直接丢，引用不是内容。

**非文本段不发明。** 不认识的段不输出任何东西。给不认识的段造占位符是往上下文里塞噪音。

**`qq_send` 找不到目标时返回失败，不返回成功。** 一个工具为了「看起来正常」而报告发出去了，是最坏的答案：agent 随后会相信那个人被告知了。

**会话名单是薄的。** 只有 key / kind / id / name，没有消息文本。一份会长出内容的名单会变成另一份必须和会话日志保持一致的东西。

**`session/event` 不用。** 会话日志里的消息必须带 id，DSH 在校验时拒收**整个会话**。所以合成消息一律走 `createUserMessage()`，`source.kind` 用标准的 `'user'`——记忆插件、转录导出、压缩策略都按 kind 分流，树外的 kind 会静默掉出全部。

---

## 开发

```powershell
cd D:\A\DSH-L\projects\dsh-qq-bridge
npm test                     # 8 个断言套件，不需要 key、不需要号
node test\e2e-agent.mjs      # 真 agent + 真 socket + 假 QQ，会烧 token
```

`npm test` 跑的是 `test/run-suites.mjs`，它把跳过清单写在仓库里并**印出来**：一份只活在别人 shell 历史里的跳过清单会自己长大，直到套件因为没跑而全绿。

两类文件：

- **断言套件**（`text/policy/bridge/onebot/socket/tools/roster/host.mjs`）：不需要参数，必须全绿。
- **仪器**（`e2e-agent.mjs` 以及假后端 `fake-onebot*.mjs` / `ws-server.mjs` / `helpers.mjs`）：需要参数或真部署，不参与 `npm test`。

`e2e-agent.mjs` 会自己搭一个一次性 `DSH_HOME`（`<repo>/.e2e-home`）并往里放一个 profile，然后用假 OneBot 服务端驱动：连上、私聊两轮（第二轮必须记得第一轮说的话）、群里不被 @ 时不回、被 @ 时回在该群。它断言的是**库里的行和 socket 上的字节**，不是 agent 说了什么好听的话。

一个跑 e2e 时真踩过的坑：`Copy-Item -Recurse` 复制一个活的 DSH home 会顺着 profile 里 `node_modules` 的 junction 展开成几百 MB，而且**筛的是复制那一刻的代码**——改了仓库却没生效，现象是「新功能没起作用」，方向完全指错。所以 e2e 用代码建 home，`node_modules/dsh-qq-bridge` 是指回仓库的 junction。

---

## 状态

能用的：

- OneBot 11 / NapCat / LLBot，正向 WS，断线指数退避重连（1.7×，上限 60s）
- 私聊与群聊，`groupMode` 三档，群白名单
- 一个会话一个 DSH session，重启续接，预设与模型可配
- 三个工具，按后端能力裁剪
- 限速、分段、去重、回声过滤、每日主动额度、会话名单落盘
- 8 个断言套件 + 一个真 agent 端到端

还没做：

- **只有 OneBot 后端。** `gui-auto`（GUI 自动化）后端能绕开协议 hook 的风控面，但实现量大，`QqBackend` 接口是给它留的位置。
- **只发文本。** 图片、文件、语音需要先想清楚「模型能不能决定把本地文件发出去」——那是比「它能发一句话」大得多的权限。
- **不管登录。** 桥不启动 NapCat，也不管它的登录态；后端掉线时桥只负责重连。
- **微信没有。** 微信生态是另一套（iLink 长轮询、无法主动推送、不支持群），需要单独一个插件而不是这个插件多一个后端。
- **`relationship` 级别的社交图谱。** 群是一个会话，所以 agent 在群里分不清「谁跟谁熟」；需要的话得在记忆层做，不是这一层。
- **没有协议端的撤回/编辑。** 说错了只能再说一句。
