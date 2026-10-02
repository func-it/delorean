import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // The black-box suite, against the backend at BASE_URL.
        test: {
          name: 'e2e',
          include: ['suites/**/*.e2e.ts'],
          globalSetup: ['suites/setup.ts'],
          testTimeout: 60_000,
        },
      },
      {
        // Tests of the harness itself: no backend needed.
        test: {
          name: 'harness',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
  },
});
