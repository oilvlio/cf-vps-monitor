import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'fflate';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

function archive(files) {
  const entries = Object.entries(files).map(([name, text]) => {
    const body = Buffer.from(text), header = Buffer.alloc(512);
    header.write(`dist/${name}`, 0, 100);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header[156] = 48;
    return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
  });
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

test('release archive TTL is independent of hashed assets; missing assets and refresh reload memory and HTML', async () => {
  let files = { 'index.html': 'old', 'assets/old-abcdefgh.js': 'old-js' }, fetches = 0;
  const cache = new Map();
  const loader = createWorkerLoader({ globals: {
    caches: { default: {
      match: async key => cache.get(key.url)?.clone(),
      put: async (key, response) => { cache.set(key.url, response.clone()); },
      delete: async key => cache.delete(key.url),
    } },
    fetch: async () => { fetches++; return new Response(archive(files)); },
  } });
  const { parseThemeUrl, fetchPublishedThemeFile, clearPublishedThemeCache } = loader.load('worker/src/utils/third-party-theme.ts');
  const theme = parseThemeUrl('https://github.com/o/r');
  await fetchPublishedThemeFile(theme, 'assets/old-abcdefgh.js', 'application/javascript', 31536000, undefined, true);
  const bundle = [...cache.entries()].find(([key]) => key.includes('/archive/'))[1];
  assert.equal(bundle.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(await (await fetchPublishedThemeFile(theme, 'index.html', 'text/html', 60)).text(), 'old');
  files = { 'index.html': 'new', 'assets/new-abcdefgh.js': 'new-js' };
  const module = await fetchPublishedThemeFile(theme, 'assets/new-abcdefgh.js', 'application/javascript', 31536000, undefined, true);
  assert.equal(module.status, 200);
  assert.equal(await module.text(), 'new-js');
  assert.equal(fetches, 2);
  assert.equal(await (await fetchPublishedThemeFile(theme, 'index.html', 'text/html', 60)).text(), 'new');
  files = { 'index.html': 'refreshed' };
  await clearPublishedThemeCache(theme);
  assert.equal(await (await fetchPublishedThemeFile(theme, 'index.html', 'text/html', 60)).text(), 'refreshed');
});

test('tag URLs fetch and cache the requested release independently from latest', async () => {
  const urls = [];
  const loader = createWorkerLoader({ globals: { fetch: async url => {
    urls.push(url);
    return new Response(archive({ 'index.html': url.includes('/download/v1.2.3/') ? 'pinned' : 'latest' }));
  } } });
  const { parseThemeUrl, fetchPublishedThemeFile } = loader.load('worker/src/utils/third-party-theme.ts');
  const theme = parseThemeUrl('https://github.com/o/r/releases/tag/v1.2.3');
  assert.equal(theme.ref, 'v1.2.3');
  assert.equal(theme.repository, true);
  assert.equal(await (await fetchPublishedThemeFile(theme, 'index.html', 'text/html', 60)).text(), 'pinned');
  assert.deepEqual(urls, ['https://github.com/o/r/releases/download/v1.2.3/theme.tar.gz']);
});
