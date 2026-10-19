# dsh-ask-first

**Ask First — 让 Agent 先问再做** · DeepSeek Harness 插件

[English](README_EN.md) | **简体中文**

## 概述

Agent 执行任务时最贵的错误，往往不是敲错一个字符，而是**替你做掉了本该由你决定的那一步**。任务跑完才发现方向不对，成本已经付出去了。

这个插件给 Agent 加一条常驻准则：**遇到真正不清楚的地方，先问任务的主人，而不是自己替它拍板。**

它是**建议式**的：不拦截任何工具调用，不改写任何消息，也不会把一句已经说清楚的请求变成"请再确认一次"。它只增加两个模型可见的面：

| 注入面 | 实现位置 | 作用 |
|---|---|---|
| `ask-first:policy` 系统提示段落 | `ctx.systemPrompt.section()` | 一次讲清准则，跨步骤稳定，保持在 KV 缓存前缀内 |
| 每轮提醒 | `ctx.on('agent/pre-step')` → `decision.messages` | 在一轮真正开始时重新锚定准则 |

两者默认都开启，每个配置项都有默认值，因此该行以 `config: {}` 即可挂载。

## 六类"该问"的情形

| # | 类别 | 说明 |
|---|---|---|
| 1 | **目标含糊** | 同一句话可以做出明显不同的结果，先说明你看到的几种理解并问清是哪一种 |
| 2 | **关键参数缺失** | 路径、文件名、范围、格式、数据来源、目标没有指定，猜错会白做 |
| 3 | **破坏性或不可逆操作** | 删除、覆盖、强推、提交、发布、批量修改，先确认目标与范围 |
| 4 | **真实取舍** | 性能 vs 可读性、速度 vs 稳定、范围大 vs 小，问清优化方向 |
| 5 | **影响长期维护的设计选择** | 选库、选架构、选文件组织，后续都要跟着它走 |
| 6 | **现实与预期不符** | 测试失败、文件不存在、接口对不上，先问是改方案还是绕过去 |

## 反面的约束（同样重要）

只说"要多问"的提示词会把模型训练成不停打断。所以政策同时写明反面：

- **先自己查**：读工作区、翻文件、搜代码能确定的事，不要问。
- **只问卡住进度的那一个决策**，有明确更优选项时给出推荐。
- **多个问题一次问完**，不要一次一个地挤牙膏。
- **已经清楚的请求不要反复确认。**
- **子代理问不了人**：`ask_user_question` 对子代理会直接拒绝，此时应把未决问题明确写进最终结果交回父代理，而不是自行决定。

## 安装

与其它 Harness 插件完全一致——插件本体装在 profile 的 `node_modules` 里，
工作区内的源码只用于维护。

### 从 GitHub 安装

```bash
dsh plugin --profile desktop add github:xxiiiixx/dsh-ask-first
```

### 从本地源码安装

```bash
dsh plugin --profile desktop add "C:\path\to\dsh-ask-first"
```

或在 **设置 → 插件 → 添加** 中选择该目录。

安装完成后重启 Harness（Plugin Manager 提示 `restart-required` 时必须重启）。
该行由 [`cordis.patch.yml`](./cordis.patch.yml) 自动插入，无需手工改 profile。

### 维护工作区里的源码

工作区中的 `dsh-ask-first/` 是**维护副本**，与已安装的副本相互独立：
改源码不会影响正在运行的插件，必须重新安装（或把改动推送到 GitHub 后重装）才生效。

```bash
dsh plugin --profile desktop remove dsh-ask-first
dsh plugin --profile desktop add "C:\path\to\dsh-ask-first"
```

## 配置

每个键都可省略。非法值会在加载时**直接报错**，而不是悄悄降级成空操作。

```yaml
- id: ask-first
  name: 'dsh-ask-first'
  config:
    # 六类之一或子集：ambiguous / missing / destructive / tradeoff / design / mismatch
    # 省略 ⇒ 全部启用
    topics:
      - ambiguous
      - missing
      - destructive
      - tradeoff
      - design
      - mismatch
    # true | false | "turn" | "step" | "off"
    #   turn（默认）⇒ 每轮第一步提醒一次
    #   step          ⇒ 每一步都提醒（更频繁、更强）
    #   off / false   ⇒ 只保留系统提示段落
    reminder: turn
```

| 键 | 默认 | 含义 |
|---|---|---|
| `topics` | 全部六类 | 政策与提醒中点名的歧义类别；出现未知名称会报错 |
| `reminder` | `"turn"` | 每轮提醒的注入时机；`false` / `"off"` 仅保留静态段落 |

提示词正文刻意**不做配置化**：一份经过审阅的准则，比每个部署各自漂移的措辞更容易推理。

## 模型实际看到什么

系统提示段落（完整文本）：

```markdown
## Asking instead of assuming

This session runs with an ask-first policy. Its purpose is to keep judgement with the person
you are working for: when a detail is genuinely unclear, ask that person instead of choosing
for them. A short question costs seconds; an unstated assumption can cost a whole task.

Ask before you act in any of these situations:

**Ambiguous goal.** …
**Missing key parameters.** …
**Destructive or irreversible actions.** …
**Real trade-offs.** …
**Design choices with lasting maintenance cost.** …
**Reality diverging from the expectation.** …

When you do ask:

- Use the `ask_user_question` tool so the question is attached to the run …
- Ask only what you cannot determine otherwise. …
- Keep it to the decision that blocks progress, and offer the plausible options …
- If several questions are needed, ask them together in one call …
- If you are a delegated subagent, `ask_user_question` will be rejected …

This policy is deliberately advisory. It does not forbid autonomy and it does not require a
question for every turn …
```

每轮提醒：

```markdown
<system-reminder>
ask-first: if anything blocking is still unclear, use `ask_user_question` before you continue
instead of deciding on the user's behalf. This covers the ambiguity classes listed in the
ask-first system-prompt section.
Do not ask when the request is already clear, and do not ask for facts you can read from the
workspace. This is a reminder, not a mandate to interrupt.
</system-reminder>
```

## 验证

仓库自带三个零依赖脚本，不需要测试框架：

```bash
node test.mjs                # 23 项单元检查：配置校验、文本渲染、pre-step 决策
node verify-wiring.mjs       # 14 项集成检查：真实 cordis + dsh-system-prompt
node verify-composition.mjs  # 4 项挂载检查：真实 desktop profile 合成
```

也可用 `npm test` / `npm run check` 一次跑完。

`verify-wiring.mjs` 在真实的 cordis `Context` 与随包发布的 `dsh-system-prompt` 注册表上
挂载插件，断言段落进入组装后的提示词且位置正确，并断言 pre-step 监听器注入了带插件
来源的提醒。

`verify-composition.mjs` 走真实的 `loadProfile` / `composeEntries` 路径加载本地
desktop profile，断言 `ask-first` 行存在、已启用、可解析——证明"应用真的会挂载它"，
而不只是"源码语法没问题"。没有 desktop profile 时该脚本以 `SKIP` 退出。

## 设计说明

- **两个面，一份准则。** 静态段落承载完整政策，提醒只有一行。每轮重复整份政策既费
  token，也会让模型学会略读。
- **`kind: 'plugin'` 来源是必需的。** 没有来源标记的注入消息在派生历史里会渲染成真正的
  用户发言；带插件来源才能保持可溯源、可从会话日志重建。
- **默认按"轮"而非按"步"。** 一个多步的长轮次不应每步都被提醒；需要时可用 `"step"`。
- **不新增工具 schema。** 复用随包发布的 `ask_user_question`
  （`@deepseek-ai/dsh-tool-ask-user`），因此不增加 schema token 开销。
- **只硬依赖 `systemPrompt` 一个服务。** 插件声明 `inject: ['systemPrompt']`，
  其余（pre-step 监听）是普通监听器；没有用户问答服务时会退化为纯建议，而不是启动失败。
- **文本确定。** 渲染只依赖配置，因此系统提示跨步骤逐字节一致，不破坏 KV 缓存复用。
- **纯 Host 半身。** 没有浏览器半身、没有设置页；不声明 `peerDependencies`，
  避免被内核版本锁死而拒绝加载。

## 已知限制

- **是建议，不是强制。** 模型仍可能自行决定。本插件是准则加提醒，不是策略引擎；
  硬门禁需要 `tools/pre-execute` 否决加上可靠的歧义检测，是另一个（风险也高得多的）产品。
- **不自行判断"你这句话含糊"。** 它只陈述规则，是否清楚仍由模型判断。
- **提醒按轮次。** 不引入新的事件类型，随普通 `user` 消息携带插件来源。
- **不含领域启发式。** 不针对具体项目定制，也不读取项目结构来推断歧义。

## 许可证

[MIT](./LICENSE)
