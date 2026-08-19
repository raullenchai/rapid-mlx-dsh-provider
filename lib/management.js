/**
 * Server-side reads over the OpenAI-compatible surface.
 *
 * `/v1/models` reports the model(s) the server is CURRENTLY serving — not the
 * full alias catalog and not the download cache (both CLI-only). It lists each
 * served model twice, once under its Hugging Face repo id and once under its
 * short alias; `fetchServed()` folds those back into one record per model so a
 * tool does not show the same model as two.
 */

import { resolveCli, runCli } from './cli.js'

/** GET /v1/models and return the raw `data` array, or [] on any failure. */
async function modelEntries(baseURL, fetchImpl, signal) {
  const res = await fetchImpl(`${baseURL}/models`, signal ? { signal } : {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return Array.isArray(body?.data) ? body.data.filter((e) => e && typeof e === 'object') : []
}

/** A stable fingerprint of a model's facts, to group its duplicate id entries. */
function fingerprint(e) {
  return JSON.stringify([
    e.context_window ?? null,
    e.reasoning_parser ?? null,
    e.tool_call_parser ?? null,
    e.modality ?? null,
    Array.isArray(e.capabilities) ? [...e.capabilities].sort() : null,
  ])
}

/**
 * The models the server is serving right now, deduplicated, with the rich
 * facts the generic OpenAI route discards.
 */
export async function fetchServed(baseURL, fetchImpl, signal) {
  const entries = await modelEntries(baseURL, fetchImpl, signal)
  const groups = new Map()
  for (const e of entries) {
    const key = fingerprint(e)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }
  return [...groups.values()].map((group) => {
    const ids = group.map((e) => String(e.id))
    const repo = ids.find((id) => id.includes('/'))
    const alias = ids.find((id) => !id.includes('/'))
    const e = group[0]
    return {
      ids,
      alias: alias ?? repo ?? ids[0],
      repo: repo ?? null,
      contextWindow: Number.isInteger(e.context_window) ? e.context_window : undefined,
      reasoningParser: typeof e.reasoning_parser === 'string' ? e.reasoning_parser : null,
      toolCallParser: typeof e.tool_call_parser === 'string' ? e.tool_call_parser : null,
      isMoe: e.is_moe === true,
      isHybrid: e.is_hybrid === true,
      modality: typeof e.modality === 'string' ? e.modality : undefined,
      capabilities: Array.isArray(e.capabilities) ? e.capabilities.map(String) : [],
      recommendedSampling: e.recommended_sampling ?? null,
    }
  })
}

/**
 * Two independent liveness signals, never conflated: whether the HTTP API
 * answers, and whether the `rapid-mlx` CLI is reachable (for pull/rm/cached).
 * A server can answer HTTP while the CLI is off PATH, or vice versa.
 */
export async function checkHealth(baseURL, fetchImpl, subprocess, cliCommand, options = {}) {
  const { timeoutMs = 5_000, signal } = options
  const api = await (async () => {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const served = await fetchServed(baseURL, fetchImpl, controller.signal)
      return { ok: true, servedCount: served.length, served }
    } catch (cause) {
      return { ok: false, error: cause?.message ?? String(cause) }
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  })()

  const cli = await (async () => {
    let executable
    try {
      executable = await resolveCli(subprocess, cliCommand)
    } catch (cause) {
      return { present: false, error: cause?.message ?? String(cause) }
    }
    const { code, stdout } = await runCli(subprocess, executable, ['--version'], { timeoutMs, signal })
    if (code !== 0) return { present: false, error: `\`${cliCommand} --version\` exited ${code}` }
    const version = stdout.trim().split(/\s+/).pop()
    return { present: true, version: version || undefined }
  })()

  return { api, cli }
}
