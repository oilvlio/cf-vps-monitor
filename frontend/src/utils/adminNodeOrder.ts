import { arrayMove } from '@dnd-kit/sortable';
import type { ClientInfo } from '../types';

export function moveAdminNodeInVisibleOrder<T extends ClientInfo>(
  allClients: T[],
  visibleClients: T[],
  activeId: string,
  overId: string,
): T[] {
  const oldVisibleIndex = visibleClients.findIndex((client) => client.uuid === activeId);
  const newVisibleIndex = visibleClients.findIndex((client) => client.uuid === overId);
  if (oldVisibleIndex < 0 || newVisibleIndex < 0) return allClients;

  const movedVisible = arrayMove(visibleClients, oldVisibleIndex, newVisibleIndex);
  const byUuid = new Map(movedVisible.map((client) => [client.uuid, client]));
  let visibleIndex = 0;
  return allClients.map((client) => {
    if (!byUuid.has(client.uuid)) return client;
    return movedVisible[visibleIndex++];
  }).map((client, index) => ({ ...client, sort_order: index + 1 }));
}

/**
 * 与后台「服务器」页「手动」排序同一口径：按 sort_order 升序，缺失的排最后，相同时按名称。
 * 其它页面（如延迟监测的服务器视图）用它跟随服务器的手动顺序。
 */
export function sortClientsByAdminOrder<T extends { name?: string; sort_order?: number }>(clients: T[]): T[] {
  const orderOf = (client: T) => (
    typeof client.sort_order === 'number' && Number.isFinite(client.sort_order)
      ? client.sort_order
      : Number.MAX_SAFE_INTEGER
  );
  return [...clients].sort((a, b) => (
    orderOf(a) - orderOf(b) || (a.name || '').localeCompare(b.name || '')
  ));
}
