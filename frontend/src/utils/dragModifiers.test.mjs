import assert from 'node:assert/strict';

const { lockXClampYToBounds } = await import('./dragModifiers.ts');

// 列表范围 100~400，被拖的行起始位置 200~240。
const rect = { top: 200, bottom: 240, left: 10, right: 500, width: 490, height: 40 };
const run = (bounds, transform) => lockXClampYToBounds(() => bounds)({
  transform: { ...transform, scaleX: 1, scaleY: 1 },
  draggingNodeRect: rect,
});
const bounds = { top: 100, bottom: 400 };

// 范围内：y 原样保留，x 被锁成 0。
assert.deepEqual(run(bounds, { x: 57, y: 30 }), { x: 0, y: 30, scaleX: 1, scaleY: 1 });
// 往下拖出列表底部：被夹在 bottom（400 - 240 = 160），不会再撑大滚动区域。
assert.equal(run(bounds, { x: 0, y: 9999 }).y, 160);
// 往上拖出列表顶部：被夹在 top（100 - 200 = -100）。
assert.equal(run(bounds, { x: 0, y: -9999 }).y, -100);
// 自动滚动把 transform 越推越大时，结果依然稳定在上限（正是「无限下拉」的场景）。
for (const y of [500, 5_000, 500_000]) assert.equal(run(bounds, { x: 0, y }).y, 160);
// 没有 bounds / 没有 rect 时只锁横向，不抛错。
assert.deepEqual(run(null, { x: 9, y: 9 }), { x: 0, y: 9, scaleX: 1, scaleY: 1 });
assert.deepEqual(
  lockXClampYToBounds(() => bounds)({ transform: { x: 9, y: 9, scaleX: 1, scaleY: 1 }, draggingNodeRect: null }),
  { x: 0, y: 9, scaleX: 1, scaleY: 1 },
);
// 被拖元素比范围还高：不会出现 min > max，固定在 minY。
assert.equal(run({ top: 190, bottom: 230 }, { x: 0, y: 50 }).y, -10);
