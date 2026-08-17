// The `no-undef` rule is the entire reason this file exists.
//
// A module split moved `sseEvents` out of index.js and left the call
// behind. `node --check` passed (the syntax is fine), all 17 unit tests
// passed (they import the pure module, not this one), and the package
// still installed and activated cleanly. It failed only when a real `dsh`
// ran a real query: "UNKNOWN: sseEvents is not defined".
//
// An undefined free identifier inside a function body is invisible to
// every cheap check and to any test that does not execute that exact
// line. This catches it statically instead.
export default [
  {
    files: ['lib/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Node's web-standard globals. Listed explicitly rather than pulled
      // from a preset so that a genuinely undefined identifier still
      // stands out — the whole value of this config is that the list is
      // short enough to read.
      globals: {
        fetch: 'readonly',
        console: 'readonly',
        process: 'readonly',
        globalThis: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        AbortSignal: 'readonly',
        Response: 'readonly',
        ReadableStream: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
]
