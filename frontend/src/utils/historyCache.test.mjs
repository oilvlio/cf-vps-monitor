import assert from 'node:assert/strict';

const { HISTORY_CACHE_TTL_MS, readFreshCache, writeCache } = await import('./historyCache.ts');

assert.equal(HISTORY_CACHE_TTL_MS, 5 * 60 * 1000, '有效期是 5 分钟');

const cache = new Map();
assert.equal(readFreshCache(cache, 'k', 1000), undefined, '没有缓存时未命中');

writeCache(cache, 'k', { v: 1 }, 1000);
assert.deepEqual(readFreshCache(cache, 'k', 1000), { v: 1 });
assert.deepEqual(readFreshCache(cache, 'k', 1000 + HISTORY_CACHE_TTL_MS - 1), { v: 1 }, '有效期内命中');

assert.equal(readFreshCache(cache, 'k', 1000 + HISTORY_CACHE_TTL_MS), undefined, '到期即失效');
assert.equal(cache.has('k'), false, '过期条目被顺手删除');

// 写入时清掉其它已过期的条目，没过期的保留。
writeCache(cache, 'old', 'a', 0);
writeCache(cache, 'recent', 'b', HISTORY_CACHE_TTL_MS - 10);
writeCache(cache, 'new', 'c', HISTORY_CACHE_TTL_MS + 1);
assert.deepEqual([...cache.keys()].sort(), ['new', 'recent']);

// 命中不会续期：从写入时刻起算。
writeCache(cache, 'fixed', 'x', 10_000);
assert.equal(readFreshCache(cache, 'fixed', 10_000 + 1000), 'x');
assert.equal(readFreshCache(cache, 'fixed', 10_000 + HISTORY_CACHE_TTL_MS), undefined);

// 自定义有效期。
writeCache(cache, 'short', 1, 0, 50);
assert.equal(readFreshCache(cache, 'short', 49, 50), 1);
assert.equal(readFreshCache(cache, 'short', 50, 50), undefined);
console.log('history cache ok');
