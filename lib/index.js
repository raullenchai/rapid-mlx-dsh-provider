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

import { INVALID_CREDENTIAL_CODE, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

import {
  EFFORTS,
  REQUEST_FIELD_DISPOSITION,
  buildRequestBody,
  requestHeaders,
  toOpenAiMessages,
  toOpenAiTools,
} from './request.js'

import { registerManagement } from './tools.js'

export { REQUEST_FIELD_DISPOSITION, buildRequestBody, requestHeaders, toOpenAiMessages, toOpenAiTools }
export { registerManagement } from './tools.js'

export const name = 'rapid-mlx-provider'
// 'llm' for the provider route; 'tools'/'commands' for the management tools
// and /rapid-mlx overview; 'subprocess' for the CLI-only pull/rm/cached ops.
export const inject = ['llm', 'tools', 'subprocess', 'commands']

/**
 * Plugin config, declared as a schemastery schema per the cookbook rather
 * than read ad hoc off a plain object. cordis validates it before `apply`,
 * so a typo in cordis.patch.yml fails at load with a pointed message
 * instead of silently defaulting and connecting to the wrong place.
 *
 * There is no credential field on purpose: this adapter talks to a local
 * server. If one is ever needed it belongs here with an env fallback —
 * never read from a key file in code.
 */
export const Config = z.object({
  baseURL: z
    .string()
    .default('http://localhost:8000/v1')
    .description('Base URL of the Rapid-MLX OpenAI-compatible API.'),
  cliCommand: z
    .string()
    .default('rapid-mlx')
    .description('The rapid-mlx CLI to invoke for pull/remove/cached (name on PATH or absolute path).'),
})

const PROVIDER = 'rapid-mlx'
const DEFAULT_BASE_URL = 'http://localhost:8000/v1'
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
    // The cookbook sanctions exactly two error paths, and they are not
    // interchangeable: THROW an LlmError for transport and protocol
    // failures, or end the stream with `finish {kind:'error'}` for
    // provider in-band failures. Everything below the request line is a
    // transport failure, so it throws.
    let body
    try {
      body = JSON.stringify(buildRequestBody(options))
    } catch (cause) {
      // Content we refuse to narrow silently (currently images). Rethrown
      // at the boundary as a real LlmError, since lib/request.js has no
      // access to the dsh runtime.
      if (cause?.code === 'UNSUPPORTED') {
        throw new LlmError(cause.message, 'UNSUPPORTED', { cause })
      }
      throw cause
    }

    let res
    try {
      res = await fetch(`${this.#baseURL}/chat/completions`, {
        method: 'POST',
        headers: requestHeaders(options),
        signal: options.signal,
        body,
      })
    } catch (cause) {
      // An aborted request is the caller's own doing, not a fault: let the
      // AbortError through so the runtime classifies it as `aborted`.
      if (cause?.name === 'AbortError') throw cause
      throw new LlmError(
        `cannot reach rapid-mlx at ${this.#baseURL}: ${cause?.message ?? cause}`,
        'TRANSPORT',
        { cause },
      )
    }

    if (!res.ok || !res.body) {
      throw new LlmError(
        `rapid-mlx returned HTTP ${res.status}`,
        httpErrorCode(res.status),
        { status: res.status },
      )
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
    let usage = null
    // Tracks whether the response produced ANY content block. A stop with
    // zero output is a degenerate completion; the contract has a canonical
    // code for it precisely because yielding an empty assistant message
    // ends the turn with nothing for the user or the loop to act on.
    let produced = false

    const openBlock = function* (blockType) {
      index += 1
      open = blockType
      text = ''
      call = blockType === 'tool-call' ? { id: '', name: '', arguments: '' } : null
      produced = true
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

    for await (const data of sseEvents(res.body, options.signal)) {
      if (data === '[DONE]') break
      let evt
      try {
        evt = JSON.parse(data)
      } catch {
        continue // a partial or non-JSON keepalive frame is not fatal
      }
      if (evt.usage) {
        // BUFFERED, not emitted here. The contract is "usage BEFORE
        // finish, nothing after finish", and with
        // stream_options.include_usage the totals arrive in a trailing
        // chunk that can land after finish_reason. Holding it and
        // flushing at end-of-stream is the pattern the cookbook calls the
        // robust one, and it keeps the ordering true no matter which
        // chunk carries the totals.
        usage = {
          inputTokens: evt.usage.prompt_tokens ?? 0,
          outputTokens: evt.usage.completion_tokens ?? 0,
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

    if (!produced) {
      throw new LlmError(
        'rapid-mlx completed the request with no content blocks',
        EMPTY_RESPONSE_CODE,
      )
    }
    // usage strictly before finish, and nothing at all after it.
    if (usage) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: finish } }
  }
}

export function apply(ctx, config) {
  const baseURL = String(config?.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const cliCommand = config?.cliCommand || 'rapid-mlx'

  const adapter = new RapidMlxAdapter(config, ctx.logger)
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // Management tools + `/rapid-mlx` overview. Lazily-bound fetch so a test can
  // stub globalThis.fetch before the first call.
  registerManagement(ctx, {
    baseURL,
    cliCommand,
    subprocess: ctx.subprocess,
    fetchImpl: (input, init) => globalThis.fetch(input, init),
  })

  ctx.logger?.info?.(
    'rapid-mlx provider registered (%s) — model metadata read from the server; management tools + /rapid-mlx active',
    baseURL,
  )
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

/**
 * HTTP status -> stable provider-neutral code.
 *
 * The contract says to route on `code`, never by parsing `message`, so the
 * codes that have canonical constants use them. A local server will rarely
 * emit 401/429, but a reverse proxy or an authenticated Rapid-MLX
 * deployment will, and a caller that wants to retry a quota error should
 * not have to string-match to find one.
 */
function httpErrorCode(status) {
  if (status === 401 || status === 403) return INVALID_CREDENTIAL_CODE
  if (status === 429) return 'QUOTA'
  if (status === 413) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status >= 500) return 'PROVIDER_ERROR'
  return 'INVALID_ARGS'
}
