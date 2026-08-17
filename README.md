# @rapid-mlx/dsh-provider

A native Rapid-MLX provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**Status: local skeleton. Deliberately not published to npm** (`"private": true`,
version `0.0.0-local`). DSH is a developer preview that moved rc.6 → rc.7 within
days; this exists to prove the mechanism, not to carry a compatibility promise.

## Why a native adapter

DSH can already reach Rapid-MLX through its generic `openai-completions`
provider, and that works. What it cannot do is ask the server anything about
the model. The generic route knows an id and whatever number the operator typed
into `settings.yaml`.

Rapid-MLX's `/v1/models` returns considerably more:

| field | what it enables |
|---|---|
| `context_window` | the real capacity, fed to `resolveModel()` |
| `reasoning_parser` | whether the model can emit reasoning **at all** |
| `tool_call_parser` | whether it can emit OpenAI-shape `tool_calls` |
| `recommended_sampling` | the per-model sampling this checkpoint wants |
| `is_hybrid` / `is_moe` | architecture facts that change what is possible |
| `capabilities` | text / tools / vision |

The generic provider discards every one of them.

The highest-value consumer is compaction: `dsh-compaction-basic` asks the owning
adapter for the route's context capacity and multiplies it by `thresholdRatio`
(default 0.8) to decide when to compact. Answer that badly and compaction fires
at the wrong time in every long session — and on a Mac the binding constraint is
unified memory, not the number the checkpoint advertises.

## Verified locally

Against `dsh 0.1.0-rc.7` on an M3 Ultra:

- Installs and **activates as a profile layer** — `dsh plugin --profile headless
  add <path>` produced no "declares no `dsh.bundle`" warning, and the entry
  appears in `dsh --profile headless --dump-config`.
- Registers the `rapid-mlx` route with `ctx.llm` and serves real queries.
- Plain chat, single tool call (file read), and the multi-step bug-fix task the
  Rapid-MLX Tier-1 release gate uses — the last one fixed `calc.py` and made the
  repo's own test pass, verified independently, in 36 s on `qwen3.6-35b-8bit`.

## Three things that cost time — read before editing

1. **`dsh.bundle` in `package.json` is what makes it a plugin.** Without it the
   package installs as an inert dependency and dsh says so in a warning. It is
   also what gets the package appended to the profile's `dsh.profile.bundles`.
2. **`LlmReasoningEffortInfo.name` is required.** Returning `{id}` alone fails
   the whole model with `INVALID_MODEL_REASONING` — the error names the model,
   not the missing field.
3. **DSH has no `tool` role.** `Message.role` is only system|user|assistant; a
   tool *result* is a **user**-role message whose `source.kind === 'tool'`
   carries the `callId` and whose content holds a `ToolResultBlock`. Flatten
   those into plain user text and the model reissues the same call forever — the
   symptom is an empty answer and a non-zero exit with **nothing on stderr**.

## Local development

`pnpm` links the package by path, which puts the code outside the profile tree,
so Node's parent-walk never reaches `$DSH_HOME/profiles/node_modules` and the
peer deps fail to resolve. Symlink them in (dev only — `node_modules` is not in
`files`):

```sh
mkdir -p node_modules/@deepseek-ai
ln -sfn <dsh-install>/node_modules/@deepseek-ai/dsh-llm  node_modules/@deepseek-ai/dsh-llm
ln -sfn <dsh-install>/node_modules/@deepseek-ai/cordis   node_modules/@deepseek-ai/cordis
```

Then:

```sh
export DSH_HOME=/tmp/dsh-dev          # never the real ~/.dsh
dsh plugin --profile headless add ~/work/rapid-dsh-provider
export RAPID_MLX_BASE_URL=http://127.0.0.1:8000/v1
dsh --profile headless "say hello"
```

A real `npm install` does not need the symlinks: the package lands inside the
profile tree, where the flat fallback resolves bare names normally.

## Known gaps

- Images are not carried through `stream()`; text, reasoning and tool calls are.
- Registers the provider id `rapid-mlx`. If `settings.yaml` also declares a
  `rapid-mlx` provider under `llm-pi-ai`, the two compete for one route name —
  `registerAdapter` owns provider exclusivity. Pick one, or rename this route.
- `recommended_sampling`, `tool_call_parser`, `is_hybrid` and `capabilities` are
  read from the server but not yet acted on. That is the next increment and the
  reason the adapter exists.
