/**
 * Pure request mapping: DSH `GenerateOptions` -> the OpenAI-compatible
 * chat-completions wire.
 *
 * Deliberately imports NOTHING. This half has no business depending on the
 * DSH runtime, and keeping it free of `@deepseek-ai/dsh-llm` means the
 * tests that cover it run anywhere — including CI, where the peer dep is
 * not installed.
 */

/**
 * Graded levels mapped onto the OpenAI `reasoning_effort` wire values that
 * Rapid-MLX validates against a closed set. `name` is REQUIRED by
 * `LlmReasoningEffortInfo`, not decorative — returning `{id}` alone makes
 * DSH reject the whole model with INVALID_MODEL_REASONING.
 */
export const EFFORTS = [
  { id: 'off', name: 'Off', wire: 'none' },
  { id: 'low', name: 'Low', wire: 'low' },
  { id: 'medium', name: 'Medium', wire: 'medium' },
  { id: 'high', name: 'High', wire: 'high' },
]

function reasoningWire(effort) {
  return EFFORTS.find((e) => e.id === effort)?.wire
}

/**
 * Every field of `GenerateOptions`, and what this adapter does with it.
 *
 * This exists because the first version of `stream()` destructured
 * `{model, messages, tools, signal}` and silently dropped the rest —
 * including `system`, so the model never received its persona or working
 * directory. Every end-to-end test still passed, because the tool schemas
 * carried enough signal for simple tasks. A dropped field does not fail;
 * it degrades, which is the hardest kind of bug to notice.
 *
 * So dropping is now a decision that has to be written down. The test
 * suite asserts this map covers every field the installed
 * `@deepseek-ai/dsh-llm` declares, which turns "DSH added a field we do
 * not handle" from an invisible regression into a red build.
 */
export const REQUEST_FIELD_DISPOSITION = Object.freeze({
  provider: 'routing — selects this adapter; never sent on the wire',
  model: 'sent as `model`',
  messages: 'sent as `messages` (see toOpenAiMessages)',
  system: 'prepended as a `system`-role message',
  tools: 'sent as `tools`',
  temperature: 'sent as `temperature` when the caller set one',
  maxTokens: 'sent as `max_tokens`',
  stop: 'sent as `stop`',
  reasoningEffort: 'mapped to the `reasoning_effort` wire value',
  signal: 'passed to fetch for cancellation',
  purpose: 'sent as the x-dsh-purpose header (see requestHeaders)',
  sessionId:
    'NOT SENT — deliberate. Rapid-MLX does not consume a client session id, ' +
    'and forwarding one would put a client-side identifier into server logs ' +
    'for no behavioural gain. Revisit if the engine ever keys anything on it.',
})

/** Build the chat-completions body. Pure, so it is directly testable. */
export function buildRequestBody(options) {
  const messages = toOpenAiMessages(options.messages)
  // DSH carries the system prompt OUTSIDE the message list (`system?:
  // string`, "adapters map to the provider's system slot"). Dropping it
  // costs the model its persona, working directory and agent
  // instructions — and nothing errors when you do.
  if (typeof options.system === 'string' && options.system) {
    messages.unshift({ role: 'system', content: options.system })
  }
  const effort = reasoningWire(options.reasoningEffort)
  return {
    model: options.model,
    messages,
    ...(options.tools?.length ? { tools: toOpenAiTools(options.tools) } : {}),
    // `typeof`, not truthiness: temperature 0 is a meaningful request for
    // greedy decoding and must not be dropped as falsy.
    ...(typeof options.temperature === 'number'
      ? { temperature: options.temperature }
      : {}),
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop?.length ? { stop: options.stop } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    stream: true,
    stream_options: { include_usage: true },
  }
}

/**
 * Headers for one call.
 *
 * `purpose` marks auxiliary calls (compaction, session titling) that are
 * not the user's interactive turn. DeepSeek's own adapter forwards this
 * as request attribution; we mirror it so the engine CAN eventually admit
 * background work at a lower priority. Rapid-MLX does not act on it
 * today — `scheduler.py` has no request-priority concept — so this is the
 * client half of a seam whose server half is not built yet. It is
 * model-invisible either way: a header, never the body.
 */
export function requestHeaders(options) {
  return {
    'Content-Type': 'application/json',
    ...(options.purpose ? { 'x-dsh-purpose': String(options.purpose) } : {}),
  }
}

/**
 * Raised for content this adapter cannot put on the wire.
 *
 * Carries the contract's `UNSUPPORTED` code but is a plain Error, because
 * this module imports nothing — `stream()` rethrows it as a real
 * `LlmError` at the boundary where the dsh runtime is available.
 */
export class UnsupportedContentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnsupportedContentError'
    this.code = 'UNSUPPORTED'
  }
}

/**
 * Flatten a block list to the text an OpenAI `content` string can carry.
 *
 * Refuses rather than quietly narrows. The cookbook's rule — "a
 * GenerateOptions field your provider cannot honor: throw
 * LlmError(..., 'UNSUPPORTED') rather than silently dropping it" — applies
 * to content too: an image dropped here reaches the model as a request
 * that simply does not mention the picture the user attached, and the
 * answer that comes back is confidently about nothing.
 */
function blocksToText(blocks) {
  const out = []
  for (const b of blocks ?? []) {
    if (b?.type === 'text') out.push(b.text)
    else if (b?.type === 'image') {
      throw new UnsupportedContentError(
        'rapid-mlx provider cannot send image content yet; use the generic ' +
          'openai-completions provider for a vision model',
      )
    }
    // reasoning / tool-call / tool-result are handled by the caller.
  }
  return out.join('')
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
export function toOpenAiMessages(messages) {
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

export function toOpenAiTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}
