#!/usr/bin/env node
import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');

export const REQUIRED_ENV_GROUPS = [
  { label: 'database URL', names: ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'] },
  { label: 'GCS bucket', names: ['GCS_BUCKET', 'GOOGLE_CLOUD_STORAGE_BUCKET', 'STORAGE_BUCKET'] },
  { label: 'Anthropic API key', names: ['ANTHROPIC_API_KEY'] },
  { label: 'app password', names: ['APP_PASSWORD'] },
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function readPackageVersion() {
  return JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')).version;
}

function digestFromString(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/sha256:[A-Za-z0-9._-]+/);
  return match ? match[0] : null;
}

function firstContainer(service) {
  return service?.spec?.template?.spec?.containers?.[0]
    || service?.template?.spec?.containers?.[0]
    || service?.containers?.[0]
    || {};
}

export function extractImageDigest(serviceOrRevision) {
  return digestFromString(serviceOrRevision?.status?.imageDigest)
    || digestFromString(serviceOrRevision?.status?.containerStatuses?.[0]?.imageDigest)
    || digestFromString(firstContainer(serviceOrRevision).image)
    || digestFromString(serviceOrRevision?.image);
}

export function extractEnvNames(service) {
  return new Set((firstContainer(service).env || [])
    .map(entry => entry?.name)
    .filter(Boolean));
}

function envEntryIsConfigured(entry) {
  if (!entry?.name) return false;
  if (entry.valueFrom) return true;
  if (!Object.hasOwn(entry, 'value')) return true;
  return typeof entry.value === 'string' && entry.value.trim().length > 0;
}

export function validateRequiredEnv(service) {
  const envEntries = firstContainer(service).env || [];
  const missing = REQUIRED_ENV_GROUPS
    .filter(group => !group.names.some(name => envEntryIsConfigured(envEntries.find(entry => entry?.name === name))))
    .map(group => group.label);
  return { valid: missing.length === 0, missing };
}

export function compareServiceParity(api, worker) {
  const errors = [];
  if (!api.digest) errors.push(`${api.name || 'api'} is missing an image digest`);
  if (!worker.digest) errors.push(`${worker.name || 'worker'} is missing an image digest`);
  if (api.digest && worker.digest && api.digest !== worker.digest) {
    errors.push(`API digest ${api.digest} does not match worker digest ${worker.digest}`);
  }
  return { valid: errors.length === 0, errors };
}

export function validateTagVersion(tag, packageVersion) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) {
    return { valid: false, error: `Release tags must use lowercase semver, for example v${packageVersion}.` };
  }
  const tagVersion = tag.slice(1);
  if (tagVersion !== packageVersion) {
    return { valid: false, error: `Tag ${tag} does not match package.json version ${packageVersion}.` };
  }
  return { valid: true, version: tagVersion };
}

async function gcloudJson(args) {
  const { stdout } = await execFileAsync('gcloud', [...args, '--format=json'], { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function describeService({ project, region, service }) {
  return await gcloudJson(['run', 'services', 'describe', service, '--project', project, '--region', region]);
}

async function describeRevision({ project, region, revision }) {
  return await gcloudJson(['run', 'revisions', 'describe', revision, '--project', project, '--region', region]);
}

async function collectServiceFacts({ project, region, service, name }) {
  const serviceJson = await describeService({ project, region, service });
  const revisionName = serviceJson?.status?.latestReadyRevisionName || serviceJson?.status?.latestCreatedRevisionName;
  const revisionJson = revisionName ? await describeRevision({ project, region, revision: revisionName }) : null;
  return {
    name,
    service,
    revision: revisionName || null,
    digest: extractImageDigest(revisionJson) || extractImageDigest(serviceJson),
    env: validateRequiredEnv(serviceJson),
  };
}

async function verifyHealth(url, expected, fetchImpl = globalThis.fetch) {
  if (!url || !fetchImpl) return { skipped: true };
  const response = await fetchImpl(new URL('/healthz', url));
  if (!response.ok) return { valid: false, error: `${url}/healthz returned ${response.status}` };
  const body = await response.json();
  const release = body.release || {};
  const errors = [];
  if (expected.version && release.version !== expected.version) errors.push(`health version ${release.version} did not match ${expected.version}`);
  if (expected.gitSha && release.gitSha !== expected.gitSha) errors.push(`health gitSha ${release.gitSha} did not match ${expected.gitSha}`);
  if (expected.imageDigest && release.imageDigest !== expected.imageDigest) errors.push(`health imageDigest ${release.imageDigest} did not match ${expected.imageDigest}`);
  return { valid: errors.length === 0, errors, body };
}

export async function verifyRelease(options) {
  const packageVersion = options.packageVersion || readPackageVersion();
  const tagCheck = validateTagVersion(options.tag, packageVersion);
  if (!tagCheck.valid) throw new Error(tagCheck.error);

  const api = await collectServiceFacts({
    project: options.project,
    region: options.region,
    service: options.apiService,
    name: 'api',
  });
  const worker = await collectServiceFacts({
    project: options.project,
    region: options.region,
    service: options.workerService,
    name: 'worker',
  });

  const errors = [];
  for (const service of [api, worker]) {
    if (!service.env.valid) errors.push(`${service.name} is missing required env: ${service.env.missing.join(', ')}`);
  }
  const parity = compareServiceParity(api, worker);
  errors.push(...parity.errors);
  if (options.expectedDigest && api.digest !== options.expectedDigest) {
    errors.push(`Deployed digest ${api.digest} did not match expected ${options.expectedDigest}`);
  }

  if (options.apiUrl) {
    const health = await verifyHealth(options.apiUrl, {
      version: options.tag,
      gitSha: options.gitSha,
      imageDigest: api.digest,
    });
    if (health.valid === false) errors.push(...(health.errors || [health.error]));
  }

  if (errors.length) {
    throw new Error(errors.join('\n'));
  }
  return { api, worker };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = {
    project: args.project || process.env.GCP_PROJECT_ID,
    region: args.region || process.env.GCP_REGION,
    apiService: args['api-service'] || process.env.API_SERVICE,
    workerService: args['worker-service'] || process.env.WORKER_SERVICE,
    tag: args.tag || process.env.RELEASE_VERSION || process.env.GITHUB_REF_NAME,
    gitSha: args.sha || process.env.GITHUB_SHA,
    expectedDigest: args['expected-digest'] || process.env.IMAGE_DIGEST,
    apiUrl: args['api-url'] || process.env.API_URL,
  };
  for (const [key, value] of Object.entries(options)) {
    if (['gitSha', 'expectedDigest', 'apiUrl'].includes(key)) continue;
    if (!value) throw new Error(`Missing required option: ${key}`);
  }
  const result = await verifyRelease(options);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.message || String(err));
    process.exit(1);
  });
}
