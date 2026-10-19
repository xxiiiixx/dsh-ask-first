# dsh-ask-first

**Ask First — let the agent ask before it decides** · a DeepSeek Harness plugin

**English** | [简体中文](README.md)

## Summary

When an agent runs a task, the expensive failure is rarely a mistyped character. It is a
**silent decision the user never got to make**. By the time the task finishes and the
direction turns out to be wrong, the cost has already been paid.

This plugin adds one standing rule to the agent: *when a detail is genuinely unclear, ask the
person who owns it instead of choosing for them.*

It is deliberately **advisory**. It never blocks a tool call, never rewrites a message, and
never turns a clear request into a confirmation dialog. It adds exactly two model-visible
surfaces:

| Surface | Where | Why |
|---|---|---|
| `ask-first:policy` system-prompt section | `ctx.systemPrompt.section()` | States the contract once; stable across steps, so it stays in the KV-cache prefix |
| Per-turn reminder | `ctx.on('agent/pre-step')` → `decision.messages` | Re-anchors the contract at the moment a turn actually starts |

Both default on. Every setting has a default, so the row mounts with `config: {}`.

## The six ambiguity classes

| # | Class | Meaning |
|---|---|---|
| 1 | **Ambiguous goal** | The request can reasonably produce two materially different results. State the interpretations you see and ask which is wanted |
| 2 | **Missing key parameters** | A path, file name, scope, format, data source, or target is unspecified, and guessing would waste the work |
| 3 | **Destructive or irreversible actions** | Deleting, overwriting, force-pushing, committing, publishing, bulk edits. Confirm target and scope first |
| 4 | **Real trade-offs** | Performance vs readability, speed vs robustness, narrow vs broad scope. Ask which side to optimise for |
| 5 | **Durable design choices** | Selecting a library, an architecture, or a file layout that later work must live with |
| 6 | **Reality diverging from expectation** | A test fails, a file is absent, an API differs from what was assumed. Ask whether to adapt the plan or work around it |

## The counterweight (just as important)

A prompt that only says "ask more" trains an agent to interrupt constantly. So the policy
states the opposite constraints with equal weight:

- **Inspect first.** Never ask for something you can read from the workspace, the files, or the code.
- **Ask only the decision that blocks progress**, and recommend an option when one is clearly better.
- **Batch questions** into one `ask_user_question` call instead of asking one at a time.
- **Do not re-confirm** a request that is already clear.
- **Subagents cannot ask the human.** `ask_user_question` rejects a delegated caller, so the child
  must state the unresolved question in its final result for the parent to raise — not decide on its own.

## Install

Exactly like any other Harness plugin: the plugin installs into the profile's `node_modules`.
The source tree in your workspace is only for maintenance.

### From GitHub

```bash
dsh plugin --profile desktop add github:xxiiiixx/dsh-ask-first
```

### From a local checkout

```bash
dsh plugin --profile desktop add "C:\path\to\dsh-ask-first"
```

Or pick the directory in **Settings → Plugins → Add**.

Restart Harness afterwards (required whenever Plugin Manager reports `restart-required`). The
row is inserted by [`cordis.patch.yml`](./cordis.patch.yml); no manual profile edit is needed.

### Maintaining the workspace source

The `dsh-ask-first/` directory in your workspace is a **maintenance copy**, independent of the
installed package. Editing it does not affect the running plugin: reinstall (or push the change
to GitHub and reinstall) for it to take effect.

```bash
dsh plugin --profile desktop remove dsh-ask-first
dsh plugin --profile desktop add "C:\path\to\dsh-ask-first"
```

## Configuration

Every key is optional. An invalid value **fails loud at load** rather than silently degrading
the guard into a no-op.

```yaml
- id: ask-first
  name: 'dsh-ask-first'
  config:
    # One or more of: ambiguous / missing / destructive / tradeoff / design / mismatch
    # Omit ⇒ all six.
    topics:
      - ambiguous
      - missing
      - destructive
      - tradeoff
      - design
      - mismatch
    # true | false | "turn" | "step" | "off"
    #   turn (default) ⇒ once at the first step of every turn
    #   step           ⇒ every step (noisier, stronger)
    #   off / false    ⇒ system-prompt section only
    reminder: turn
```

| Key | Default | Meaning |
|---|---|---|
| `topics` | all six | Which ambiguity classes the policy and reminder name. Unknown names throw at load |
| `reminder` | `"turn"` | When the per-turn reminder is injected. `false` / `"off"` keeps only the static section |

The prompt prose is intentionally **not** configurable: one reviewed contract is easier to
reason about than per-deployment wording drift.

## What the model sees

The system-prompt section, in full:

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

The per-turn reminder:

```markdown
<system-reminder>
ask-first: if anything blocking is still unclear, use `ask_user_question` before you continue
instead of deciding on the user's behalf. This covers the ambiguity classes listed in the
ask-first system-prompt section.
Do not ask when the request is already clear, and do not ask for facts you can read from the
workspace. This is a reminder, not a mandate to interrupt.
</system-reminder>
```

## Verification

Three self-contained scripts, no test framework required:

```bash
node test.mjs                # 23 unit checks: config validation, rendering, pre-step decisions
node verify-wiring.mjs       # 14 integration checks: real cordis + dsh-system-prompt
node verify-composition.mjs  # 4 mount checks: real desktop profile composition
```

Or run `npm test` / `npm run check` for all of them.

`verify-wiring.mjs` mounts the plugin on a real cordis `Context` with the shipped
`dsh-system-prompt` registry, then asserts the section reaches the assembled prompt in the
right position and that the pre-step listener injects a plugin-sourced reminder.

`verify-composition.mjs` loads the local desktop profile through the real
`loadProfile` / `composeEntries` path and asserts the `ask-first` row is present, enabled, and
resolvable — proof the app will mount it, not just that the source parses. It exits `0` with
`SKIP` when no desktop profile exists.

## Design notes

- **Two surfaces, one contract.** The static section carries the full policy; the reminder is
  one line. Repeating the whole policy every turn burns tokens and trains the model to skim it.
- **The source must be `{ kind: 'ask-first' }` — a v4 producer kind.** Session format v4
  retired the `{kind:'plugin', plugin:...}` wrapper; using it throws
  `format v4 message requires a producer-owned source kind` at write time, while an unlabeled
  injected message renders as a genuine user prompt in derived history. Both are wrong, so the
  bare producer kind is the only correct shape.
- **Turn-scoped, not step-scoped, by default.** A long multi-step turn should not be re-reminded
  on every step; `"step"` is available when you want that.
- **No tool schema of its own.** The guard reuses the shipped `ask_user_question`
  (`@deepseek-ai/dsh-tool-ask-user`), so it costs no extra schema tokens.
- **Only `systemPrompt` is a hard dependency.** The plugin declares `inject: ['systemPrompt']`;
  the pre-step hook is a plain listener, and a composition without user questions degrades to
  advice rather than failing to boot.
- **Deterministic text.** Rendering depends only on configuration, so the system prompt stays
  byte-identical across steps and does not disturb KV-cache reuse.
- **Host-only.** No browser half, no settings UI, and **no `peerDependencies`** — a version-locked
  kernel range is what makes a plugin get refused at load.

## Known limitations

- **Advisory, not enforced.** The model may still choose. This plugin is a contract and a
  reminder, not a policy engine; a hard gate would need a `tools/pre-execute` veto plus a
  reliable ambiguity detector, which is a different (and much riskier) product.
- **It does not judge your request for you.** It states the rule; deciding "is this clear?" stays
  with the model.
- **The reminder is per-turn.** It introduces no new session event type; it rides ordinary `user`
  messages with a plugin source attached.
- **No domain heuristics.** It is not customised per project and does not read project structure
  to infer ambiguity.

## License

[MIT](./LICENSE)
