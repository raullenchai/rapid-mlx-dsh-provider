/**
 * resolveModel() — the capacity it reports drives dsh-compaction-basic. It
 * must prefer the server's memory-fitted `max_model_len` over the native
 * `context_window`, fall back to `context_window` for older servers, and
 * report nothing (never a guess) when the server answers neither.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as provider from '../lib/index.js'

/** Build the adapter through the real apply() with stubbed host services. */
function makeAdapter(baseURL) {
  let adapter
  provider.apply(
    {
      llm: { registerAdapter: (_routes, instance) => (adapter = instance) },
      tools: { register() {} },
      commands: { register() {} },
      subprocess: {},
      logger: { info() {} },
    },
    { baseURL },
  )
  return adapter
}

/** Run fn with globalThis.fetch stubbed to return `body` from /models. */
async function withModels(body, fn) {
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/models$/)
    return { ok: true, json: async () => body }
  }
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

const oneModel = (extra) => ({
  object: 'list',
  data: [{ id: 'm', object: 'model', context_window: 40960, ...extra }],
})

test('prefers max_model_len over context_window', async () => {
  const adapter = makeAdapter('http://x/v1')
  await withModels(oneModel({ max_model_len: 12000 }), async () => {
    const info = await adapter.resolveModel('rapid-mlx', 'm')
    assert.equal(info.context.contextWindow, 12000)
  })
})

test('falls back to context_window when max_model_len is absent (older server)', async () => {
  const adapter = makeAdapter('http://x/v1')
  await withModels(oneModel({}), async () => {
    const info = await adapter.resolveModel('rapid-mlx', 'm')
    assert.equal(info.context.contextWindow, 40960)
  })
})

test('ignores a null/zero max_model_len and uses context_window', async () => {
  const adapter = makeAdapter('http://x/v1')
  await withModels(oneModel({ max_model_len: null }), async () => {
    const info = await adapter.resolveModel('rapid-mlx', 'm')
    assert.equal(info.context.contextWindow, 40960)
  })
  await withModels(oneModel({ max_model_len: 0 }), async () => {
    const info = await adapter.resolveModel('rapid-mlx', 'm')
    assert.equal(info.context.contextWindow, 40960)
  })
})

test('reports no context when the server answers neither field', async () => {
  const adapter = makeAdapter('http://x/v1')
  const body = { object: 'list', data: [{ id: 'm', object: 'model' }] }
  await withModels(body, async () => {
    const info = await adapter.resolveModel('rapid-mlx', 'm')
    assert.equal(info.context, undefined)
  })
})
