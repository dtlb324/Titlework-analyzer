#!/usr/bin/env node
// Usage: docker buildx imagetools inspect REF --raw | node scripts/resolve-image-digest.mjs PUSHED_DIGEST
// Prints the digest Cloud Run reports for the deployed image.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requireDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} is not a sha256 digest: ${JSON.stringify(value)}`);
  }
  return value;
}

export function resolvePlatformDigest(manifest, pushedDigest, platform = { os: 'linux', architecture: 'amd64' }) {
  requireDigest(pushedDigest, 'Pushed digest');
  if (!Array.isArray(manifest?.manifests)) return pushedDigest;

  const matches = manifest.manifests.filter(entry => (
    entry?.platform?.os === platform.os
    && entry?.platform?.architecture === platform.architecture
    && !entry?.annotations?.['vnd.docker.reference.type']
  ));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${platform.os}/${platform.architecture} image in ${pushedDigest}, found ${matches.length}`);
  }
  return requireDigest(matches[0].digest, `${platform.os}/${platform.architecture} digest`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const manifest = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(`${resolvePlatformDigest(manifest, process.argv[2])}\n`);
  } catch (err) {
    console.error(`resolve-image-digest: ${err.message}`);
    process.exit(1);
  }
}
