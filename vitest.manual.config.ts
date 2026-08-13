import { defineConfig } from 'vitest/config'

/**
 * Manual-only suite config (tests/hook-probe.manual.ts): real SendInput key
 * injection with side effects — never part of the default `npm test` run.
 * Usage: npx vitest run --config vitest.manual.config.ts
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.manual.ts']
  }
})
