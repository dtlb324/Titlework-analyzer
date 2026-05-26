import { readFileSync } from 'fs';
import { request } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from '../server.js';
import { createWorkerHealthServer } from '../worker.js';
import { getRuntimeInfo } from '../api/_lib/runtime-info.js';
import {
  compareServiceParity,
  extractEnvNames,
  extractImageDigest,
  validateRequiredEnv,
  validateTagVersion,
  verifyHealth,
  verifyRelease,
} from '../scripts/verify-release.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requestServer(server, path = '/healthz') {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: server.address().port,
      path,
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const releaseTag = `v${packageVersion}`;

test('runtime info reports release metadata from the environment with package fallback', () => withEnv({
  RELEASE_VERSION: 'v2.3.1',
  GIT_SHA: 'abc1234',
  IMAGE_DIGEST: 'sha256:abc',
  K_REVISION: 'titlework-analyzer-api-00042-xzy',
}, () => {
  const info = getRuntimeInfo();
  assert(info.version === 'v2.3.1', `Expected env release version, got ${info.version}`);
  assert(info.packageVersion === packageVersion, `Expected package fallback version, got ${info.packageVersion}`);
  assert(info.gitSha === 'abc1234', `Expected git sha, got ${info.gitSha}`);
  assert(info.imageDigest === 'sha256:abc', `Expected image digest, got ${info.imageDigest}`);
  assert(info.revision === 'titlework-analyzer-api-00042-xzy', `Expected revision, got ${info.revision}`);
}));

test('API and worker health responses include release metadata', async () => {
  await withEnv({
    RELEASE_VERSION: 'v2.3.1',
    GIT_SHA: 'def5678',
    IMAGE_DIGEST: 'sha256:def',
    K_REVISION: 'titlework-analyzer-worker-00042-xzy',
  }, async () => {
    const api = createServer();
    const worker = createWorkerHealthServer();
    await Promise.all([
      new Promise(resolve => api.listen(0, '127.0.0.1', resolve)),
      new Promise(resolve => worker.listen(0, '127.0.0.1', resolve)),
    ]);
    try {
      const apiHealth = await requestServer(api, '/api/healthz');
      const workerHealth = await requestServer(worker);
      assert(apiHealth.body.release.version === 'v2.3.1', 'Expected API release version in health response');
      assert(apiHealth.body.release.gitSha === 'def5678', 'Expected API git sha in health response');
      assert(workerHealth.body.release.imageDigest === 'sha256:def', 'Expected worker image digest in health response');
      assert(workerHealth.body.release.revision === 'titlework-analyzer-worker-00042-xzy', 'Expected worker revision in health response');
    } finally {
      await Promise.all([
        new Promise(resolve => api.close(resolve)),
        new Promise(resolve => worker.close(resolve)),
      ]);
    }
  });
});

test('release verification helpers enforce tag version, env, and image parity', () => {
  assert(validateTagVersion(releaseTag, packageVersion).valid === true, 'Expected lowercase tag to match package version');
  assert(validateTagVersion(releaseTag.toUpperCase(), packageVersion).valid === false, 'Expected uppercase release tag to be rejected');
  assert(validateTagVersion('v0.0.0', packageVersion).valid === false, 'Expected mismatched tag to be rejected');

  const service = {
    spec: {
      template: {
        spec: {
          containers: [{
            image: 'us-central1-docker.pkg.dev/p/titlework/app@sha256:abc',
            env: [
              { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'db' } } },
              { name: 'GCS_BUCKET', value: 'bucket' },
              { name: 'GEMINI_API_KEY', valueFrom: { secretKeyRef: { name: 'gemini' } } },
              { name: 'ANTHROPIC_API_KEY', valueFrom: { secretKeyRef: { name: 'anthropic' } } },
              { name: 'APP_PASSWORD', valueFrom: { secretKeyRef: { name: 'app-password' } } },
            ],
          }],
        },
      },
    },
    status: {
      latestReadyRevisionName: 'svc-00001-abc',
      imageDigest: 'us-central1-docker.pkg.dev/p/titlework/app@sha256:abc',
    },
  };

  assert(extractImageDigest(service) === 'sha256:abc', 'Expected digest extraction from Cloud Run service metadata');
  assert(extractEnvNames(service).has('DATABASE_URL'), 'Expected env name extraction from service template');
  assert(validateRequiredEnv(service).missing.length === 0, 'Expected required env validation to pass');
  const emptyPasswordService = structuredClone(service);
  emptyPasswordService.spec.template.spec.containers[0].env = [
    { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'db' } } },
    { name: 'GCS_BUCKET', value: 'bucket' },
    { name: 'GEMINI_API_KEY', valueFrom: { secretKeyRef: { name: 'gemini' } } },
    { name: 'ANTHROPIC_API_KEY', valueFrom: { secretKeyRef: { name: 'anthropic' } } },
    { name: 'APP_PASSWORD', value: '' },
  ];
  assert(validateRequiredEnv(emptyPasswordService).missing.includes('app password'), 'Expected empty APP_PASSWORD to fail required env validation');
  assert(compareServiceParity(
    { name: 'api', digest: 'sha256:abc', revision: 'api-00001' },
    { name: 'worker', digest: 'sha256:abc', revision: 'worker-00001' },
  ).valid === true, 'Expected matching service digests to pass parity validation');
  assert(compareServiceParity(
    { name: 'api', digest: 'sha256:abc', revision: 'api-00001' },
    { name: 'worker', digest: 'sha256:def', revision: 'worker-00001' },
  ).valid === false, 'Expected mismatched service digests to fail parity validation');
});

test('release verification requires API health metadata including revision', async () => {
  const goodHealth = {
    ok: true,
    release: {
      version: releaseTag,
      gitSha: 'abc123',
      imageDigest: 'sha256:abc',
      revision: 'api-00001',
    },
  };
  const expectedRelease = goodHealth.release;
  const response = body => ({
    ok: true,
    status: 200,
    async json() { return body; },
  });

  const missingUrl = await verifyHealth('', expectedRelease, async () => response(goodHealth));
  assert(missingUrl.valid === false, 'Expected health verification to fail without API URL');

  let requestedHealthUrl = '';
  const badRevision = await verifyHealth('https://api.example.test', expectedRelease, async url => {
    requestedHealthUrl = String(url);
    return response({
    ...goodHealth,
    release: { ...goodHealth.release, revision: 'api-00002' },
    });
  });
  assert(requestedHealthUrl === 'https://api.example.test/api/healthz', `Expected verifier to call /api/healthz, got ${requestedHealthUrl}`);
  assert(badRevision.valid === false, 'Expected mismatched health revision to fail verification');
});

test('verifyRelease checks Cloud Run parity, env configuration, and API health', async () => {
  const services = {
    api: {
      spec: {
        template: {
          spec: {
            containers: [{
              image: 'us-central1-docker.pkg.dev/p/titlework/app@sha256:abc',
              env: [
                { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'db' } } },
                { name: 'GCS_BUCKET', value: 'bucket' },
                { name: 'GEMINI_API_KEY', valueFrom: { secretKeyRef: { name: 'gemini' } } },
                { name: 'ANTHROPIC_API_KEY', valueFrom: { secretKeyRef: { name: 'anthropic' } } },
                { name: 'APP_PASSWORD', valueFrom: { secretKeyRef: { name: 'app-password' } } },
              ],
            }],
          },
        },
      },
      status: { latestReadyRevisionName: 'api-00001' },
    },
    worker: {
      spec: {
        template: {
          spec: {
            containers: [{
              image: 'us-central1-docker.pkg.dev/p/titlework/app@sha256:abc',
              env: [
                { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'db' } } },
                { name: 'GCS_BUCKET', value: 'bucket' },
                { name: 'GEMINI_API_KEY', valueFrom: { secretKeyRef: { name: 'gemini' } } },
                { name: 'ANTHROPIC_API_KEY', valueFrom: { secretKeyRef: { name: 'anthropic' } } },
                { name: 'APP_PASSWORD', valueFrom: { secretKeyRef: { name: 'app-password' } } },
              ],
            }],
          },
        },
      },
      status: { latestReadyRevisionName: 'worker-00001' },
    },
  };
  const revisions = {
    'api-00001': { status: { imageDigest: 'us-central1-docker.pkg.dev/p/titlework/app@sha256:abc' } },
    'worker-00001': { status: { imageDigest: 'us-central1-docker.pkg.dev/p/titlework/app@sha256:abc' } },
  };

  const result = await verifyRelease({
    project: 'project',
    region: 'us-central1',
    apiService: 'api',
    workerService: 'worker',
    tag: releaseTag,
    gitSha: 'abc123',
    expectedDigest: 'sha256:abc',
    apiUrl: 'https://api.example.test',
    packageVersion,
    describeService: async ({ service }) => services[service],
    describeRevision: async ({ revision }) => revisions[revision],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          release: {
            version: releaseTag,
            gitSha: 'abc123',
            imageDigest: 'sha256:abc',
            revision: 'api-00001',
          },
        };
      },
    }),
  });

  assert(result.api.revision === 'api-00001', 'Expected API revision in verification result');
  let failedOpen = false;
  try {
    await verifyRelease({
      project: 'project',
      region: 'us-central1',
      apiService: 'api',
      workerService: 'worker',
      tag: releaseTag,
      packageVersion,
      describeService: async ({ service }) => services[service],
      describeRevision: async ({ revision }) => revisions[revision],
      fetchImpl: async () => { throw new Error('fetch should not be skipped'); },
    });
  } catch {
    failedOpen = true;
  }
  assert(failedOpen, 'Expected verifyRelease to fail when API URL is missing');
});

test('release workflows and image context encode immutable Cloud Run deployment policy', () => {
  const testWorkflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
  assert(testWorkflow.includes('node-version: 22'), 'Expected CI to run tests on Node 22');
  assert(testWorkflow.includes('docker build'), 'Expected CI workflow to exercise Docker build');

  const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  assert(releaseWorkflow.includes("- 'v[0-9]*.[0-9]*.[0-9]*'"), 'Expected release trigger to avoid clearly malformed release tags');
  assert(!releaseWorkflow.includes('[0-9]+'), 'Expected semver validation in script, not an unsupported regex-like tag glob');
  assert(releaseWorkflow.includes('id-token: write'), 'Expected release workflow to use OIDC auth');
  assert(releaseWorkflow.includes('google-github-actions/auth'), 'Expected release workflow to authenticate to Google Cloud');
  assert(releaseWorkflow.includes('--image "${IMAGE_DIGEST_REF}"'), 'Expected Cloud Run deploys to use an immutable digest image');
  assert(releaseWorkflow.includes('--min-instances 0'), 'Expected worker deploy to scale to zero by default');
  assert(!releaseWorkflow.includes('--min-instances 1'), 'Expected worker deploy not to keep an always-on instance');
  assert(releaseWorkflow.includes('gh release'), 'Expected workflow to create or update GitHub Release');
  assert(releaseWorkflow.includes('--json tagName,isLatest'), 'Expected workflow to enforce that the GitHub Release is marked Latest');
  assert(releaseWorkflow.includes('verify-release.mjs'), 'Expected workflow to verify production before release creation');

  const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8');
  assert(dockerignore.includes('test/'), 'Expected tests to be excluded from production image context');
  assert(dockerignore.includes('docs/'), 'Expected docs to be excluded from production image context');
});

test('release documentation describes automated deploy, verification, and rollback', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert(readme.includes('Push a lowercase `vX.Y.Z` tag'), 'Expected README to document tag-triggered releases');
  assert(readme.includes('node -p "require'), 'Expected README release example to derive tag from package.json');
  assert(readme.includes('same immutable image digest'), 'Expected README to document API/worker digest parity');
  assert(readme.includes('Workload Identity Federation'), 'Expected README to document WIF setup');
  assert(readme.includes('APP_PASSWORD` | Yes for production'), 'Expected README production password policy to match release verification');
  assert(readme.includes('scale-to-zero'), 'Expected README to document worker scale-to-zero behavior');
  assert(readme.includes('Rollback API and worker together'), 'Expected README to document paired rollback');
  assert(readme.includes('GCS CORS'), 'Expected README to call out GCS CORS release verification');

  const security = readFileSync(join(root, 'SECURITY.md'), 'utf8');
  assert(security.includes('Cloud Run environment variables'), 'Expected SECURITY.md to describe Cloud Run secrets');
  assert(!security.includes('Vercel environment variables'), 'Expected SECURITY.md to remove stale Vercel secret guidance');
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
