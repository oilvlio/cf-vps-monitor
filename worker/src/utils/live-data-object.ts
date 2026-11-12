/**
 * LIVE_DATA 对象的统一入口。
 *
 * DO 的位置在第一次 `get()` 创建对象时确定，之后不会迁移；不传 `locationHint`
 * 时由平台挑选。早期创建的对象因此落在了 DFW（美中），从新加坡/香港到它的往返
 * 稳定在 200ms 以上，冷路径上每个 DO 调用都要付这笔钱。
 *
 * `locationHint` 只在对象首次创建时生效，所以搬家的唯一办法是换一个对象名，
 * 并保证新名字的第一次 `get()` 带上 hint。这里集中放名字与 hint，避免某个路由
 * 漏改后悄悄又连回旧对象（旧名 `global` 只用于回滚）。
 *
 * 新 DO 的状态可以自动重建：agent 上报几秒内回填实时数据，`monitor:meta` 由
 * Worker 下一次推送补齐，`admin-clients:snapshot` / `agent-auth:*` 在缺失时回落到
 * Supabase 再回写。
 */

import type { Bindings } from '../index';

export const LIVE_DATA_OBJECT_NAME = 'global-v2';

/** 亚太（新加坡）。若实际落点不理想，可改回更宽泛的 `apac`。 */
export const LIVE_DATA_LOCATION_HINT: DurableObjectLocationHint = 'apac-se';

export function liveDataId(namespace: Bindings['LIVE_DATA']): DurableObjectId {
  return namespace.idFromName(LIVE_DATA_OBJECT_NAME);
}

export function liveDataStub(namespace: Bindings['LIVE_DATA']) {
  return namespace.get(liveDataId(namespace), { locationHint: LIVE_DATA_LOCATION_HINT });
}
