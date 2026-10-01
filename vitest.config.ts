import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['tests/support/global-setup.ts'],
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/web/client/**', 'src/main.ts'],
      reporter: ['lcovonly', 'text-summary'],
      reportsDirectory: 'coverage',
    },
  },
})
