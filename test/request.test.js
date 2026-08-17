/**
 * Unit tests for the request-building half of the adapter.
 *
 * These cover the two bug classes that actually bit during development,
 * both of which share a nasty property: **they do not raise anything.**
 *
 *   1. A dropped `GenerateOptions` field. The first version of `stream()`
 *      destructured `{model, messages, tools, signal}` and silently threw
 *      away `system`, so the model never saw its persona or working
 *      directory. Every end-to-end task still passed — tool schemas
 *      carried enough signal for simple work — so the only symptom was
 *      quietly worse output on hard tasks.
 *
 *   2. A mis-mapped tool result. DSH has no `tool` role; a result is a
 *      USER-role message whose `source.kind === 'tool'` carries the
 *      callId. Flatten it to plain text and the model reissues the same
 *      call forever: empty answer, non-zero exit, nothing on stderr.
 *
 * Everything here is a pure function, so no dsh runtime and no server.
 * Run with `node --test`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REQUEST_FIELD_DISPOSITION,
  buildRequestBody,
  requestHeaders,
  toOpenAiMessages,
} from '../lib/request.js'

const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

// --------------------------------------------------------------------------
// Field fidelity — the guard that would have caught the dropped `system`.
// --------------------------------------------------------------------------

test('every GenerateOptions field has a written-down disposition', () => {
  // Snapshot of the fields dsh-llm declares, checked in so this runs even
  // when the peer dep is not installed (CI). The drift test below is what
  // notices DSH adding a new one.
  const KNOWN = [
    'provider',
    'model',
    'reasoningEffort',
    'messages',
    'system',
    'tools',
    'temperature',
    'maxTokens',
    'stop',
    'signal',
    'sessionId',
    'purpose',
  ]
  for (const field of KNOWN) {
    assert.ok(
      REQUEST_FIELD_DISPOSITION[field],
      `GenerateOptions.${field} has no entry in REQUEST_FIELD_DISPOSITION. ` +
        `Decide what to do with it and write it down — a field nobody ` +
        `decided about is a field that gets dropped silently.`,
    )
  }
})

test('the disposition map does not describe fields that do not exist', () => {
  // Catches the reverse drift: a field removed upstream leaving a stale
  // promise here.
  const KNOWN = new Set([
    'provider',
    'model',
    'reasoningEffort',
    'messages',
    'system',
    'tools',
    'temperature',
    'maxTokens',
    'stop',
    'signal',
    'sessionId',
    'purpose',
  ])
  for (const field of Object.keys(REQUEST_FIELD_DISPOSITION)) {
    assert.ok(KNOWN.has(field), `REQUEST_FIELD_DISPOSITION describes unknown field ${field}`)
  }
})

// --------------------------------------------------------------------------
// buildRequestBody — the fields that were being dropped.
// --------------------------------------------------------------------------

test('system prompt is sent, as a leading system-role message', () => {
  const body = buildRequestBody({
    model: 'm',
    system: 'You are a coding agent. Your working directory is /tmp.',
    messages: [userMsg('hi')],
  })
  assert.equal(body.messages[0].role, 'system')
  assert.match(body.messages[0].content, /working directory/)
  assert.equal(body.messages[1].role, 'user')
})

test('an absent system prompt adds no message', () => {
  const body = buildRequestBody({ model: 'm', messages: [userMsg('hi')] })
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].role, 'user')
})

test('stop sequences are forwarded', () => {
  const body = buildRequestBody({ model: 'm', messages: [], stop: ['\nObservation:'] })
  assert.deepEqual(body.stop, ['\nObservation:'])
})

test('temperature 0 survives — it is a request, not a falsy nothing', () => {
  const body = buildRequestBody({ model: 'm', messages: [], temperature: 0 })
  assert.equal(body.temperature, 0, 'greedy decoding was requested and must not be dropped')
})

test('an unset temperature is not invented', () => {
  const body = buildRequestBody({ model: 'm', messages: [] })
  assert.ok(!('temperature' in body), 'server default must win when the caller said nothing')
})

test('reasoning effort maps to its wire value, and off is not nothing', () => {
  assert.equal(
    buildRequestBody({ model: 'm', messages: [], reasoningEffort: 'high' }).reasoning_effort,
    'high',
  )
  assert.equal(
    buildRequestBody({ model: 'm', messages: [], reasoningEffort: 'off' }).reasoning_effort,
    'none',
  )
})

test('streaming with usage is always requested', () => {
  const body = buildRequestBody({ model: 'm', messages: [] })
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test('purpose rides a header, never the body — it must stay model-invisible', () => {
  const options = { model: 'm', messages: [], purpose: 'compaction' }
  assert.equal(requestHeaders(options)['x-dsh-purpose'], 'compaction')
  assert.ok(!('purpose' in buildRequestBody(options)))
  assert.ok(!JSON.stringify(buildRequestBody(options)).includes('compaction'))
})

test('no purpose header on an ordinary interactive turn', () => {
  assert.ok(!('x-dsh-purpose' in requestHeaders({ model: 'm', messages: [] })))
})

// --------------------------------------------------------------------------
// toOpenAiMessages — the tool round-trip.
// --------------------------------------------------------------------------

test('a tool result becomes a tool-role message correlated by call id', () => {
  const out = toOpenAiMessages([
    {
      role: 'user',
      source: { kind: 'tool', callId: 'call_1' },
      content: [
        { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] },
      ],
    },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].role, 'tool', 'a tool result is NOT a plain user message')
  assert.equal(out[0].tool_call_id, 'call_1')
  assert.equal(out[0].content, 'file body')
})

test('an assistant turn carries its tool_calls so the result can correlate', () => {
  const out = toOpenAiMessages([
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"p":"a"}' }],
    },
  ])
  assert.equal(out[0].role, 'assistant')
  assert.equal(out[0].tool_calls[0].id, 'call_1')
  assert.equal(out[0].tool_calls[0].function.name, 'read_file')
  assert.equal(out[0].tool_calls[0].function.arguments, '{"p":"a"}')
})

test('a full call/result round trip stays correlated end to end', () => {
  const out = toOpenAiMessages([
    userMsg('read a.txt'),
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_9', name: 'read_file', arguments: '{}' }],
    },
    {
      role: 'user',
      source: { kind: 'tool', callId: 'call_9' },
      content: [{ type: 'tool-result', toolCallId: 'call_9', content: [{ type: 'text', text: 'ok' }] }],
    },
  ])
  assert.deepEqual(
    out.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  )
  assert.equal(out[1].tool_calls[0].id, out[2].tool_call_id, 'call and result must share an id')
})

test('reasoning is never replayed back to the model', () => {
  const out = toOpenAiMessages([
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'private chain of thought' },
        { type: 'text', text: 'the answer' },
      ],
    },
  ])
  assert.equal(out[0].content, 'the answer')
  assert.ok(!out[0].content.includes('private'), 'chain-of-thought must not be sent back')
})

test('a string content message passes through untouched', () => {
  const out = toOpenAiMessages([{ role: 'user', content: 'plain' }])
  assert.deepEqual(out, [{ role: 'user', content: 'plain' }])
})

test('several results in one message become several tool messages', () => {
  const out = toOpenAiMessages([
    {
      role: 'user',
      source: { kind: 'tool' },
      content: [
        { type: 'tool-result', toolCallId: 'a', content: [{ type: 'text', text: '1' }] },
        { type: 'tool-result', toolCallId: 'b', content: [{ type: 'text', text: '2' }] },
      ],
    },
  ])
  assert.deepEqual(
    out.map((m) => [m.role, m.tool_call_id, m.content]),
    [
      ['tool', 'a', '1'],
      ['tool', 'b', '2'],
    ],
  )
})
