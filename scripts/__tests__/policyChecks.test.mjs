import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';

import { checkNoHiddenNetwork } from '../checkNoHiddenNetwork.mjs';
import { checkReleaseSecrets } from '../checkReleaseSecrets.mjs';
import { checkSourceAssetPolicy } from '../checkSourceAssetPolicy.mjs';

const roots = [];

async function makeRepo(files) {
  const root = await mkdtemp(join(tmpdir(), 'cts-policy-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const studioSrc = 'apps/studio/src/a.ts';

test('network: control repo with a clean source file passes', async () => {
  const root = await makeRepo({ [studioSrc]: 'export const x = 1;\n' });
  assert.deepEqual(await checkNoHiddenNetwork(root), []);
});

test('network: fetch in a file larger than 100 KiB is still detected (1)', async () => {
  const root = await makeRepo({ [studioSrc]: `${'// padding\n'.repeat(15000)}fetch('/x');\n` });
  assert.match((await checkNoHiddenNetwork(root)).map((i) => i.message).join('\n'), /fetch call/);
});

test('network: files above the scan limit fail instead of being skipped (1)', async () => {
  const root = await makeRepo({ [studioSrc]: 'a'.repeat(5 * 1024 * 1024 + 1) });
  assert.match((await checkNoHiddenNetwork(root)).map((i) => i.message).join('\n'), /scan limit/);
});

test('network: lookalike hostnames fail even in test files (2)', async () => {
  const root = await makeRepo({
    'apps/studio/src/a.test.ts': "const u = 'https://tauri.localhost.example.org/';\n",
  });
  assert.equal((await checkNoHiddenNetwork(root)).length, 1);
});

test('network: reserved hosts are allowed in test files only (2)', async () => {
  const ok = await makeRepo({
    'apps/studio/src/a.test.ts': "const u = ['https://example.com/', 'http://x.invalid/', 'https://tauri.localhost/'];\n",
  });
  assert.deepEqual(await checkNoHiddenNetwork(ok), []);
  const bad = await makeRepo({ [studioSrc]: "export const u = 'https://example.com/';\n" });
  assert.equal((await checkNoHiddenNetwork(bad)).length, 1);
});

test('network: Rust cfg(test) module may use reserved hosts, production code may not (2)', async () => {
  const rs = (body) => ({ 'apps/desktop/src-tauri/src/lib.rs': body });
  const ok = await makeRepo(rs('#[cfg(test)]\nmod tests {\n    fn t() { let _ = "https://example.com/"; }\n}\n'));
  assert.deepEqual(await checkNoHiddenNetwork(ok), []);
  const bad = await makeRepo(rs('fn p() { let _ = "https://example.com/"; }\n#[cfg(test)]\nmod tests {}\n'));
  assert.equal((await checkNoHiddenNetwork(bad)).length, 1);
});

test('network: stylesheet, html and svg remote references fail (3)', async () => {
  for (const [path, content] of [
    ['apps/studio/src/a.css', "@import url('https://cdn.test-host.net/a.css');\n"],
    ['apps/studio/src/b.css', '.a { background: url(https://cdn.test-host.net/a.png); }\n'],
    ['apps/studio/src/c.css', '@import "//cdn.test-host.net/a.css";\n'],
    ['apps/studio/index.html', '<script src="https://cdn.test-host.net/a.js"></script>\n'],
    ['apps/studio/public/a.svg', '<svg><image href="https://cdn.test-host.net/a.png"/></svg>\n'],
  ]) {
    const root = await makeRepo({ [path]: content });
    assert.ok((await checkNoHiddenNetwork(root)).length >= 1, path);
  }
  const ns = await makeRepo({ 'apps/studio/public/a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n' });
  assert.deepEqual(await checkNoHiddenNetwork(ns), []);
});

test('network: object-form http / updater / websocket permissions fail (4)', async () => {
  for (const identifier of ['http:default', 'updater:default', 'websocket:default']) {
    const root = await makeRepo({
      'apps/desktop/src-tauri/capabilities/main.json': JSON.stringify({
        permissions: ['core:default', { identifier, allow: [{ url: 'https://x.test-host.net' }] }],
      }),
    });
    assert.match((await checkNoHiddenNetwork(root)).map((i) => i.message).join('\n'), /network-capable Tauri permission/, identifier);
  }
  const ok = await makeRepo({
    'apps/desktop/src-tauri/capabilities/main.json': JSON.stringify({ permissions: ['core:default', { identifier: 'dialog:allow-open' }] }),
  });
  assert.deepEqual(await checkNoHiddenNetwork(ok), []);
});

test('network round 3: .mts / .cts / .cjs / .mjs files are scanned (1)', async () => {
  for (const name of ['a.mts', 'a.cts', 'a.cjs', 'a.mjs']) {
    const root = await makeRepo({ [`apps/studio/src/${name}`]: "fetch('/x');\n" });
    assert.ok((await checkNoHiddenNetwork(root)).length >= 1, name);
  }
});

test('network round 3: optional-call fetch and protocol-relative string literals fail (2)', async () => {
  for (const code of [
    "window.fetch?.('//cdn.example.org/a');\n",
    "const f = window?.fetch; globalThis?.fetch(url);\n",
    "export const u = '//cdn.example.org/a';\n",
    'export const u = "//cdn.example.org/a";\n',
    'export const u = `//cdn.example.org/a`;\n',
  ]) {
    const root = await makeRepo({ [studioSrc]: code });
    assert.ok((await checkNoHiddenNetwork(root)).length >= 1, code);
  }
  const comment = await makeRepo({ [studioSrc]: '// a comment //not.a.url\nexport const x = 1; // trailing\n' });
  assert.deepEqual(await checkNoHiddenNetwork(comment), []);
});

test('network round 3: protocol-relative JSX / HTML resource attributes fail (3)', async () => {
  for (const attr of ['src', 'href', 'srcset', 'poster', 'action', 'formaction', 'data']) {
    const root = await makeRepo({ 'apps/studio/src/a.tsx': `export const a = <x ${attr}="//cdn.example.org/logo.png" />;\n` });
    assert.ok((await checkNoHiddenNetwork(root)).length >= 1, attr);
  }
  const srcset = await makeRepo({ 'apps/studio/src/a.tsx': 'export const a = <img srcSet="a.png 1x, //cdn.example.org/b.png 2x" />;\n' });
  assert.ok((await checkNoHiddenNetwork(srcset)).length >= 1);
  const html = await makeRepo({ 'apps/studio/index.html': '<img src="//cdn.example.org/a.png">\n' });
  assert.ok((await checkNoHiddenNetwork(html)).length >= 1);
});

test('network round 3: userinfo tricks are judged by the parsed hostname (4)', async () => {
  for (const url of ['https://localhost;@cdn.example.org/a', 'https://localhost:x@cdn.example.org/a', 'http://127.0.0.1,@cdn.example.org/']) {
    const root = await makeRepo({ [studioSrc]: `export const u = '${url}';\n` });
    assert.ok((await checkNoHiddenNetwork(root)).length >= 1, url);
  }
});

test('network round 3: W3C namespace URLs are allowed only in namespace contexts (5)', async () => {
  for (const code of [
    'export const a = <img src="http://www.w3.org/2000/svg" />;\n',
    "export const u = 'http://www.w3.org/2000/svg';\n",
    "export const a = <svg xmlns=\"https://www.w3.org/2000/svg\" />;\n",
  ]) {
    const root = await makeRepo({ [studioSrc]: code });
    assert.ok((await checkNoHiddenNetwork(root)).length >= 1, code);
  }
  const ok = await makeRepo({
    'apps/studio/src/a.tsx': 'export const a = <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" />;\n',
    'apps/studio/src/b.ts': "export const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg');\n",
    'apps/studio/src/c.ts': "export const f = (n: Element) => n.namespaceURI === 'http://www.w3.org/2000/svg';\n",
  });
  assert.deepEqual(await checkNoHiddenNetwork(ok), []);
});

test('secrets: control repo with placeholders passes', async () => {
  const root = await makeRepo({ 'a.yml': 'TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.KEY }}\n', 'b.json': `{"${'CERTIFICATE_' + 'PASSWORD'}": "<set-in-ci>"}\n` });
  assert.deepEqual(await checkReleaseSecrets(root), []);
});

test('secrets: JSON keys with quoted names fail (5)', async () => {
  const root = await makeRepo({ 'a.json': `{"${'TAURI_SIGNING_' + 'PRIVATE_KEY_PASSWORD'}":"x"}\n` });
  assert.equal((await checkReleaseSecrets(root)).length, 1);
});

test('secrets: .pem / .key / .p12 / .pfx files are scanned (6)', async () => {
  const block = `-----BEGIN ${'PRIVATE'} KEY-----\nabc\n`;
  for (const name of ['a.pem', 'a.key', 'a.p12', 'a.pfx']) {
    const root = await makeRepo({ [name]: block });
    assert.ok((await checkReleaseSecrets(root)).length >= 1, name);
  }
  const publicCert = await makeRepo({ 'a.pem': '-----BEGIN CERTIFICATE-----\nabc\n' });
  assert.deepEqual(await checkReleaseSecrets(publicCert), []);
});

test('secrets: a PEM private key block fails in any text file (6)', async () => {
  const root = await makeRepo({ 'notes.dat': `-----BEGIN ${'RSA PRIVATE'} KEY-----\nabc\n` });
  assert.equal((await checkReleaseSecrets(root)).length, 1);
});

test('assets: only png / ico / icns under the icon directory are exempt (7)', async () => {
  const ok = await makeRepo({ 'apps/desktop/src-tauri/icons/icon.png': 'x', 'apps/desktop/src-tauri/icons/icon.icns': 'x' });
  assert.deepEqual(await checkSourceAssetPolicy(ok), []);
  const bad = await makeRepo({
    'apps/desktop/src-tauri/icons/loop.wav': 'x',
    'apps/desktop/src-tauri/icons/a.zip': 'x',
    'apps/desktop/src-tauri/icons/a.p12': 'x',
    'apps/studio/src/icon.png': 'x',
  });
  assert.equal((await checkSourceAssetPolicy(bad)).length, 4);
});
