/**
 * 节点读形状的共享定义。
 *
 * `getPublicClientsSnapshot`（原生 `/api/clients`、`/api/legacy/nodes`、
 * bootstrap）和 monitor 的 `loadNodes`（`/api/nodes`）都从同一份 PublicClient
 * 列表出发：一个按后台排序生成 monitor 节点，一个把 tags 拆成数组给原生面板。
 * 把“排序”和“tags 展开”放在这里，避免两边对同一行数据给出不同的节点顺序/形状。
 */
import type { PublicClient } from '../../utils/public-client';

/** 原生面板的节点形状：tags 从分号串拆成数组，其余字段保持公开白名单。 */
export type PublicNode = Omit<PublicClient, 'tags'> & { tags: string[] };

/** 后台排序：sort_order 优先，其次按名称；与 monitor `/api/nodes` 一致。 */
export function sortPublicClients<T extends { sort_order?: number; name?: string }>(
  clients: readonly T[],
): T[] {
  return [...clients].sort((left, right) => {
    const orderDiff = (left.sort_order || 0) - (right.sort_order || 0);
    if (orderDiff !== 0) return orderDiff;
    return String(left.name ?? '').localeCompare(String(right.name ?? ''));
  });
}

/** 把公开客户端列表投影成原生节点列表（只做 tags 展开，不改顺序）。 */
export function publicNodeList(clients: readonly PublicClient[]): PublicNode[] {
  return clients.map(client => ({
    ...client,
    tags: client.tags ? client.tags.split(';').filter(Boolean) : [],
  }));
}
