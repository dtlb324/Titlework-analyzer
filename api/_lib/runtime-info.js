import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..', '..');

let cachedPackageVersion = null;

function getPackageVersion() {
  if (cachedPackageVersion) return cachedPackageVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
    cachedPackageVersion = pkg.version || null;
  } catch {
    cachedPackageVersion = null;
  }
  return cachedPackageVersion;
}

function normalize(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getRuntimeInfo(env = process.env) {
  const packageVersion = getPackageVersion();
  return {
    version: normalize(env.RELEASE_VERSION) || (packageVersion ? `v${packageVersion}` : null),
    packageVersion,
    gitSha: normalize(env.GIT_SHA) || normalize(env.COMMIT_SHA) || null,
    imageDigest: normalize(env.IMAGE_DIGEST) || null,
    revision: normalize(env.K_REVISION) || normalize(env.CLOUD_RUN_REVISION) || null,
  };
}
