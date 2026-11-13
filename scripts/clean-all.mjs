// Removes the caches that `yarn clean` (turbo run clean) cannot reach, so a
// following `yarn build` genuinely starts from nothing. See docs/TESTING.md,
// "Forcing a genuine rebuild". Deliberately does not build.
import { globSync, rmSync } from 'node:fs';

const patterns = [
  '.turbo',
  'packages/*/.turbo',
  'node_modules/.vite',
  'coverage',
  'packages/*/coverage',
  'packages/*/test-results',
  'packages/*/playwright-report',
];

for (const pattern of patterns) {
  for (const target of globSync(pattern)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`removed ${target}`);
  }
}
