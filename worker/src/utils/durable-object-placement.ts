/**
 * 自建 Durable Object 的放置提示。
 *
 * `locationHint` 只在对象**首次创建**时生效，已有对象不会迁移；因此换 hint 必须
 * 同时换对象名。历史上 LIVE_DATA 与 RATE_LIMIT 都是在没有 hint 的情况下创建的，
 * 落到了 DFW（美中），从新加坡往返稳定 200ms 以上。
 *
 * `apac-se` 是东南亚（新加坡）；如果实际落点不理想，可改回更宽泛的 `apac`。
 */
export const APAC_DO_LOCATION_HINT: DurableObjectLocationHint = 'apac-se';
