import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // The black-box suite, against the quoter at BASE_URL.
        test: {
          name: 'e2e',
          include: ['suites/**/*.e2e.ts'],
          globalSetup: ['suites/setup.ts'],
          testTimeout: 60_000,
        },
      },
      {
        // The three quoters against each other, on their fake engines
        // (scripts/e2e-parity.sh): same bytes, same logs, same commands.
        test: {
          name: 'parity',
          include: ['parity/**/*.parity.ts'],
          testTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        // Tests of the harness itself: no quoter needed.
        test: {
          name: 'harness',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
  },
});
