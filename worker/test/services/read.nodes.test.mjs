import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const { publicNodeList, sortPublicClients } = createWorkerLoader()
  .load('worker/src/services/read/nodes.ts');

// vm 上下文的数组原型与测试 realm 不同，比较前做一次 JSON 往返。
const plain = value => JSON.parse(JSON.stringify(value));

test('node read: sort_order wins, then the name, for every reader', () => {
  const sorted = sortPublicClients([
    { uuid: 'c', name: 'Zurich', sort_order: 2 },
    { uuid: 'a', name: 'Osaka' },
    { uuid: 'b', name: 'Berlin', sort_order: 2 },
    { uuid: 'd', name: 'Tokyo', sort_order: 1 },
  ]);
  assert.deepEqual(plain(sorted.map(node => node.uuid)), ['a', 'd', 'b', 'c']);
  // 不改原数组。
  assert.equal(sorted.length, 4);
});

test('node read: tags expand once and preserve every other public field', () => {
  const nodes = publicNodeList([
    { uuid: 'a', name: 'A', tags: 'cn;edge;;' },
    { uuid: 'b', name: 'B', tags: '' },
    { uuid: 'c', name: 'C' },
  ]);
  assert.deepEqual(plain(nodes.map(node => node.tags)), [['cn', 'edge'], [], []]);
  assert.equal(nodes[0].name, 'A');
  assert.equal(nodes[0].uuid, 'a');
});
