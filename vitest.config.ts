import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Separate from vite.config.ts so the dev/build pipeline stays untouched.
// jsdom is the default environment because several modules under test touch
// window / localStorage / document; pure-math files work fine under it too.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
    // Keep the suite fast and deterministic — no real timers/network.
    restoreMocks: true,
  },
})
