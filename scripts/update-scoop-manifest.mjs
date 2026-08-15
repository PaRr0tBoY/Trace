#!/usr/bin/env node
/**
 * Updates the scoop manifests (bucket/trace.json + distrib/scoop/trace.json)
 * for a new GitHub release.
 *
 * Usage (in CI): runs with GITHUB_REF=refs/tags/vX.Y.Z and
 * GITHUB_REPOSITORY=owner/repo; or locally: `node scripts/update-scoop-manifest.mjs <version>`
 *
 * The SHA-256 comes from the `Trace-Setup-<version>.exe.sha256` release asset
 * (uploaded by the release workflow).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ref = process.env.GITHUB_REF || '';
const tag = process.argv[2] ? `v${process.argv[2]}` : ref.replace(/^refs\/tags\//, '');
if (!tag || !/^v\d/.test(tag)) throw new Error(`expected a v* tag, got "${tag}"`);
const ver = tag.replace(/^v/, '');
const repo = process.env.GITHUB_REPOSITORY || 'PaRr0tBoY/Trace';

const shaUrl = `https://github.com/${repo}/releases/download/${tag}/Trace-Setup-${ver}.exe.sha256`;
const res = await fetch(shaUrl);
if (!res.ok) throw new Error(`fetch ${shaUrl} -> HTTP ${res.status}`);
const sha256 = (await res.text()).trim().toLowerCase();
if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`unexpected sha256 payload: ${sha256}`);

const files = ['bucket/trace.json', 'distrib/scoop/trace.json'];
for (const f of files) {
  let text = readFileSync(f, 'utf8');
  text = text.replace(/"version":\s*"[^"]+"/, `"version": "${ver}"`);
  text = text.replace(/Trace-Setup-[\d.]+\.exe/g, `Trace-Setup-${ver}.exe`);
  text = text.replace(/"hash":\s*"[0-9a-f]{64}"/, `"hash": "${sha256}"`);
  writeFileSync(f, text);
  console.log(`updated ${f} -> ${ver} (sha256 ${sha256.slice(0, 12)}…)`);
}
