/**
 * LIVE_DATA 对象的统一入口。
 *
 * DO 的位置在第一次 `get()` 创建对象时确定，之后不会迁移；不传 `locationHint`
 * 时由平台挑选。早期创建的对象因此落在了 DFW（美中），从新加坡/香港到它的往返
 * 稳定在 200ms 以上，冷路径上每个 DO 调用都要付这笔钱。
 *
 * `locationHint` 只在对象首次创建时生效，所以搬家的唯一办法是换一个对象名，
 * 并保证新名字的第一次 `get()` 带上 hint。这里集中放名字与 hint，避免某个路由
 * 漏改后悄悄又连回旧对象。
 *
 * 新 DO 的状态可以自动重建：agent 上报几秒内回填实时数据，`monitor:meta` 由
 * DO 自行刷新；节点元数据和认证快照由管理员控制面更新，认证缺失时查询 Supabase。
 */

import type { Bindings } from '../index';
// 显式 `.ts` 扩展名：这个模块会被 `worker/test/*-runtime.test.mjs` 用 Node 原生
// 加载（不走 test-support 的自定义 loader），原生 ESM 不解析无扩展名的相对路径。
import { APAC_DO_LOCATION_HINT } from './durable-object-placement.ts';

export const LIVE_DATA_OBJECT_NAME = 'global-v2';

/** 亚太（新加坡）。若实际落点不理想，可改回更宽泛的 `apac`。 */
export const LIVE_DATA_LOCATION_HINT: DurableObjectLocationHint = APAC_DO_LOCATION_HINT;

export function liveDataId(namespace: Bindings['LIVE_DATA']): DurableObjectId {
  return namespace.idFromName(LIVE_DATA_OBJECT_NAME);
}

export function liveDataStub(namespace: Bindings['LIVE_DATA']) {
  return namespace.get(liveDataId(namespace), { locationHint: LIVE_DATA_LOCATION_HINT });
}
