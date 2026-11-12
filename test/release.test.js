import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { request } from 'http';
import { tmpdir } from 'os';
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
import { resolvePlatformDigest } from '../scripts/resolve-image-digest.mjs';

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

test('verification launch strips inherited provider credential aliases by default', () => {
  const harness = readFileSync(join(root, '.cursor/skills/verify-titlework/verify.mjs'), 'utf8');
  const declaration = harness.match(/const STRIP_ENV = (\[[\s\S]*?\]);/);
  assert(declaration, 'Expected an explicit verification environment boundary');
  const keys = JSON.parse(declaration[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  const credentials = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'];
  const inherited = Object.fromEntries([...credentials, 'PATH'].map(key => [key, `synthetic-${key}`]));
  for (const key of keys) delete inherited[key];
  for (const key of credentials) assert(!(key in inherited), `Verification launch retained ${key}`);
  assert(inherited.PATH === 'synthetic-PATH', 'Expected unrelated environment values to survive');
  assert(harness.includes("const isolated = !flags['keep-env'];") && harness.includes('for (const key of STRIP_ENV) delete env[key];'), 'Expected default launch to apply the boundary and keep-env to opt out');
});

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

test('API and worker health responses include version without deploy identity', async () => {
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
      assert(apiHealth.body.release.gitSha == null, 'Public health must not leak gitSha');
      assert(apiHealth.body.release.imageDigest == null, 'Public health must not leak imageDigest');
      assert(workerHealth.body.release.version === 'v2.3.1', 'Expected worker version in health response');
      assert(workerHealth.body.release.imageDigest == null, 'Worker health must not leak imageDigest');
      assert(workerHealth.body.release.revision == null, 'Worker health must not leak revision');
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

test('release verification requires API health version', async () => {
  const goodHealth = {
    ok: true,
    release: {
      version: releaseTag,
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
  const badVersion = await verifyHealth('https://api.example.test', expectedRelease, async url => {
    requestedHealthUrl = String(url);
    return response({
    ...goodHealth,
    release: { version: 'v0.0.0' },
    });
  });
  assert(requestedHealthUrl === 'https://api.example.test/api/healthz', `Expected verifier to call /api/healthz, got ${requestedHealthUrl}`);
  assert(badVersion.valid === false, 'Expected mismatched health version to fail verification');
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
  const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const testNode = workflowNodeVersion(testWorkflow, '.github/workflows/test.yml');
  const releaseNode = workflowNodeVersion(releaseWorkflow, '.github/workflows/release.yml');
  const imageNode = dockerfileNodeVersion(dockerfile);
  const packageEngines = packageJson?.engines?.node;
  const lockEngines = packageLock?.packages?.['']?.engines?.node;
  assert(releaseNode === testNode, `Expected release.yml node-version ${releaseNode} to equal test.yml node-version ${testNode}`);
  assert(imageNode === testNode, `Expected Dockerfile Node version ${imageNode} to equal workflow node-version ${testNode}`);
  assert(enginesMajor(packageEngines) === versionMajor(testNode), `Expected package.json engines.node major ${packageEngines} to equal Node version major ${testNode}`);
  assert(lockEngines === packageEngines, `Expected package-lock.json engines.node ${lockEngines} to equal package.json engines.node ${packageEngines}`);
  assert(testWorkflow.includes('docker build'), 'Expected CI workflow to exercise Docker build');

  assert(releaseWorkflow.includes("- 'v[0-9]*.[0-9]*.[0-9]*'"), 'Expected release trigger to avoid clearly malformed release tags');
  assert(!releaseWorkflow.includes('[0-9]+'), 'Expected semver validation in script, not an unsupported regex-like tag glob');
  assert(releaseWorkflow.includes('id-token: write'), 'Expected release workflow to use OIDC auth');
  assert(releaseWorkflow.includes('google-github-actions/auth'), 'Expected release workflow to authenticate to Google Cloud');
  assert(releaseWorkflow.includes('--image "${IMAGE_DIGEST_REF}"'), 'Expected Cloud Run deploys to use an immutable digest image');
  assert(releaseWorkflow.includes('--min-instances 0'), 'Expected worker deploy to scale to zero by default');
  assert(!releaseWorkflow.includes('--min-instances 1'), 'Expected worker deploy not to keep an always-on instance');
  assert(releaseWorkflow.includes('WORKER_DISABLED=true'), 'Expected worker service loop to be disabled by default');
  assert(releaseWorkflow.includes('SYNTHESIS_CONCURRENCY=8'), 'Expected Phase 0 synthesis concurrency on API deploy');
  assert(releaseWorkflow.includes('SYNTHESIS_BATCH_LIMIT=8'), 'Expected Phase 1 synthesis batch limit on API deploy');
  assert(releaseWorkflow.includes('SYNTHESIS_STREAM_ENABLED=true'), 'Expected Phase 2 synthesis streaming on API deploy');
  assert(releaseWorkflow.includes('SYNTHESIS_COMPACTION_ENABLED=true'), 'Expected Phase 3 synthesis compaction on API deploy');
  assert(releaseWorkflow.includes('SYNTHESIS_LARGE_JOB_MULTI_SEGMENT=true'), 'Expected large jobs to use parallel synthesis on API deploy');
  assert(releaseWorkflow.includes('BULK_JOB_MIN_ABSTRACTS=50'), 'Expected 50-doc parallel synthesis threshold on API deploy');
  assert(releaseWorkflow.includes('SYNTHESIS_CHUNK_SIZE=50'), 'Expected 50-doc synthesis chunk cap on API deploy');
  assert(releaseWorkflow.includes('BULK_SYNTHESIS_CHUNK_SIZE=50'), 'Expected bulk synthesis chunk cap to match parallel chunk cap');
  assert(releaseWorkflow.includes('ABSTRACTION_ESCALATION_ENABLED=false'), 'Expected Phase 0 abstraction escalation off on API deploy');
  assert(releaseWorkflow.includes('gh release'), 'Expected workflow to create or update GitHub Release');
  assert(releaseWorkflow.includes('GH_REPO: ${{ github.repository }}'), 'Expected github-release job to set GH_REPO without a checkout');
  assert(releaseWorkflow.includes('--json tagName,isLatest'), 'Expected workflow to enforce that the GitHub Release is marked Latest');
  assert(releaseWorkflow.includes('verify-release.mjs'), 'Expected workflow to verify production before release creation');

  const secretScan = readFileSync(join(root, '.github/workflows/secret-scan.yml'), 'utf8');
  assert(secretScan.includes('persist-credentials: false'), 'Expected secret scan checkout to drop credentials');
  assert(secretScan.includes('origin/${DEFAULT_BRANCH}'), 'Expected a missing before SHA to scan from the default branch');
  assert(secretScan.includes('0000000000000000000000000000000000000000'), 'Expected the all-zero before SHA to be treated as unusable');

  const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8');
  assert(dockerignore.includes('test/'), 'Expected tests to be excluded from production image context');
  assert(dockerignore.includes('docs/'), 'Expected docs to be excluded from production image context');
});

function workflowNodeVersion(workflow, label) {
  const found = [];
  for (const line of workflow.split('\n')) {
    const match = line.match(/^\s*node-version:\s*(.+?)\s*$/);
    if (match) found.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  assert(found.length === 1, `Expected one node-version in ${label}, found ${found.length}`);
  return found[0];
}

function dockerfileNodeVersion(dockerfile) {
  const froms = dockerfile.split('\n').map(line => line.trim()).filter(line => line.startsWith('FROM '));
  assert(froms.length === 1, `Expected one FROM in Dockerfile, found ${froms.length}`);
  const ref = froms[0].slice('FROM '.length).split(/\s+/)[0].split('@')[0];
  const match = ref.match(/^node:([^-]+)-.+$/);
  assert(match, `Expected Dockerfile FROM node:<version>-..., got ${froms[0]}`);
  return match[1];
}

function versionMajor(version) {
  const match = /^(\d+)\./.exec(version);
  assert(match, `Expected a MAJOR.MINOR.PATCH Node version, got ${version}`);
  return match[1];
}

function enginesMajor(engines) {
  const match = /^(\d+)\.x$/.exec(engines);
  assert(match, `Expected package.json engines.node like 26.x, got ${engines}`);
  return match[1];
}

function workflowRunScript(workflow, jobName) {
  const lines = workflow.split('\n');
  const jobAt = lines.findIndex(line => line === `  ${jobName}:`);
  assert(jobAt >= 0, `Expected job ${jobName}`);
  let runAt = -1;
  for (let i = jobAt + 1; i < lines.length; i++) {
    if (/^  [^ \n]/.test(lines[i])) break;
    if (lines[i].trim() === 'run: |') runAt = i;
  }
  assert(runAt >= 0, `Expected run script in ${jobName}`);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent < 10) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

test('github-release script dry-runs outside a checkout when GH_REPO is set', () => {
  const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const script = workflowRunScript(releaseWorkflow, 'github-release');
  assert(script.includes('gh release view'), 'Expected to dry-run the github-release script');
  const job = releaseWorkflow.slice(releaseWorkflow.indexOf('  github-release:'));
  assert(!job.includes('actions/checkout'), 'Expected github-release job to keep working without a checkout');

  const dir = mkdtempSync(join(tmpdir(), 'github-release-'));
  const bin = join(dir, 'bin');
  const stubPath = join(bin, 'gh');
  mkdirSync(bin);
  writeFileSync(stubPath, `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
if [[ -z "\${GH_REPO:-}" ]]; then
  echo "missing GH_REPO" >&2
  exit 1
fi
if [[ "$1 $2" == "release view" ]]; then
  if [[ "\${GH_STUB_EXISTS:-}" == "1" ]]; then exit 0; fi
  exit 1
fi
if [[ "$1 $2" == "release list" && "$*" == *"--jq"* ]]; then
  printf '%s\\n' "\${GH_STUB_LATEST:-true}"
  exit 0
fi
exit 0
`);
  chmodSync(stubPath, 0o755);
  const scriptPath = join(dir, 'release.sh');
  writeFileSync(scriptPath, script);
  const work = join(dir, 'empty');
  mkdirSync(work);

  function runRelease({ ghRepo, exists, latest }) {
    const logPath = join(dir, `calls-${exists}-${latest}-${ghRepo ? 'repo' : 'norepo'}.txt`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_STUB_LOG: logPath, GH_STUB_EXISTS: exists, GH_STUB_LATEST: latest, GITHUB_REF_NAME: 'v9.9.9', GITHUB_SHA: 'abc123', GH_TOKEN: 'stub-token' };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GH_REPO;
    delete env.GITHUB_REPOSITORY;
    if (ghRepo) env.GH_REPO = 'example/repo';
    const result = spawnSync('bash', [scriptPath], { cwd: work, env, encoding: 'utf8' });
    const calls = readFileSync(logPath, 'utf8');
    return { status: result.status, calls, stderr: result.stderr };
  }

  const created = runRelease({ ghRepo: true, exists: '0', latest: 'true' });
  assert(created.status === 0, `Expected create path to pass, stderr=${created.stderr}`);
  assert(created.calls.includes('release create'), 'Expected a missing release to call gh release create');
  assert(created.calls.includes('--target'), 'Expected create to target the tag commit');

  const edited = runRelease({ ghRepo: true, exists: '1', latest: 'true' });
  assert(edited.status === 0, `Expected edit path to pass, stderr=${edited.stderr}`);
  assert(edited.calls.includes('release edit'), 'Expected an existing release to call gh release edit');
  assert(!edited.calls.includes('release create'), 'Expected edit path not to create a release');

  const notLatest = runRelease({ ghRepo: true, exists: '1', latest: 'false' });
  assert(notLatest.status !== 0, 'Expected the script to fail when the release is not Latest');

  const missingRepo = runRelease({ ghRepo: false, exists: '0', latest: 'true' });
  assert(missingRepo.status !== 0, 'Expected gh release to fail outside a checkout when GH_REPO is unset');

  rmSync(dir, { recursive: true, force: true });
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

// Shape of the v2.6.18 push: an OCI index holding the linux/amd64 image and a BuildKit attestation.
const PUSHED_INDEX_DIGEST = 'sha256:93a632344c6146f7a359149422db09ab82e4eb59ba440e2510e7c29226ed1677';
const AMD64_DIGEST = 'sha256:52b1857ef04e4781c9313e3ee5a928011f28114a8ccabdac65c4283fad7c1970';
const ATTESTATION_DIGEST = 'sha256:90d85c8e2761bc6a2f6ae5d829779202179af48f63591480327b3a73e2ef97ee';
const ociIndex = (manifests) => ({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests });
const amd64Entry = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: AMD64_DIGEST, platform: { architecture: 'amd64', os: 'linux' } };
const attestationEntry = {
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  digest: ATTESTATION_DIGEST,
  platform: { architecture: 'unknown', os: 'unknown' },
  annotations: { 'vnd.docker.reference.digest': AMD64_DIGEST, 'vnd.docker.reference.type': 'attestation-manifest' },
};

test('image index with an attestation resolves to the linux/amd64 digest Cloud Run reports', () => {
  const digest = resolvePlatformDigest(ociIndex([amd64Entry, attestationEntry]), PUSHED_INDEX_DIGEST);
  assert(digest === AMD64_DIGEST, `Expected ${AMD64_DIGEST}, got ${digest}`);
});

test('attestation listed first is still skipped', () => {
  const digest = resolvePlatformDigest(ociIndex([attestationEntry, amd64Entry]), PUSHED_INDEX_DIGEST);
  assert(digest === AMD64_DIGEST, `Expected ${AMD64_DIGEST}, got ${digest}`);
});

test('Docker manifest list resolves the same way as an OCI index', () => {
  const list = { schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json', manifests: [amd64Entry] };
  assert(resolvePlatformDigest(list, PUSHED_INDEX_DIGEST) === AMD64_DIGEST, 'Expected the amd64 entry of a manifest list');
});

test('single-platform manifest keeps the pushed digest', () => {
  const manifest = { schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', config: {}, layers: [] };
  assert(resolvePlatformDigest(manifest, PUSHED_INDEX_DIGEST) === PUSHED_INDEX_DIGEST, 'Expected a plain manifest to keep its own digest');
});

test('index without exactly one linux/amd64 image is refused', () => {
  const arm = { ...amd64Entry, digest: 'sha256:' + 'a'.repeat(64), platform: { architecture: 'arm64', os: 'linux' } };
  for (const [label, manifests] of [['no amd64', [arm, attestationEntry]], ['two amd64', [amd64Entry, { ...amd64Entry, digest: 'sha256:' + 'b'.repeat(64) }]], ['empty', []]]) {
    let threw = false;
    try { resolvePlatformDigest(ociIndex(manifests), PUSHED_INDEX_DIGEST); } catch { threw = true; }
    assert(threw, `Expected ${label} index to throw`);
  }
});

test('malformed pushed digest or child digest is refused', () => {
  let threw = false;
  try { resolvePlatformDigest(ociIndex([amd64Entry]), 'latest'); } catch { threw = true; }
  assert(threw, 'Expected a non-sha256 pushed digest to throw');
  threw = false;
  try { resolvePlatformDigest(ociIndex([{ ...amd64Entry, digest: 'sha256:short' }]), PUSHED_INDEX_DIGEST); } catch { threw = true; }
  assert(threw, 'Expected a malformed child digest to throw');
});

test('resolver CLI reads the raw manifest on stdin and prints the deploy digest', () => {
  const run = spawnSync(process.execPath, [join(root, 'scripts/resolve-image-digest.mjs'), PUSHED_INDEX_DIGEST], {
    input: JSON.stringify(ociIndex([attestationEntry, amd64Entry])),
    encoding: 'utf8',
  });
  assert(run.status === 0, `Expected exit 0, got ${run.status}: ${run.stderr}`);
  assert(run.stdout.trim() === AMD64_DIGEST, `Expected stdout ${AMD64_DIGEST}, got ${run.stdout}`);
  const bad = spawnSync(process.execPath, [join(root, 'scripts/resolve-image-digest.mjs'), PUSHED_INDEX_DIGEST], { input: '{not json', encoding: 'utf8' });
  assert(bad.status !== 0 && bad.stdout === '', 'Expected invalid JSON to exit non-zero with no digest on stdout');
});

test('release workflow deploys and verifies the resolved platform digest', () => {
  const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  assert(releaseWorkflow.includes('--raw'), 'Expected the build step to read the raw pushed manifest');
  assert(releaseWorkflow.includes('scripts/resolve-image-digest.mjs'), 'Expected the build step to resolve the platform digest');
  const setupNode = releaseWorkflow.indexOf('actions/setup-node');
  const resolve = releaseWorkflow.indexOf('scripts/resolve-image-digest.mjs');
  assert(setupNode !== -1 && setupNode < resolve, 'Expected Node to be set up before the resolver runs');
  assert(releaseWorkflow.includes('[[ "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]'), 'Expected the build step to reject an empty or malformed resolved digest');
  assert(releaseWorkflow.includes('echo "image-digest=${DIGEST}"'), 'Expected the image-digest output to carry the resolved platform digest');
  assert(!/image-digest(-ref)?=\$\{PUSHED_DIGEST\}/.test(releaseWorkflow), 'Expected the pushed index digest never to become a deploy output');
  assert(releaseWorkflow.includes('IMAGE_DIGEST: ${{ steps.image.outputs.image-digest }}'), 'Expected deploy and verify steps to read the resolved digest output');
  assert(releaseWorkflow.includes('--expected-digest "${IMAGE_DIGEST}"'), 'Expected verification to compare against the resolved digest');
});

test('release workflow publishes without Cloud Run unless deployment is opted in', () => {
  const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  assert(releaseWorkflow.includes('DEPLOY_TO_CLOUD_RUN: ${{ vars.DEPLOY_TO_CLOUD_RUN }}'), 'Expected deployment to be driven by the DEPLOY_TO_CLOUD_RUN repository variable');
  const gate = "        if: env.DEPLOY_TO_CLOUD_RUN == 'true'";
  const cloudSteps = [
    'Authenticate to Google Cloud',
    'Set up Google Cloud SDK',
    'Configure Artifact Registry Docker auth',
    'Build and push release image',
    'Deploy worker from immutable image',
    'Deploy API from immutable image',
    'Verify production release',
  ];
  for (const step of cloudSteps) {
    const at = releaseWorkflow.indexOf(`      - name: ${step}\n`);
    assert(at !== -1, `Expected step ${step}`);
    const next = releaseWorkflow.indexOf('\n', at + 1);
    assert(releaseWorkflow.slice(next + 1).startsWith(gate), `Expected ${step} to run only when DEPLOY_TO_CLOUD_RUN is true`);
  }
  for (const step of ['Validate release tag', 'Run tests']) {
    const at = releaseWorkflow.indexOf(`      - name: ${step}\n`);
    const next = releaseWorkflow.indexOf('\n', at + 1);
    assert(at !== -1 && !releaseWorkflow.slice(next + 1).startsWith('        if:'), `Expected ${step} to run on every release tag`);
  }
  const testsAt = releaseWorkflow.indexOf('      - name: Run tests\n');
  const authAt = releaseWorkflow.indexOf('      - name: Authenticate to Google Cloud\n');
  assert(testsAt < authAt, 'Expected tests to run before any Cloud Run step');
  const publishJob = releaseWorkflow.slice(releaseWorkflow.indexOf('  github-release:'));
  assert(publishJob.includes('needs: release') && !publishJob.includes('  if:'), 'Expected the GitHub Release to depend on the release job succeeding, with or without deployment');
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
