/**
 * Native Rapid-MLX provider for DeepSeek Harness.
 *
 * WHY THIS EXISTS
 * ---------------
 * DSH can already reach a Rapid-MLX server through its generic
 * `openai-completions` provider, and that works. What it cannot do is ask
 * the server anything about the model it is talking to — the generic route
 * knows an id and a number the operator typed into settings.yaml.
 *
 * Rapid-MLX's /v1/models returns considerably more than the OpenAI shape:
 *
 *   context_window        the model's real capacity
 *   reasoning_parser      whether it can emit reasoning at all
 *   tool_call_parser      whether it can emit OpenAI-shape tool_calls
 *   recommended_sampling  the per-model sampling this checkpoint wants
 *   is_hybrid / is_moe    architecture facts that change what is possible
 *   capabilities          text / tools / vision ...
 *
 * The generic provider discards every one of them. This adapter's whole
 * job is to stop discarding them — `resolveModel()` is where that lands,
 * and it is the method `dsh-compaction-basic` calls to decide when to
 * compact (it multiplies the context capacity we return by its
 * thresholdRatio). Answer that question badly and compaction fires at the
 * wrong time on every long session.
 *
 * SCOPE OF THIS SKELETON
 * ----------------------
 * `stream()` is implemented straightforwardly over /v1/chat/completions
 * because Rapid-MLX is OpenAI-compatible; it is deliberately the least
 * interesting part of this file. Tool-call and reasoning deltas are
 * carried through, images are not yet. Not published to npm.
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'rapid-mlx-provider'
export const inject = ['llm']

const PROVIDER = 'rapid-mlx'
const DEFAULT_BASE_URL = 'http://localhost:8000/v1'
/**
 * Graded levels mapped onto the OpenAI `reasoning_effort` wire values that
 * Rapid-MLX validates against a closed set. `name` is REQUIRED by
 * `LlmReasoningEffortInfo`, not decorative — returning `{id}` alone makes
 * DSH reject the whole model with INVALID_MODEL_REASONING.
 */
const EFFORTS = [
  { id: 'off', name: 'Off', wire: 'none' },
  { id: 'low', name: 'Low', wire: 'low' },
  { id: 'medium', name: 'Medium', wire: 'medium' },
  { id: 'high', name: 'High', wire: 'high' },
]

class RapidMlxAdapter extends LlmAdapter {
  #baseURL
  #logger

  constructor(config, logger) {
    super()
    this.#baseURL = String(config?.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#logger = logger
  }

  providerInfo(provider) {
    return { id: provider, name: 'Rapid-MLX (local)' }
  }

  /** GET /v1/models, or [] — never throw a discovery failure at the loop. */
  async #entries(signal) {
    try {
      const res = await fetch(`${this.#baseURL}/models`, { signal })
      if (!res.ok) return []
      const body = await res.json()
      return Array.isArray(body?.data) ? body.data.filter((e) => e && typeof e === 'object') : []
    } catch {
      return []
    }
  }

  #find(entries, model) {
    // Exact match only when several models are served: describing some
    // OTHER model's capacity is worse than admitting we do not know.
    const exact = entries.find((e) => e.id === model)
    if (exact) return exact
    return entries.length === 1 ? entries[0] : undefined
  }

  async listModels(provider) {
    const entries = await this.#entries()
    return entries.map((e) => ({
      provider,
      id: String(e.id),
      name: String(e.id),
      // An explicit omission is negative capability, so only claim
      // modalities the server actually advertised.
      ...(Array.isArray(e.capabilities)
        ? { inputModalities: e.capabilities.includes('vision') ? ['text', 'image'] : ['text'] }
        : {}),
    }))
  }

  /**
   * The method this whole package exists for.
   *
   * Every field is omitted rather than guessed when the server did not
   * answer: `LlmResolvedModelInfo` documents absent `context` /
   * `reasoning` as "unknown", and unknown is a state DSH handles. A
   * fabricated number is not.
   */
  async resolveModel(provider, model, signal) {
    const entry = this.#find(await this.#entries(signal), model)
    const info = { provider, id: model, name: model }
    if (!entry) return info

    const ctx = entry.context_window
    if (Number.isInteger(ctx) && ctx > 0) {
      info.context = { contextWindow: ctx }
    }

    // Reasoning is advertised only when the runtime actually bound a
    // reasoning parser for this model. `reasoning_parser: null` is a
    // definite no; a MISSING key means an older server that cannot
    // answer, which must not be read as either yes or no.
    if ('reasoning_parser' in entry) {
      const parser = entry.reasoning_parser
      if (typeof parser === 'string' && parser.trim()) {
        info.reasoning = { efforts: EFFORTS.map(({ id, name }) => ({ id, name })) }
      }
    }
    return info
  }

  async *stream(options) {
    const { model, messages, tools, signal } = options
    const res = await fetch(`${this.#baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        messages: toOpenAiMessages(messages),
        ...(tools?.length ? { tools: toOpenAiTools(tools) } : {}),
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(reasoningWire(options.reasoningEffort)
          ? { reasoning_effort: reasoningWire(options.reasoningEffort) }
          : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
    })
    if (!res.ok || !res.body) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: `rapid-mlx HTTP ${res.status}` } },
      }
      return
    }

    let index = -1
    let open = null // 'text' | 'reasoning' | 'tool-call'
    let text = ''
    // A tool call arrives as deltas; `block-end` has to hand back the
    // ASSEMBLED ToolCallBlock (id + name + raw argument JSON). Emitting a
    // bare {type:'tool-call'} makes the session log fail to serialize with
    // `session event "tool/call" carries non-JSON-serializable data`, which
    // names the symptom and not the cause — so accumulate it here.
    let call = null
    let finish = 'stop'

    const openBlock = function* (blockType) {
      index += 1
      open = blockType
      text = ''
      call = blockType === 'tool-call' ? { id: '', name: '', arguments: '' } : null
      yield { type: 'block-start', index, blockType }
    }
    const closeBlock = function* () {
      if (open === null) return
      const block =
        open === 'tool-call'
          ? { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }
          : { type: open, text }
      yield { type: 'block-end', index, block }
      open = null
      call = null
    }

    for await (const data of sseEvents(res.body, signal)) {
      if (data === '[DONE]') break
      let evt
      try {
        evt = JSON.parse(data)
      } catch {
        continue // a partial or non-JSON keepalive frame is not fatal
      }
      if (evt.usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: evt.usage.prompt_tokens ?? 0,
            outputTokens: evt.usage.completion_tokens ?? 0,
          },
        }
      }
      const choice = evt.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}

      // Rapid-MLX routes chain-of-thought out of band on its own key, so
      // reasoning never has to be scraped back out of the text channel.
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        if (open !== 'reasoning') {
          yield* closeBlock()
          yield* openBlock('reasoning')
        }
        text += delta.reasoning_content
        yield { type: 'reasoning-delta', index, text: delta.reasoning_content }
      }
      if (typeof delta.content === 'string' && delta.content) {
        if (open !== 'text') {
          yield* closeBlock()
          yield* openBlock('text')
        }
        text += delta.content
        yield { type: 'text-delta', index, text: delta.content }
      }
      for (const tc of delta.tool_calls ?? []) {
        // A NEW id mid-stream means a second call in the same response;
        // close the previous block so each one ends up its own tool-call
        // block rather than two calls' arguments concatenated into one.
        if (open === 'tool-call' && tc.id && call.id && tc.id !== call.id) {
          yield* closeBlock()
        }
        if (open !== 'tool-call') {
          yield* closeBlock()
          yield* openBlock('tool-call')
        }
        if (tc.id) call.id = tc.id
        if (tc.function?.name) call.name = tc.function.name
        const argsDelta = tc.function?.arguments ?? ''
        call.arguments += argsDelta
        yield {
          type: 'tool-call-delta',
          index,
          id: call.id || `call_${index}`,
          ...(tc.function?.name ? { name: tc.function.name } : {}),
          argumentsDelta: argsDelta,
        }
      }
      if (choice.finish_reason) {
        finish =
          choice.finish_reason === 'tool_calls'
            ? 'tool-calls'
            : choice.finish_reason === 'length'
              ? 'max-tokens'
              : 'stop'
      }
    }
    yield* closeBlock()
    yield { type: 'finish', reason: { kind: finish } }
  }
}

function reasoningWire(effort) {
  return EFFORTS.find((e) => e.id === effort)?.wire
}

/** Flatten a block list to the text an OpenAI `content` string can carry. */
function blocksToText(blocks) {
  return (blocks ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * DSH message model -> OpenAI chat messages.
 *
 * The non-obvious part, and what a naive `{role, content}` mapping gets
 * wrong: DSH has **no `tool` role**. `Message.role` is only
 * system|user|assistant, and a tool RESULT is a *user*-role message whose
 * `source.kind === 'tool'` carries the `callId`, holding a
 * ToolResultBlock. Flattening those to plain user text destroys the
 * call/result correlation, so the model re-issues the same call and the
 * agent loop spins until it gives up — which presents as an empty answer
 * and a non-zero exit, with nothing on stderr.
 *
 * Reasoning blocks are deliberately NOT sent back: they are private
 * chain-of-thought, and replaying them into the next request both wastes
 * context and risks leaking them into the visible answer.
 */
function toOpenAiMessages(messages) {
  const out = []
  for (const m of messages ?? []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    const blocks = m.content ?? []

    // Tool results: one OpenAI `tool` message per result block.
    const results = blocks.filter((b) => b?.type === 'tool-result')
    if (results.length) {
      for (const r of results) {
        out.push({
          role: 'tool',
          tool_call_id: r.toolCallId ?? m.source?.callId,
          content: blocksToText(r.content) || (r.isError ? 'error' : ''),
        })
      }
      continue
    }

    // Assistant turns that issued calls must carry them as `tool_calls`,
    // or the following tool message has nothing to correlate against.
    const calls = blocks.filter((b) => b?.type === 'tool-call')
    if (m.role === 'assistant' && calls.length) {
      out.push({
        role: 'assistant',
        content: blocksToText(blocks) || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments ?? '{}' },
        })),
      })
      continue
    }

    out.push({ role: m.role, content: blocksToText(blocks) })
  }
  return out
}

function toOpenAiTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

/** Minimal SSE reader: yields each `data:` payload as a string. */
async function* sseEvents(body, signal) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    if (signal?.aborted) return
    buffer += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
}

export function apply(ctx, config) {
  const adapter = new RapidMlxAdapter(config, ctx.logger)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.logger?.info?.(
    'rapid-mlx provider registered (%s) — model metadata is read from the server, not settings.yaml',
    config?.baseURL || DEFAULT_BASE_URL,
  )
}
