# dsh-alive

活人感的五条机制，做成一个 DSH 宿主插件。

不改前端、不碰模型、不写外部文件。状态跟着会话落盘，由 session 事件推导。

## 它做哪五件事

| 机制 | 落在哪 | 对应配置 |
| --- | --- | --- |
| 不回 | `agent/pre-step` 返回 `{ kind: 'reject' }`，这一轮不进模型 | `silentChance` |
| 分条 + 延迟 | 注入节奏指令；可选自带停顿工具 | `paceHint` / `selfPaceTool` |
| 状态外置 | `sessionProjections` 的 `alive` 状态：mood / energy / intimacy | `stateHint` |
| 脏记忆 | 从用户消息里抽印象条目，不是档案 | `maxImpressions` |
| 差序对待 | intimacy 同时决定注入措辞和说话硬度 | 同上 |

## 安装

DSH 里：

```
plugin_manager action=install_bundle target="<插件目录绝对路径>"
```

或命令行 `dsh plugin add <此目录绝对路径>`。

装完**重启 DSH 桌面端**。desktop profile 被 Electron 独占，改完不重启看不到效果，命令行也没法 `--dump-config`。

## 配置

改 `~/.dsh/profiles/desktop/cordis.patch.yml`，加一段同 id 的覆盖：

```yaml
- id: dsh-alive
  name: "dsh-alive"
  config:
    silentChance: 0.2
    paceHint: true
    selfPaceTool: false
    stateHint: true
    maxImpressions: 5
```

全部默认值：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `silentChance` | `0` | 不回的概率。**默认关**，要自己开 |
| `silentMaxChars` | `6` | 超过这个字数一律回，不装死 |
| `paceHint` | `true` | 注入节奏指令 |
| `paceToolName` | `hold_for_followup` | 指令里提到的工具名 |
| `selfPaceTool` | `false` | 自己注册停顿工具。装了 chat-pace 就别开 |
| `stateHint` | `true` | 注入状态和记忆 |
| `maxImpressions` | `5` | 最多带几条印象 |

## 和其它插件的关系

`dsh-chat-pace` 已经提供 `hold_for_followup`。装了它，这里就保持 `selfPaceTool: false`，节奏提示会直接指向那个工具，不用改。

如果没装，把 `selfPaceTool` 设 true，它会自己注册一个同名工具。两个同时注册会重名报错。

## 版本适配

只用了三个宿主扩展点，都写在 `apply()` 里，没有全局补丁：

- `agent/pre-step` — waterfall 事件，decision 结构是 `{ kind: 'enter' | 'reject' }`
- `sessionProjections.register` / `stateOf` — 状态落盘
- `ctx.tools.register` + `defineTool` — 工具注册

已验证版本：`@deepseek-ai/dsh-*` 0.1.2-rc.1、`@deepseek-ai/cordis` 4.0.2、`schemastery` 3.18.2、`zod` 4.5.4。

适配更高版本时的做法：

1. **服务缺失不崩**。`agents` 写在 `inject` 里，其余两个走 `ctx.inject([...], cb)` 局部注入。某个服务不存在，那块功能不启用，插件照常加载，不会把整个 profile 拖死。
2. **pre-step 的 decision 结构变了只改一处**。整个插件只有 `apply()` 里有 `kind === 'enter'` / `{ kind: 'reject' }` 这两个判断。如果上游改了名字，改这两行就够，其余逻辑不动。
3. **状态结构带版本号**。`stateVersion: 1`。以后加字段就升到 2，旧会话的状态按 `init()` 重建，不会因为缺字段报错。
4. **不依赖内部模块路径**。只 import 包根导出（`@deepseek-ai/dsh-llm` 的 `createUserMessage`），不碰 `lib/` 里的深层路径——那些改动最频繁。

## 三条要说清楚的事

**一、不回是真的不回。** `reject` 之后这一轮不产生任何输出，消息留在 inbox，下次唤醒才处理。桌面端表现就是"没反应"，可能让你以为插件崩了。所以默认 `silentChance: 0`，什么时候想好承受这个再开，建议从 0.1 起。

对方在说难受的话时不装死——`PITY` 命中的输入一律回复。这不是活人感的问题，是别的东西。

**二、DSH 里没有"发多条消息"这回事。** 它是一条 assistant message 流式渲染，不是 IM。所以"分条"只能靠模型在段落之间调一次工具来打断文本，让它一块一块出现。这是 `dsh-chat-pace` 的路子，本插件复用，没有另造。

真要"一条条消息"，那是 QQ / AstrBot 的语境，不是这里。

**三、记忆是规则抽的，不是模型总结的。** 只认三种句式：「我叫 X」「我喜欢/讨厌 X」「我在 X 上班/上学」。抽到就存，最多留 8 条、带 5 条。

粗糙，但可预测、不花钱、不跑第二次模型。指望它记住复杂的来龙去脉，做不到——那要用 `dsh-context` 或别的长期记忆插件。

## 已验证 / 未验证

已验证：

- 语法检查通过
- `schemastery` 的默认值填充、`zod` 的状态校验按预期工作
- `reduce()` 的状态推导：普通消息 mood +0.02、被同情 −0.25（比挨骂 −0.15 更狠）、impression 抽取、插件自注入的消息被忽略、回复后 energy −0.03
- `renderState()` 的输出措辞

未验证：

- 在真实 DSH 进程里加载。`agent/pre-step` 的监听顺序、`stateOf` 的返回值时机，都只在类型定义层面核过，没跑起来过。

第一次装完先发一条普通消息看有没有异常，看日志里 `alive` 有没有报错。
