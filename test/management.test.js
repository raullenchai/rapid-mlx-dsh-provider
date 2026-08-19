/**
 * Unit tests for the management surface: the fragile CLI-table parser, the
 * /v1/models dedup, and health — all against fixtures and stubs so they run in
 * CI with no server and no `rapid-mlx` on PATH.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseCached, parseSize } from '../lib/cli.js'
import { fetchServed, checkHealth } from '../lib/management.js'
import { renderServed, renderCached, renderHealth, renderOperation, formatBytes } from '../lib/tools.js'

// A byte-for-byte capture of real `rapid-mlx models --cached` output, including
// the (unmapped)/(incomplete) states and the GiB sizes that contain a space.
const CACHED_FIXTURE = `
  Cached models (4 on disk)
  ────────────────────────────────────────────────────────────────────────────────
  Alias                   HF repo                                    Size        Modified
  ────────────────────────────────────────────────────────────────────────────────
  qwen3.5-9b-4bit         mlx-community/Qwen3.5-9B-4bit               5.6 GiB     22h ago
  (unmapped)              mlx-community/Qwen3-ASR-1.7B-5bit           1.7 GiB     19h ago
  (incomplete)            mlx-community/gemma-4-26b-a4b-it-4bit       30.7 MiB    22h ago
  llama3-1b-4bit          mlx-community/Llama-3.2-1B-Instruct-4bit    679.6 MiB   18h ago
  ────────────────────────────────────────────────────────────────────────────────
  Total: 8.0 GiB
`

test('parseSize handles the units the CLI emits', () => {
  assert.equal(parseSize('5.6 GiB'), Math.round(5.6 * 1024 ** 3))
  assert.equal(parseSize('30.7 MiB'), Math.round(30.7 * 1024 ** 2))
  assert.equal(parseSize('750.8 MiB'), Math.round(750.8 * 1024 ** 2))
  assert.equal(parseSize('2.1 MiB'), Math.round(2.1 * 1024 ** 2))
  assert.equal(parseSize('nonsense'), undefined)
})

test('parseCached extracts every row, its state, and the total', () => {
  const out = parseCached(CACHED_FIXTURE)
  assert.equal(out.models.length, 4)
  assert.equal(out.count, 4)
  assert.equal(out.totalBytes, Math.round(8.0 * 1024 ** 3))

  const [a, b, c, d] = out.models
  assert.equal(a.alias, 'qwen3.5-9b-4bit')
  assert.equal(a.state, 'ok')
  assert.equal(a.repo, 'mlx-community/Qwen3.5-9B-4bit')
  assert.equal(a.sizeBytes, Math.round(5.6 * 1024 ** 3))
  assert.equal(a.modified, '22h ago')

  // A downloaded repo with no user alias is a state, not a name.
  assert.equal(b.alias, null)
  assert.equal(b.state, 'unmapped')
  assert.equal(c.alias, null)
  assert.equal(c.state, 'incomplete')
  assert.equal(d.alias, 'llama3-1b-4bit')
})

test('parseCached skips noise and never invents rows', () => {
  assert.deepEqual(parseCached('').models, [])
  assert.deepEqual(parseCached('  Total: 0 B\n  garbage line\n').models, [])
})

// A minimal /v1/models body: rapid-mlx lists the one served model twice — once
// under its HF repo id, once under its alias — with identical facts.
function servedBody() {
  const facts = {
    object: 'model',
    recommended_sampling: null,
    is_hybrid: false,
    is_moe: false,
    tool_call_parser: 'hermes',
    reasoning_parser: 'qwen3',
    modality: 'text',
    context_window: 40960,
    capabilities: ['text', 'tools'],
  }
  return {
    object: 'list',
    data: [
      { id: 'mlx-community/Qwen3-0.6B-8bit', ...facts },
      { id: 'qwen3-0.6b-8bit', ...facts },
    ],
  }
}

const okFetch = (body) => async () => ({ ok: true, json: async () => body })

test('fetchServed folds the duplicate id entries into one model', async () => {
  const served = await fetchServed('http://x/v1', okFetch(servedBody()))
  assert.equal(served.length, 1)
  const m = served[0]
  assert.deepEqual(m.ids.sort(), ['mlx-community/Qwen3-0.6B-8bit', 'qwen3-0.6b-8bit'])
  assert.equal(m.alias, 'qwen3-0.6b-8bit')
  assert.equal(m.repo, 'mlx-community/Qwen3-0.6B-8bit')
  assert.equal(m.contextWindow, 40960)
  assert.equal(m.reasoningParser, 'qwen3')
  assert.equal(m.toolCallParser, 'hermes')
})

test('fetchServed keeps genuinely different models separate', async () => {
  const body = servedBody()
  body.data.push({ id: 'other-model', object: 'model', context_window: 8192, reasoning_parser: null, capabilities: ['text'] })
  const served = await fetchServed('http://x/v1', okFetch(body))
  assert.equal(served.length, 2)
})

test('fetchServed throws on a non-ok response (so health can report it)', async () => {
  const bad = async () => ({ ok: false, status: 503 })
  await assert.rejects(() => fetchServed('http://x/v1', bad), /HTTP 503/)
})

// A subprocess stub good enough for the CLI-version probe in checkHealth.
function stubSubprocess({ resolves = true, exitCode = 0, stdout = 'rapid-mlx 0.12.15\n' } = {}) {
  return {
    async resolveExecutable(cmd) {
      if (!resolves) throw new Error('not found')
      return `/usr/bin/${cmd}`
    },
    spawn() {
      return {
        done: Promise.resolve({ exitCode }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }
    },
  }
}

test('checkHealth reports API and CLI as two independent facts', async () => {
  const health = await checkHealth('http://x/v1', okFetch(servedBody()), stubSubprocess(), 'rapid-mlx')
  assert.equal(health.api.ok, true)
  assert.equal(health.api.servedCount, 1)
  assert.equal(health.cli.present, true)
  assert.equal(health.cli.version, '0.12.15')
})

test('checkHealth: API down but CLI present, and vice versa', async () => {
  const apiDown = async () => ({ ok: false, status: 500 })
  const h1 = await checkHealth('http://x/v1', apiDown, stubSubprocess(), 'rapid-mlx')
  assert.equal(h1.api.ok, false)
  assert.equal(h1.cli.present, true)

  const h2 = await checkHealth('http://x/v1', okFetch(servedBody()), stubSubprocess({ resolves: false }), 'rapid-mlx')
  assert.equal(h2.api.ok, true)
  assert.equal(h2.cli.present, false)
})

test('renderers produce readable, non-throwing text', () => {
  const served = [{ alias: 'q', repo: 'org/Q', contextWindow: 40960, reasoningParser: 'qwen3', toolCallParser: 'hermes', capabilities: ['text', 'tools'] }]
  assert.match(renderServed({ models: served }), /Serving 1 model/)
  assert.match(renderServed({ models: [] }), /No model is being served/)
  assert.match(renderCached(parseCached(CACHED_FIXTURE)), /4 cached model/)
  assert.match(renderHealth({ api: { ok: true, servedCount: 1 }, cli: { present: true, version: '0.12.15' } }), /API: ok/)
  assert.match(renderOperation({ op: 'remove', name: 'x', removed: true }), /Removed x/)
  assert.match(renderOperation({ op: 'pull', name: 'x', ok: false, error: 'boom' }), /Failed to pull x: boom/)
  assert.equal(formatBytes(5.6 * 1024 ** 3).endsWith('GB'), true)
})
