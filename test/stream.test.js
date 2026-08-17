/**
 * Protocol-obligation tests for `stream()`, from
 * docs/cookbook/adding-an-llm-adapter.md — "the contract two
 * implementations verified".
 *
 * These need the dsh peer deps because they exercise real `LlmError`
 * codes; CI installs them. If they are missing the file skips loudly
 * rather than passing vacuously — a protocol test that silently does not
 * run is worse than no protocol test.
 */

import { test, skip } from 'node:test'
import assert from 'node:assert/strict'

let mod
try {
  mod = await import('../lib/index.js')
} catch (err) {
  skip(`peer deps unavailable, cannot verify the protocol contract: ${err.message}`)
}

/** Register the adapter through the real `apply()` and hand it back. */
function makeAdapter(baseURL = 'http://127.0.0.1:1/v1') {
  let adapter
  mod.apply(
    {
      llm: {
        registerAdapter(routes, instance) {
          assert.deepEqual(routes, ['rapid-mlx'], 'must own exactly the rapid-mlx route')
          adapter = instance
        },
      },
      logger: { info() {} },
    },
    { baseURL },
  )
  return adapter
}

/** Replace global fetch for one call. */
function withFetch(impl, fn) {
  const real = globalThis.fetch
  globalThis.fetch = impl
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = real
  })
}

const sse = (...frames) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(new TextEncoder().encode(`data: ${f}\n\n`))
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        c.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )

const drain = async (it) => {
  const out = []
  for await (const c of it) out.push(c)
  return out
}

test('apply() registers exactly the rapid-mlx route', () => {
  assert.ok(makeAdapter(), 'apply did not hand an adapter to registerAdapter')
})

test('an HTTP failure THROWS LlmError — it does not end the stream quietly', async () => {
  const adapter = makeAdapter()
  await withFetch(
    async () => new Response('nope', { status: 500 }),
    async () => {
      await assert.rejects(
        () => drain(adapter.stream({ model: 'm', messages: [] })),
        (err) => {
          // The cookbook: transport/protocol failures throw with a stable
          // code; only provider in-band failures end via finish.
          assert.equal(err.code, 'PROVIDER_ERROR')
          assert.equal(err.failure?.status ?? err.status, 500)
          return true
        },
      )
    },
  )
})

test('401 maps to the canonical INVALID_CREDENTIAL code, not a bespoke string', async () => {
  const adapter = makeAdapter()
  await withFetch(
    async () => new Response('denied', { status: 401 }),
    async () => {
      await assert.rejects(
        () => drain(adapter.stream({ model: 'm', messages: [] })),
        (err) => err.code === 'INVALID_CREDENTIAL',
      )
    },
  )
})

test('an unreachable server throws TRANSPORT rather than leaking a raw fetch error', async () => {
  const adapter = makeAdapter()
  await withFetch(
    async () => {
      throw new TypeError('fetch failed')
    },
    async () => {
      await assert.rejects(
        () => drain(adapter.stream({ model: 'm', messages: [] })),
        (err) => err.code === 'TRANSPORT' && /cannot reach rapid-mlx/.test(err.message),
      )
    },
  )
})

test('an abort is passed through, not reclassified as a fault', async () => {
  const adapter = makeAdapter()
  await withFetch(
    async () => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    },
    async () => {
      await assert.rejects(
        () => drain(adapter.stream({ model: 'm', messages: [] })),
        (err) => err.name === 'AbortError',
      )
    },
  )
})

test('usage is emitted BEFORE finish, and nothing follows finish', async () => {
  const adapter = makeAdapter()
  await withFetch(
    async () =>
      // The trailing usage-only chunk: it arrives AFTER finish_reason,
      // which is exactly the ordering hazard the contract calls out.
      sse(
        '{"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
      ),
    async () => {
      const chunks = await drain(adapter.stream({ model: 'm', messages: [] }))
      const kinds = chunks.map((c) => c.type)
      const u = kinds.indexOf('usage')
      const f = kinds.indexOf('finish')
      assert.ok(u !== -1, 'usage was dropped')
      assert.ok(u < f, `usage must precede finish, got ${kinds.join(',')}`)
      assert.equal(f, kinds.length - 1, 'finish must be the last chunk')
      assert.equal(chunks[u].usage.inputTokens, 7)
    },
  )
})

test('a completion with no content blocks raises EMPTY_RESPONSE', async () => {
  const adapter = makeAdapter()
  await withFetch(
    async () => sse('{"choices":[{"delta":{},"finish_reason":"stop"}]}'),
    async () => {
      await assert.rejects(
        () => drain(adapter.stream({ model: 'm', messages: [] })),
        // Yielding an empty assistant message would end the turn with
        // nothing for the user or the loop to act on.
        (err) => err.code === 'EMPTY_RESPONSE',
      )
    },
  )
})

test('unsupported content surfaces as an LlmError, not the raw internal error', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () =>
      drain(
        adapter.stream({
          model: 'm',
          messages: [{ role: 'user', content: [{ type: 'image', image: 'x' }] }],
        }),
      ),
    (err) => err.code === 'UNSUPPORTED' && err.constructor.name === 'LlmError',
  )
})

test('block indexes are allocated in first-seen order and reused per block', async () => {
  const adapter = makeAdapter()
  await withFetch(
    async () =>
      sse(
        '{"choices":[{"delta":{"reasoning_content":"think"},"finish_reason":null}]}',
        '{"choices":[{"delta":{"content":"a"},"finish_reason":null}]}',
        '{"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}',
      ),
    async () => {
      const chunks = await drain(adapter.stream({ model: 'm', messages: [] }))
      const starts = chunks.filter((c) => c.type === 'block-start')
      assert.deepEqual(
        starts.map((c) => [c.index, c.blockType]),
        [
          [0, 'reasoning'],
          [1, 'text'],
        ],
      )
      const textDeltas = chunks.filter((c) => c.type === 'text-delta')
      assert.deepEqual(textDeltas.map((c) => c.index), [1, 1], 'same block reuses its index')
    },
  )
})

test('tool-call arguments stay raw JSON strings end to end', async () => {
  const adapter = makeAdapter()
  await withFetch(
    async () =>
      sse(
        '{"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"f","arguments":"{\\"a\\":"}}]},"finish_reason":null}]}',
        '{"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}',
      ),
    async () => {
      const chunks = await drain(adapter.stream({ model: 'm', messages: [] }))
      const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
      assert.equal(deltas.map((d) => d.argumentsDelta).join(''), '{"a":1}')
      const end = chunks.find((c) => c.type === 'block-end')
      // Re-stringified or parsed-and-lost would both fail here.
      assert.equal(end.block.arguments, '{"a":1}')
      assert.equal(end.block.id, 'c1')
      assert.equal(end.block.name, 'f')
      assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
    },
  )
})
