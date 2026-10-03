import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // No test reaches a model: the live engines are tested against fakes of their HTTP APIs.
    env: { OPENROUTER_API_KEY: '' },
  },
});
