// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Zero-dependency static file server for the demo and the browser tests.
//
//   node scripts/serve.js [--port 8080] [--host 127.0.0.1] [--root <dir>]
//
// It is also a module: `startServer({ root, host, port })` resolves with
// `{ url, port, host, root, close() }` (used in-process by test-browser.js).
//
// Rules (DESIGN §11.2):
// - root = the package root by default (resolved from this file, not the CWD);
// - host = 127.0.0.1 by default, never 0.0.0.0 unless asked for;
// - port 8080, then 8081–8099 when busy; port 0 = ephemeral;
// - GET and HEAD only (405 otherwise), 404 for unknown paths;
// - path traversal is rejected (the resolved real path must stay inside root);
// - '/' redirects to '/example/', a directory serves its index.html;
// - every response carries Cache-Control: no-store;
// - it never opens a browser.
// Ports 8722 and 9333 belong to the OpenMix desktop app: never bound here.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root: the parent of this scripts/ folder. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Default port, and the range tried when it is busy. */
export const DEFAULT_PORT = 8080;
const FALLBACK_LAST_PORT = 8099;

/** Ports used by the OpenMix desktop app: refused, even when asked for. */
export const RESERVED_PORTS = Object.freeze([8722, 9333]);

/** Content types by file extension (lower case). */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm'
});

/**
 * Content type for a file path.
 * @param {string} filePath
 * @returns {string}
 */
export function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const BASE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
});

/** True when `child` is `parent` itself or lies inside it. */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== '..';
}

function sendText(res, status, text, extraHeaders = {}, headOnly = false) {
  const body = Buffer.from(`${text}\n`, 'utf8');
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...extraHeaders
  });
  res.end(headOnly ? undefined : body);
}

function redirect(res, location, headOnly) {
  sendText(res, 302, `Found: ${location}`, { Location: location }, headOnly);
}

/**
 * Creates the request handler for a root directory (already resolved to its
 * real path).
 * @param {string} realRoot
 */
function createHandler(realRoot) {
  return async (req, res) => {
    const method = req.method || 'GET';
    const headOnly = method === 'HEAD';
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      return;
    }
    let url;
    let pathname;
    try {
      // The WHATWG parser resolves '.' and '..' segments (also when encoded as
      // %2e) and turns '\' into '/'. Encoded slashes (%2f, %5c) survive it and
      // are caught by the containment check below.
      url = new URL(req.url || '/', 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendText(res, 400, 'Bad Request', {}, headOnly);
      return;
    }
    if (pathname.includes('\0')) {
      sendText(res, 400, 'Bad Request', {}, headOnly);
      return;
    }
    if (pathname === '/') {
      redirect(res, `/example/${url.search}`, headOnly);
      return;
    }
    const target = path.resolve(realRoot, `.${path.sep}${pathname.replace(/^[/\\]+/, '')}`);
    if (!isInside(realRoot, target)) {
      sendText(res, 403, 'Forbidden', {}, headOnly);
      return;
    }
    let real;
    let stat;
    try {
      real = await fsp.realpath(target);
      // A symbolic link must not lead outside the root either
      if (!isInside(realRoot, real)) {
        sendText(res, 403, 'Forbidden', {}, headOnly);
        return;
      }
      stat = await fsp.stat(real);
    } catch {
      sendText(res, 404, 'Not Found', {}, headOnly);
      return;
    }
    if (stat.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        // Relative imports inside the page need the trailing slash
        redirect(res, `${url.pathname}/${url.search}`, headOnly);
        return;
      }
      real = path.join(real, 'index.html');
      try {
        stat = await fsp.stat(real);
      } catch {
        sendText(res, 404, 'Not Found', {}, headOnly);
        return;
      }
    }
    if (!stat.isFile()) {
      sendText(res, 404, 'Not Found', {}, headOnly);
      return;
    }
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': contentTypeFor(real),
      'Content-Length': stat.size
    });
    if (headOnly) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(real);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // Drop idle keep-alive sockets so close() completes right away
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

function hostForUrl(host) {
  if (host === '0.0.0.0' || host === '::' || host === '') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * Starts the static server.
 * @param {{ root?: string, host?: string, port?: number }} [options]
 *   root: directory to serve (default: the package root);
 *   host: interface to bind (default '127.0.0.1');
 *   port: 8080 (default; falls back to 8081–8099 when busy), any other port
 *   (tried alone), or 0 for an ephemeral port.
 * @returns {Promise<{ url: string, port: number, host: string, root: string, close: () => Promise<void> }>}
 */
export async function startServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const requested = options.port == null ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
    throw new RangeError(`Invalid port: ${options.port}`);
  }
  if (RESERVED_PORTS.includes(requested)) {
    throw new RangeError(`Port ${requested} is reserved for the OpenMix desktop app; choose another one`);
  }
  const root = path.resolve(options.root || PACKAGE_ROOT);
  let realRoot;
  try {
    realRoot = await fsp.realpath(root);
    if (!(await fsp.stat(realRoot)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Root directory not found: ${root}`);
  }

  const server = http.createServer(createHandler(realRoot));
  server.keepAliveTimeout = 2000;
  const candidates = requested === DEFAULT_PORT
    ? Array.from({ length: FALLBACK_LAST_PORT - DEFAULT_PORT + 1 }, (_, i) => DEFAULT_PORT + i)
    : [requested];

  let port = null;
  let lastError = null;
  for (const candidate of candidates) {
    // An ephemeral port can (in theory) land on a reserved one: retry a few times
    for (let attempt = 0; attempt < (candidate === 0 ? 5 : 1); attempt++) {
      try {
        const bound = await listenOnce(server, candidate, host);
        if (RESERVED_PORTS.includes(bound)) {
          await closeServer(server);
          continue;
        }
        port = bound;
        break;
      } catch (err) {
        lastError = err;
        if (err && err.code !== 'EADDRINUSE') throw err;
      }
    }
    if (port != null) break;
  }
  if (port == null) {
    const tried = candidates.length > 1 ? `${candidates[0]}–${candidates[candidates.length - 1]}` : String(requested);
    throw new Error(`No free port (${tried}): ${lastError ? lastError.message : 'reserved port'}`);
  }

  return {
    url: `http://${hostForUrl(host)}:${port}`,
    port,
    host,
    root: realRoot,
    close: () => closeServer(server)
  };
}

// ---------------------------------------------------------------- CLI ----

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : null;
    const value = () => {
      if (inline != null) return inline;
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) throw new Error(`Missing value for ${name}`);
      i++;
      return v;
    };
    if (name === '--port' || name === '-p') out.port = Number(value());
    else if (name === '--host') out.host = value();
    else if (name === '--root') out.root = value();
    else if (name === '--help' || name === '-h') out.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

const USAGE = `Usage: node scripts/serve.js [--port 8080] [--host 127.0.0.1] [--root <dir>]

Serves the package folder for the demo and the browser tests.
  --port   port to bind (default 8080, then 8081-8099 if busy; 0 = ephemeral)
  --host   interface to bind (default 127.0.0.1)
  --root   directory to serve (default: the package root)`;

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  let server;
  try {
    server = await startServer(args);
  } catch (err) {
    console.error(`serve.js: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.log('@openmix/web-engine static server');
  console.log(`  root   ${server.root}`);
  console.log(`  demo   ${server.url}/example/`);
  console.log(`  tests  ${server.url}/test/browser/`);
  if (server.host === '0.0.0.0' || server.host === '::') {
    console.log('  warning: bound to every network interface');
  }
  console.log('Press Ctrl+C to stop.');
  const stop = () => {
    server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) main();
