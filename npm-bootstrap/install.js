#!/usr/bin/env node
'use strict';

/**
 * @parrotboy/trace — one-command installer bootstrap for Trace (Windows clipboard manager).
 *
 * What it does:
 *   1. Fetches `latest.yml` from the latest GitHub release (the same metadata file
 *      electron-updater uses — it carries the installer's SHA-512).
 *   2. Downloads the NSIS installer for the latest version.
 *   3. Verifies the downloaded file's SHA-512 against latest.yml.
 *   4. Runs the installer silently (`/S`). Trace is installed per-user, no admin needed.
 *
 * This package is a version-less "trampoline": it is published once and always
 * installs the newest Trace release, so it never needs a per-release update.
 *
 * Env overrides (mainly for testing / CI):
 *   TRACE_SKIP_INSTALL=1        — do nothing, exit 0
 *   TRACE_REPO=owner/repo       — different GitHub repo (default PaRr0tBoY/Trace)
 *   TRACE_BASE_URL=...          — replace https://github.com/<repo> (local test server)
 *   TRACE_SETUP_URL=...         — skip latest.yml, download this URL directly
 *   TRACE_SETUP_SHA512=...      — expected SHA-512 (base64) when TRACE_SETUP_URL is used
 *   TRACE_TEST_MODE=1           — download + verify only, do not run the installer
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// https for production, http allowed so TRACE_BASE_URL can point at a local
// test server (https.get rejects http:// outright).
const httpLib = (url) => (url.startsWith('https:') ? require('https') : require('http'));

const REPO = process.env.TRACE_REPO || 'PaRr0tBoY/Trace';
const BASE = process.env.TRACE_BASE_URL || `https://github.com/${REPO}`;
const MAX_REDIRECTS = 10;

function log(msg) {
  console.log(`[trace-install] ${msg}`);
}

function fail(msg) {
  console.error(`[trace-install] FAILED: ${msg}`);
  process.exit(1);
}

function httpsGet(url, redirectsLeft = MAX_REDIRECTS, toFile = null) {
  return new Promise((resolve, reject) => {
    const req = httpLib(url).get(url, { headers: { 'user-agent': 'npm:@parrotboy/trace' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error(`too many redirects for ${url}`));
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpsGet(next, redirectsLeft - 1, toFile));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      if (toFile) {
        const out = fs.createWriteStream(toFile);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(null)));
        out.on('error', reject);
      } else {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    });
    req.on('error', reject);
  });
}

function parseLatestYml(text) {
  const version = /^version:\s*(\S+)/m.exec(text);
  const filePath = /^path:\s*(\S+)/m.exec(text);
  const sha512 = /^sha512:\s*(\S+)/m.exec(text);
  if (!version || !filePath || !sha512) {
    throw new Error('latest.yml is missing version/path/sha512 fields');
  }
  return { version: version[1], path: filePath[1], sha512: sha512[1] };
}

function sha512Base64(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

async function main() {
  if (process.platform !== 'win32') {
    log(`Trace is Windows-only; nothing to install on ${process.platform}. Skipping.`);
    process.exit(0);
  }
  if (process.env.TRACE_SKIP_INSTALL === '1') {
    log('TRACE_SKIP_INSTALL=1 — skipping installation.');
    process.exit(0);
  }

  let setupUrl;
  let expectedSha512;
  let version;

  if (process.env.TRACE_SETUP_URL) {
    setupUrl = process.env.TRACE_SETUP_URL;
    expectedSha512 = process.env.TRACE_SETUP_SHA512;
    version = process.env.TRACE_SETUP_VERSION || 'unknown';
  } else {
    const latestUrl = `${BASE}/releases/latest/download/latest.yml`;
    log(`fetching ${latestUrl}`);
    const yml = await httpsGet(latestUrl);
    const parsed = parseLatestYml(yml.toString('utf8'));
    version = parsed.version;
    setupUrl = `${BASE}/releases/download/v${version}/${parsed.path}`;
    expectedSha512 = parsed.sha512;
  }

  const tmp = path.join(os.tmpdir(), `trace-setup-${version}-${process.pid}-${Date.now()}.exe`);
  log(`downloading Trace ${version} installer (${setupUrl})`);
  try {
    await httpsGet(setupUrl, MAX_REDIRECTS, tmp);
    const actual = sha512Base64(tmp);
    if (expectedSha512 && actual !== expectedSha512) {
      throw new Error(
        `SHA-512 mismatch for the downloaded installer\n  expected: ${expectedSha512}\n  actual:   ${actual}\n` +
          'Refusing to run a tampered installer. This is the file you downloaded:\n  ' +
          tmp
      );
    }
    log(`SHA-512 verified (${actual.slice(0, 27)}…)`);

    if (process.env.TRACE_TEST_MODE === '1') {
      log('TRACE_TEST_MODE=1 — verification only, not running the installer.');
    } else {
      log('running installer silently (/S)…');
      const result = spawnSync(tmp, ['/S'], { stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`installer exited with code ${result.status}`);
      }
      log(`Trace ${version} installed. It will appear on the left screen edge.`);
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
  }
}

main().catch((err) => fail(err.message));
