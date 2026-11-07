import assert from 'node:assert/strict';

const { moveAdminNodeInVisibleOrder, sortClientsByAdminOrder } = await import('./adminNodeOrder.ts');

const clients = [
  { uuid: 'a', name: 'A', sort_order: 1 },
  { uuid: 'h', name: 'Hidden', hidden: true, sort_order: 2 },
  { uuid: 'b', name: 'B', sort_order: 3 },
  { uuid: 'c', name: 'C', sort_order: 4 },
];
const visible = [clients[0], clients[2], clients[3]];

assert.deepEqual(
  moveAdminNodeInVisibleOrder(clients, visible, 'c', 'a').map((client) => `${client.sort_order}:${client.uuid}`),
  ['1:c', '2:h', '3:a', '4:b'],
);

// 延迟监测的服务器视图跟随后台服务器的手动顺序：sort_order 升序，缺失的排最后，相同按名称。
assert.deepEqual(
  sortClientsByAdminOrder([
    { uuid: 'x', name: 'X' },
    { uuid: 'c', name: 'C', sort_order: 3 },
    { uuid: 'b2', name: 'B2', sort_order: 1 },
    { uuid: 'b1', name: 'B1', sort_order: 1 },
    { uuid: 'a', name: 'A', sort_order: 2 },
  ]).map((client) => client.uuid),
  ['b1', 'b2', 'a', 'c', 'x'],
);
