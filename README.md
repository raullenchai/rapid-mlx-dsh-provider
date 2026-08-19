# @raullenchai/dsh-provider

A native [Rapid-MLX](https://github.com/raullenchai/Rapid-MLX) provider for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — so `dsh`
gets its model facts from the server instead of from whatever you typed into
`settings.yaml`.

[![CI](https://github.com/raullenchai/rapid-mlx-dsh-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/raullenchai/rapid-mlx-dsh-provider/actions/workflows/ci.yml)

> **Status: published to npm** as
> [`@raullenchai/dsh-provider`](https://www.npmjs.com/package/@raullenchai/dsh-provider).
> The end-to-end `dsh` run in [Verified](#verified) was on an M3 Ultra against
> `dsh 0.1.0-rc.7`; `dsh 0.1.0-rc.8` is API-compatible — the `LlmAdapter`
> contract is byte-identical and the only changes are additive — and the
> adapter is re-verified against rc.8 at the protocol and unit-test level.
> DSH is still a developer preview that moves fast, so treat this as tracking
> a moving target, not a frozen compatibility promise.

## What it does for you

DSH can already talk to a local Rapid-MLX server through its generic
`openai-completions` provider. That route works — but it knows nothing about
your model beyond what you hand-wrote:

```yaml
# what the generic route makes you maintain, by hand, per model
llm-pi-ai:
  providers:
    rapid-mlx:
      baseURL: http://localhost:8000/v1
      defaultContextWindow: 262144      # you looked this up. is it still right?
      models:
        - id: qwen3.6-35b-8bit
          contextWindow: 262144
          reasoningEfforts: {off: none, low: low, medium: medium, high: high}
```

Rapid-MLX's `/v1/models` already publishes all of that and more. This adapter
reads it, so:

**1. Nothing to hand-write, and nothing to re-write when you switch models.**
Swap what `rapid-mlx serve` is running and `dsh` follows. No re-running setup,
no stale numbers.

**2. The reasoning control tells the truth.** Rapid-MLX reports whether a model
actually has a reasoning parser. A model that can't reason no longer shows an
off/low/medium/high selector that does nothing.

**3. Compaction is timed with the model's real context window, not a number
that drifted.** This is the one that quietly costs you. `dsh-compaction-basic`
asks the provider for the route's capacity and compacts at
`thresholdRatio × capacity` (0.8 by default). If your hand-written
`contextWindow` is stale or copied from another model, every long session
compacts at the wrong point — too early and you lose context you had room for,
too late and you hit the wall.

## Install

Needs Node ≥ 22.15 (dsh imports Node's Zstd stream API without declaring it)
and a running Rapid-MLX server.

```sh
# From npm:
dsh plugin --profile web add @raullenchai/dsh-provider

# …or straight from source — the package ships plain JS with no build step:
dsh plugin --profile web add github:raullenchai/rapid-mlx-dsh-provider

export RAPID_MLX_BASE_URL=http://localhost:8000/v1     # optional; this is the default
dsh web
```

Then point the agent at the route:

```yaml
# $DSH_HOME/settings.yaml
agent-default-model:
  provider: rapid-mlx
  model: qwen3.6-35b-8bit
```

Verified: that command installs and activates as a profile layer against
`dsh 0.1.0-rc.7`. To hack on it locally instead, see
[Local development](#local-development).

## Verified

Against `dsh 0.1.0-rc.7` on an M3 Ultra:

- Installs and **activates as a profile layer** (no "declares no `dsh.bundle`"
  warning; the entry shows up in `dsh --profile headless --dump-config`).
- Registers the `rapid-mlx` route with `ctx.llm` and serves real queries.
- Plain chat, a single tool call, and the multi-step bug-fix task that gates
  Rapid-MLX releases — the last one fixed the bug and made the target repo's own
  test pass, verified independently, in 36 s on `qwen3.6-35b-8bit`.

## Not done yet

Being explicit, because the point of the adapter is to *use* what the server
says and some of it is still only read:

- `recommended_sampling` — should be applied automatically per model.
- `tool_call_parser` — should let `dsh` fail fast on a model that cannot emit
  `tool_calls`, instead of looping.
- `is_hybrid` / `is_moe` / `capabilities` — read, not yet acted on.
- **Memory-aware capacity.** Today `resolveModel()` reports the model's
  *advertised* context window. On a Mac the real ceiling is unified memory, and
  reporting that instead is the biggest remaining win — it needs Rapid-MLX to
  expose a usable-capacity figure first.
- Images are not carried through `stream()` — but they now **refuse** with
  `LlmError(..., 'UNSUPPORTED')` rather than being dropped, per the cookbook.
  Text, reasoning and tool calls are carried.
- The route is registered as `rapid-mlx`. If your `settings.yaml` also declares
  a `rapid-mlx` provider under `llm-pi-ai`, the two compete for one route name
  (`registerAdapter` owns provider exclusivity). Use one or rename ours.

## Conformance with the official adapter contract

Built against
[`docs/cookbook/adding-an-llm-adapter.md`](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/cookbook/adding-an-llm-adapter.md)
and its "protocol obligations" section. Each item has a test:

| Obligation | How it is met |
|---|---|
| `usage` before `finish`, nothing after `finish` | usage is buffered and flushed at end-of-stream, so a trailing usage-only chunk cannot reorder it |
| Tool-call `arguments` are raw JSON strings end to end | fragments stream as `argumentsDelta` and reassemble unparsed |
| Block indexes in first-seen order, reused per block | verified across a reasoning-then-text response |
| Errors take exactly two sanctioned paths | transport/protocol failures **throw** `LlmError` with a stable code; nothing ends the stream quietly |
| Honor `options.signal` | passed to `fetch` and to the SSE reader; an `AbortError` is re-thrown unchanged, not reclassified |
| A field the provider cannot honor throws `UNSUPPORTED` | image content refuses instead of being narrowed away |
| Config is a schemastery schema with env fallback | `export const Config`, fed from `cordis.patch.yml` via `!!js process.env.RAPID_MLX_BASE_URL` |

`finish.replayState` is not emitted: Rapid-MLX needs no native response ids
or signatures on follow-up calls, so there is nothing lossless to project.

## Three things worth knowing before you edit this

Each of these cost real debugging time:

1. **`dsh.bundle` in `package.json` is what makes this a plugin.** Without it
   the package installs as an inert dependency and `dsh` only *warns*. It is
   also what gets it appended to the profile's `dsh.profile.bundles`. CI fails
   if it goes missing.
2. **`LlmReasoningEffortInfo.name` is required.** Returning `{id}` alone fails
   the whole model with `INVALID_MODEL_REASONING` — an error that names the
   model, not the missing field.
3. **DSH has no `tool` role.** `Message.role` is only system|user|assistant; a
   tool *result* is a **user**-role message whose `source.kind === 'tool'`
   carries the `callId` and whose content holds a `ToolResultBlock`. Flatten
   those into plain user text and the model reissues the same call forever —
   the symptom is an empty answer and a non-zero exit, with **nothing on
   stderr**.

## Local development

`pnpm` links a local path *outside* the profile tree, so Node's parent-walk
never reaches `$DSH_HOME/profiles/node_modules` and the peer deps fail to
resolve. Symlink them in — dev only, `node_modules` is gitignored and excluded
from the published `files`:

```sh
mkdir -p node_modules/@deepseek-ai
ln -sfn <dsh-install>/node_modules/@deepseek-ai/dsh-llm node_modules/@deepseek-ai/dsh-llm
ln -sfn <dsh-install>/node_modules/@deepseek-ai/cordis  node_modules/@deepseek-ai/cordis

export DSH_HOME=/tmp/dsh-dev          # never your real ~/.dsh
dsh plugin --profile headless add "$PWD"
export RAPID_MLX_BASE_URL=http://127.0.0.1:8000/v1
dsh --profile headless "say hello"
```

A real `npm install` needs none of this: the package lands inside the profile
tree, where the flat fallback resolves bare names normally.

When testing agent behaviour, use a strong 8-bit model. A multi-step task here
failed on `qwen3.5-9b-4bit` and passed on `qwen3.6-35b-8bit` — 4-bit confounds
"weak model" with "broken integration".

## The engine side guards these fields

Living in its own repo means a rename in Rapid-MLX would break this package
silently — nothing there imports it and this CI does not run there. So the
fields are pinned on the side that owns them, by
`tests/test_model_card_client_contract.py` in
[Rapid-MLX](https://github.com/raullenchai/Rapid-MLX), which names this package
as its reason. It pins the wire *shape*: field names, nullability, and the fact
that `ModelInfo` does not set `exclude_none` — which is what makes
`"reasoning_parser": null` distinguishable from an older server that omits the
key entirely.

**If you start reading a new `/v1/models` field here, add it there too.**
Otherwise the guard silently stops covering what this package actually uses.

## License

[Apache-2.0](LICENSE), matching Rapid-MLX.
