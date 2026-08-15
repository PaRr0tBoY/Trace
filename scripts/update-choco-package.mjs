#!/usr/bin/env node
/**
 * Updates the chocolatey package (distrib/chocolatey) for a new GitHub release:
 *   - Trace.nuspec                    -> <version> bump
 *   - tools/chocolateyinstall.ps1     -> installer URL + SHA-256 checksum
 *
 * Usage (in CI): runs with GITHUB_REF=refs/tags/vX.Y.Z and
 * GITHUB_REPOSITORY=owner/repo; or locally: `node scripts/update-choco-package.mjs <version>`
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
const sha256 = (await res.text()).trim().toUpperCase();
if (!/^[0-9A-F]{64}$/.test(sha256)) throw new Error(`unexpected sha256 payload: ${sha256}`);

const nuspec = 'distrib/chocolatey/Trace.nuspec';
let n = readFileSync(nuspec, 'utf8');
n = n.replace(/(<version>)[^<]+(<\/version>)/, `$1${ver}$2`);
writeFileSync(nuspec, n);

const ps1 = 'distrib/chocolatey/tools/chocolateyinstall.ps1';
let p = readFileSync(ps1, 'utf8');
p = p.replace(/v[\d.]+(?=\/Trace-Setup-[\d.]+\.exe)/, tag);
p = p.replace(/(\$checksum\s*=\s*')[0-9A-Fa-f]+(')/, `$1${sha256}$2`);
writeFileSync(ps1, p);

console.log(`chocolatey package -> ${ver} (sha256 ${sha256.slice(0, 12)}…)`);
