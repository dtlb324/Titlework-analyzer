import { createSqlClient } from '../api/_lib/jobs.js';
import pkg from '../package.json' with { type: 'json' };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('database client uses Neon serverless Postgres connection strings', () => {
  const sql = createSqlClient('postgres://title:secret@ep-free-tier.us-east-2.aws.neon.tech/titlework?sslmode=require');
  assert(typeof sql === 'function', 'Expected Neon sql tagged-template client');
});

test('database dependency targets Neon instead of paid Cloud SQL driver config', () => {
  assert(pkg.dependencies['@neondatabase/serverless'], 'Expected Neon serverless dependency');
  assert(!pkg.dependencies.postgres, 'Standard postgres driver is not needed for Neon free-tier target');
});

let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
