import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Dialog,
  Flex,
  Grid,
  Select,
  Switch,
  Text,
  TextField,
} from '@radix-ui/themes';
import { Activity, Globe, Grip, ListChecks, Pencil, Plus, Search, Server, Trash2, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { useAdminAction } from '../../hooks/useAdminAction';
import { sortClientsByAdminOrder } from '../../utils/adminNodeOrder';
import { lockXClampYToBounds, type DragBounds } from '../../utils/dragModifiers';
import {
  Badge as SaBadge,
  Button as SaButton,
  Card as SaCard,
  ConfirmDialog,
  Segmented,
  StatGrid,
} from '../../components/ui/minimal';

interface PingTask {
  id: number;
  name: string;
  clients: string[];
  all_clients: boolean;
  type: 'icmp' | 'tcp' | 'http' | string;
  target: string;
  interval_sec: number;
  sort_order?: number;
}

interface ClientLite {
  uuid: string;
  name: string;
  group?: string;
  region?: string;
  sort_order?: number;
}

type TaskScopeFilter = 'all' | 'global' | 'selected' | 'unbound';
type TaskViewMode = 'task' | 'server';

function isUnboundTask(task: PingTask) {
  return !task.all_clients && !task.clients?.length;
}

function getTaskScopeLabel(task: PingTask, clients: ClientLite[]) {
  if (task.all_clients) return '所有服务器';
  if (!task.clients?.length) return '未绑定服务器';

  return task.clients
    .map((uuid) => clients.find((client) => client.uuid === uuid)?.name || uuid)
    .join(', ');
}

function TaskDialog({
  open,
  onOpenChange,
  clients,
  editingTask,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clients: ClientLite[];
  editingTask: PingTask | null;
  onSaved: (task?: PingTask) => void;
}) {
  const apiFetch = useApi();
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (!open) return;

    if (editingTask) {
      setFormData({
        name: editingTask.name,
        type: editingTask.type,
        target: editingTask.target,
        clients: editingTask.clients || [],
        all_clients: editingTask.all_clients,
      });
      return;
    }

    setFormData({
      name: '',
      type: 'icmp',
      target: '',
      clients: [],
      all_clients: true,
    });
  }, [open, editingTask]);

  const selectedClients = (formData.clients as string[] | undefined) || [];
  const allClients = Boolean(formData.all_clients);

  const toggleClient = (uuid: string) => {
    if (selectedClients.includes(uuid)) {
      setFormData((prev) => ({ ...prev, clients: selectedClients.filter((id) => id !== uuid) }));
      return;
    }
    setFormData((prev) => ({ ...prev, clients: [...selectedClients, uuid] }));
  };

  const handleSave = async () => {
    const name = String(formData.name || '').trim();
    const target = String(formData.target || '').trim();

    if (!name) {
      toast.error('请输入任务名称');
      return;
    }

    if (!target) {
      toast.error('请输入目标地址');
      return;
    }

    setSaving(true);

    const payload = {
      name,
      type: String(formData.type || 'icmp'),
      target,
      clients: allClients ? [] : selectedClients,
      all_clients: allClients,
    };

    try {
      const result = editingTask
        ? await apiFetch('/admin/ping/edit', {
          method: 'POST',
          body: JSON.stringify({ id: editingTask.id, ...payload }),
        })
        : await apiFetch('/admin/ping/add', {
          method: 'POST',
          body: JSON.stringify(payload),
        });

      if (result.success) {
        toast.success(editingTask ? '编辑成功' : '添加成功');
        onOpenChange(false);
        onSaved(result.task);
      } else {
        toast.error(result.error || '保存失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content aria-describedby={undefined} style={{ maxWidth: 620 }}>
        <Dialog.Title>{editingTask ? '编辑 Ping 任务' : '添加 Ping 任务'}</Dialog.Title>
        <Flex direction="column" gap="3" style={{ padding: '8px 0', maxHeight: 560, overflow: 'auto' }}>
          <Grid columns={{ initial: '1', sm: '2' }} gap="3">
            <label>
              <Text size="2" weight="bold">名称</Text>
              <TextField.Root
                style={{ width: '100%', marginTop: 4 }}
                value={String(formData.name || '')}
                onChange={(event) => setFormData({ ...formData, name: event.target.value })}
              />
            </label>
            <label>
              <Text size="2" weight="bold">类型</Text>
              <Select.Root
                value={String(formData.type || 'icmp')}
                onValueChange={(value) => setFormData({ ...formData, type: value })}
              >
                <Select.Trigger style={{ width: '100%', marginTop: 4 }} />
                <Select.Content>
                  <Select.Item value="icmp">ICMP Ping</Select.Item>
                  <Select.Item value="tcp">TCP Ping</Select.Item>
                  <Select.Item value="http">HTTP Ping</Select.Item>
                </Select.Content>
              </Select.Root>
            </label>
          </Grid>

          <label>
            <Text size="2" weight="bold">目标地址</Text>
            <Text size="1" color="gray" style={{ display: 'block', marginTop: 2 }}>
              ICMP 示例 1.1.1.1；TCP 示例 1.1.1.1:443；HTTP 示例 https://example.com
            </Text>
            <TextField.Root
              style={{ width: '100%', marginTop: 4 }}
              value={String(formData.target || '')}
              onChange={(event) => setFormData({ ...formData, target: event.target.value })}
            />
          </label>

          <Box style={{ border: '1px solid var(--gray-5)', borderRadius: 8, padding: 12 }}>
            <Flex direction="column" gap="3">
              <Flex align="center" justify="between" gap="3">
                <Flex direction="column">
                  <Text size="2" weight="bold">应用范围</Text>
                  <Text size="1" color="gray">可应用到所有服务器、绑定到指定服务器，也可暂不分配，稍后在「服务器视图」里按服务器勾选</Text>
                </Flex>
                <Flex align="center" gap="2">
                  <Switch checked={allClients} onCheckedChange={(value) => setFormData({ ...formData, all_clients: value })} />
                  <Text size="2">所有服务器</Text>
                </Flex>
              </Flex>

              <Flex gap="2" wrap="wrap">
                <Badge variant="soft" color={allClients ? 'green' : 'gray'}>
                  {allClients ? '当前为全局任务' : '当前为定向任务'}
                </Badge>
                {!allClients && (
                  <Badge variant="soft" color={selectedClients.length > 0 ? 'blue' : 'amber'}>
                    已选服务器 {selectedClients.length}
                  </Badge>
                )}
              </Flex>

              {!allClients && selectedClients.length === 0 && (
                <Text size="1" color="amber">
                  未选择服务器：任务会先保存，但暂不在任何服务器上运行。
                </Text>
              )}

              {!allClients && (
                <Grid columns={{ initial: '1', sm: '2' }} gap="2">
                  {clients.map((client) => {
                    const selected = selectedClients.includes(client.uuid);
                    return (
                      <Box
                        key={client.uuid}
                        style={{
                          padding: 10,
                          cursor: 'pointer',
                          borderRadius: 6,
                          border: selected ? '1px solid var(--blue-8)' : '1px solid var(--gray-5)',
                          background: selected ? 'var(--blue-2)' : 'var(--color-panel-solid)',
                        }}
                        onClick={() => toggleClient(client.uuid)}
                      >
                        <Flex align="center" gap="2">
                          <Checkbox
                            checked={selected}
                            onClick={(event) => event.stopPropagation()}
                            onCheckedChange={() => toggleClient(client.uuid)}
                          />
                          <Flex direction="column" style={{ minWidth: 0 }}>
                            <Text size="2" weight="medium" truncate>{client.name}</Text>
                            <Text size="1" color="gray" truncate>
                              {(client.group || '未分组') + (client.region ? ` / ${client.region}` : '')}
                            </Text>
                          </Flex>
                        </Flex>
                      </Box>
                    );
                  })}
                </Grid>
              )}
            </Flex>
          </Box>
        </Flex>

        <Flex gap="3" justify="end" mt="4">
          <Button variant="soft" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? '保存中...' : '保存'}</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function NodeTasksDialog({
  client,
  tasks,
  onClose,
  onSaved,
}: {
  client: ClientLite | null;
  tasks: PingTask[];
  onClose: () => void;
  onSaved: (updated: PingTask[]) => void;
}) {
  const apiFetch = useApi();
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<number[]>([]);
  const [base, setBase] = useState<number[]>([]);
  // 首页探测点：每台服务器只能有一个，null 表示首页不显示。
  const [homeTaskId, setHomeTaskId] = useState<number | null>(null);
  const [initialHomeTaskId, setInitialHomeTaskId] = useState<number | null>(null);
  const [homeLoaded, setHomeLoaded] = useState(false);
  const [homeError, setHomeError] = useState('');
  const clientUuid = client?.uuid ?? null;

  // 以打开时的勾选作为起点：保存只提交相对它的改动，
  // 编辑期间别处对这台服务器做的分配不会被一份过期列表覆盖。
  useEffect(() => {
    if (!clientUuid) return;
    const initial = tasks
      .filter((task) => !task.all_clients && task.clients?.includes(clientUuid))
      .map((task) => task.id);
    setBase(initial);
    setChosen(initial);
    setSearch('');
    // 只在切换服务器时重置；任务列表的后续刷新不应冲掉正在进行的勾选。
  }, [clientUuid]);

  // 读取这台服务器当前的首页探测点。读取失败时不允许改动，避免用一个空值覆盖真实设置。
  useEffect(() => {
    if (!clientUuid) return undefined;
    let cancelled = false;
    setHomeTaskId(null);
    setInitialHomeTaskId(null);
    setHomeLoaded(false);
    setHomeError('');
    apiFetch('/admin/home-ping')
      .then((result: { assignments?: Record<string, unknown> }) => {
        if (cancelled) return;
        const raw = Number(result?.assignments?.[clientUuid]);
        const current = Number.isInteger(raw) && raw > 0 ? raw : null;
        setHomeTaskId(current);
        setInitialHomeTaskId(current);
        setHomeLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setHomeError(error instanceof Error && error.message ? error.message : '读取首页探测点失败');
      });
    return () => { cancelled = true; };
  }, [apiFetch, clientUuid]);

  const visibleTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return tasks;
    return tasks.filter((task) => [task.name, task.type, task.target].join(' ').toLowerCase().includes(query));
  }, [tasks, search]);

  const selectableVisible = visibleTasks.filter((task) => !task.all_clients);
  const globalCount = tasks.filter((task) => task.all_clients).length;
  const assignChanged = chosen.filter((id) => !base.includes(id)).length + base.filter((id) => !chosen.includes(id)).length;
  const isTaskSelected = (task: PingTask) => task.all_clients || chosen.includes(task.id);
  // 首页探测点必须是已勾选（或全局）的任务；取消勾选后自动视为不显示。
  const effectiveHomeId = homeTaskId !== null && tasks.some((task) => task.id === homeTaskId && isTaskSelected(task))
    ? homeTaskId
    : null;
  const homeChanged = homeLoaded && effectiveHomeId !== initialHomeTaskId;
  const changed = assignChanged + (homeChanged ? 1 : 0);

  const toggle = (id: number) => {
    setChosen((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const toggleHome = (id: number, on: boolean) => {
    setHomeTaskId(on ? id : null);
  };

  const setVisible = (on: boolean) => {
    const ids = new Set(selectableVisible.map((task) => task.id));
    setChosen((current) => on
      ? [...new Set([...current, ...ids])]
      : current.filter((id) => !ids.has(id)));
  };

  const handleSave = async () => {
    if (!client) return;
    if (changed === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      let updatedTasks: PingTask[] = [];
      if (assignChanged > 0) {
        const result = await apiFetch('/admin/ping/assign', {
          method: 'POST',
          body: JSON.stringify({ client: client.uuid, tasks: chosen, base }),
        });
        if (!result.success) {
          toast.error(result.error || '保存失败');
          return;
        }
        updatedTasks = Array.isArray(result.tasks) ? result.tasks : [];
        onSaved(updatedTasks);
        // 任务分配已落库：即使后面的首页设置失败，也别让下次保存重复提交这部分。
        setBase(chosen);
      }

      if (homeChanged) {
        try {
          await apiFetch('/admin/clients/' + client.uuid + '/home-ping', {
            method: 'POST',
            body: JSON.stringify({ task_id: effectiveHomeId }),
          });
        } catch (error) {
          toast.error(error instanceof Error ? `监控任务已保存，但首页显示设置失败：${error.message}` : '监控任务已保存，但首页显示设置失败');
          return;
        }
      }
      toast.success('监控任务已更新');
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={Boolean(client)} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content aria-describedby={undefined} style={{ maxWidth: 560 }}>
        <Dialog.Title>分配监控任务{client ? ` · ${client.name}` : ''}</Dialog.Title>

        <Flex direction="column" gap="3" style={{ padding: '8px 0' }}>
          <Flex gap="2" align="center" wrap="wrap">
            <TextField.Root
              style={{ flex: 1, minWidth: 180 }}
              placeholder="搜索任务"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            >
              <TextField.Slot><Search size={14} /></TextField.Slot>
            </TextField.Root>
            <Button size="1" variant="soft" onClick={() => setVisible(true)} disabled={selectableVisible.length === 0}>全选</Button>
            <Button size="1" variant="soft" color="gray" onClick={() => setVisible(false)} disabled={selectableVisible.length === 0}>清空</Button>
          </Flex>

          {globalCount > 0 && (
            <Text size="1" color="gray">
              「全局」任务跟随所有服务器，不能在这里逐台取消；如需只在部分服务器运行，请在任务里关闭“所有服务器”。
            </Text>
          )}

          {homeError && <Text size="1" color="red">{homeError}</Text>}
          <Text size="1" color="gray">
            勾选任务后，可在该任务右侧打开“首页显示”：首页节点卡片上的延迟 / 丢包色块只读这一个任务。
          </Text>

          <Flex direction="column" gap="2" style={{ maxHeight: 400, overflow: 'auto' }}>
            {tasks.length === 0 ? (
              <Text color="gray" align="center" style={{ display: 'block', padding: 24 }}>暂无 Ping 任务，请先添加任务</Text>
            ) : visibleTasks.length === 0 ? (
              <Text color="gray" align="center" style={{ display: 'block', padding: 24 }}>没有匹配的任务</Text>
            ) : visibleTasks.map((task) => {
              const isGlobal = task.all_clients;
              const selected = isGlobal || chosen.includes(task.id);
              return (
                <Box
                  key={task.id}
                  style={{
                    padding: 10,
                    borderRadius: 6,
                    cursor: isGlobal ? 'not-allowed' : 'pointer',
                    opacity: isGlobal ? 0.75 : 1,
                    border: selected ? '1px solid var(--blue-8)' : '1px solid var(--gray-5)',
                    background: selected ? 'var(--blue-2)' : 'var(--color-panel-solid)',
                  }}
                  onClick={() => { if (!isGlobal) toggle(task.id); }}
                >
                  <Flex align="center" gap="2">
                    <Checkbox
                      checked={selected}
                      disabled={isGlobal}
                      onClick={(event) => event.stopPropagation()}
                      onCheckedChange={() => { if (!isGlobal) toggle(task.id); }}
                    />
                    <Flex direction="column" style={{ minWidth: 0, flex: 1 }}>
                      <Flex align="center" gap="2">
                        <Text size="2" weight="medium" truncate>{task.name}</Text>
                        <Badge size="1" variant="soft">{task.type.toUpperCase()}</Badge>
                        {isGlobal && <Badge size="1" variant="soft" color="green">全局</Badge>}
                      </Flex>
                      <Text size="1" color="gray" truncate style={{ fontFamily: 'monospace' }}>{task.target}</Text>
                    </Flex>
                    {selected && (
                      <label
                        className="admin-ping-home-toggle"
                        title="首页节点卡片的延迟 / 丢包色块读取这个任务，每台服务器只能选一个"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Text size="1" color={effectiveHomeId === task.id ? 'blue' : 'gray'}>首页显示</Text>
                        <Switch
                          size="1"
                          checked={effectiveHomeId === task.id}
                          disabled={!homeLoaded}
                          onCheckedChange={(on) => toggleHome(task.id, on)}
                        />
                      </label>
                    )}
                  </Flex>
                </Box>
              );
            })}
          </Flex>
        </Flex>

        <Flex gap="3" justify="between" align="center" mt="4">
          <Text size="1" color="gray">{changed > 0 ? `待保存 ${changed} 项改动` : '未作改动'}</Text>
          <Flex gap="3">
            <Button variant="soft" onClick={onClose}>取消</Button>
            <Button onClick={handleSave} disabled={saving || changed === 0}>{saving ? '保存中...' : '保存'}</Button>
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function TaskRow({
  task,
  boundNames,
  onEdit,
  onDelete,
  dragDisabled,
}: {
  task: PingTask;
  boundNames: string;
  onEdit: (task: PingTask) => void;
  onDelete: (task: PingTask) => void;
  dragDisabled: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled: dragDisabled });

  const rowStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    position: 'relative',
    zIndex: isDragging ? 2 : undefined,
  } as CSSProperties;

  const scopeTitle = task.all_clients ? '默认应用到全部服务器' : (boundNames || '未分配服务器，暂不运行');

  return (
    <tr ref={setNodeRef} style={rowStyle} className={`sa-tr admin-ping-task-row${isDragging ? ' is-dragging' : ''}`}>
      <td className="sa-td-narrow">
        <button
          type="button"
          className="admin-row-drag-handle"
          title={dragDisabled ? '清除搜索 / 范围筛选后可拖拽排序' : '拖拽排序'}
          aria-label={`拖拽排序 ${task.name}`}
          disabled={dragDisabled}
          {...attributes}
          {...listeners}
        >
          <Grip size={15} />
        </button>
      </td>
      <td className="sa-td-name">
        <span className="sa-ellipsis admin-ping-task-name" title={task.name}>{task.name}</span>
      </td>
      <td><SaBadge variant="secondary">{task.type.toUpperCase()}</SaBadge></td>
      <td><span className="sa-mono sa-ellipsis admin-ping-target" title={task.target}>{task.target}</span></td>
      <td className="sa-col-md"><span className="sa-muted">{task.interval_sec ? `${task.interval_sec} 秒` : '-'}</span></td>
      <td>
        <span className="sa-scope-cell" title={scopeTitle}>
          {task.all_clients ? (
            <SaBadge variant="secondary">所有服务器</SaBadge>
          ) : isUnboundTask(task) ? (
            <SaBadge variant="warning">未分配</SaBadge>
          ) : (
            <>
              <SaBadge variant="outline">{task.clients?.length || 0} 台</SaBadge>
              <span className="sa-ellipsis sa-muted admin-ping-task-scope">{boundNames}</span>
            </>
          )}
        </span>
      </td>
      <td className="sa-td-actions">
        <span className="admin-row-actions">
          <button type="button" className="admin-icon-button admin-row-action" aria-label={`编辑 ${task.name}`} title="编辑" onClick={() => onEdit(task)}>
            <Pencil size={14} />
          </button>
          <button type="button" className="admin-icon-button admin-row-action admin-row-action-danger" aria-label={`删除 ${task.name}`} title="删除" onClick={() => onDelete(task)}>
            <Trash2 size={14} />
          </button>
        </span>
      </td>
    </tr>
  );
}

export default function AdminPingTasks() {
  const apiFetch = useApi();
  const { run: runAction, pendingActions } = useAdminAction();
  const [tasks, setTasks] = useState<PingTask[]>([]);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<PingTask | null>(null);
  const [deleteTask, setDeleteTask] = useState<PingTask | null>(null);
  const [viewMode, setViewMode] = useState<TaskViewMode>('task');
  const [taskSearch, setTaskSearch] = useState('');
  const [serverSearch, setServerSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState<TaskScopeFilter>('all');
  const [assignClient, setAssignClient] = useState<ClientLite | null>(null);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setLoadError(null);
    try {
      const tasksData = await apiFetch('/admin/ping');
      if (Array.isArray(tasksData)) setTasks(tasksData);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ping 任务加载失败';
      setLoadError(message);
      toast.error(message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [apiFetch]);

  const taskOrderRef = useRef(0);
  // 拖拽范围 = 任务列表主体（拖拽开始时测一次）。把被拖的行夹在里面，否则它会撑大外层可滚动的 Card，
  // 触发 dnd-kit 自动滚动并越滚越长（无限下拉）。
  const taskBodyRef = useRef<HTMLTableSectionElement | null>(null);
  const taskDragBoundsRef = useRef<DragBounds | null>(null);
  const taskDragModifiers = useMemo(() => [lockXClampYToBounds(() => taskDragBoundsRef.current)], []);
  const handleTaskDragStart = useCallback(() => {
    const rect = taskBodyRef.current?.getBoundingClientRect();
    taskDragBoundsRef.current = rect ? { top: rect.top, bottom: rect.bottom } : null;
  }, []);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 拉取服务器列表并按后台「服务器」页的手动顺序排好；任务分配弹窗、服务器视图都用这一份顺序。
  const refreshClients = useCallback(async () => {
    try {
      const clientsData = await apiFetch('/admin/clients');
      if (Array.isArray(clientsData)) {
        setClients(sortClientsByAdminOrder(clientsData as ClientLite[]));
        setClientsLoaded(true);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '服务器列表加载失败');
    }
  }, [apiFetch]);

  const ensureClients = useCallback(async () => {
    if (clientsLoaded) return;
    await refreshClients();
  }, [clientsLoaded, refreshClients]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 每次切到服务器视图都重新拉一次，这样在「服务器」页调整过的顺序能马上同步过来。
  useEffect(() => {
    if (viewMode === 'server') void refreshClients();
  }, [refreshClients, viewMode]);

  // 进入页面就加载服务器列表：任务作用域、按下方的搜索框们一开始就能显示昵称而非 UUID。
  useEffect(() => {
    void ensureClients();
  }, [ensureClients]);

  const scopedTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (scopeFilter === 'global' && !task.all_clients) return false;
      if (scopeFilter === 'selected' && task.all_clients) return false;
      if (scopeFilter === 'unbound' && !isUnboundTask(task)) return false;
      return true;
    });
  }, [tasks, scopeFilter]);

  const filteredTasks = useMemo(() => {
    const query = taskSearch.trim().toLowerCase();
    return scopedTasks.filter((task) => {
      if (!query) return true;

      return [
        task.name,
        task.type,
        task.target,
        getTaskScopeLabel(task, clients),
      ].join(' ').toLowerCase().includes(query);
    });
  }, [scopedTasks, clients, taskSearch]);

  // “未分配”本身不属于任何服务器，服务器视图在该筛选下仍显示每台服务器的实际任务。
  const serverScopedTasks = scopeFilter === 'unbound' ? tasks : scopedTasks;

  const serverRows = useMemo(() => {
    return clients.map((client) => ({
      client,
      boundTasks: serverScopedTasks.filter((task) => task.all_clients || task.clients?.includes(client.uuid)),
    }));
  }, [clients, serverScopedTasks]);

  const filteredServerRows = useMemo(() => {
    const query = serverSearch.trim().toLowerCase();
    if (!query) return serverRows;

    return serverRows.filter(({ client, boundTasks }) => [
      client.name,
      client.group,
      client.region,
      ...boundTasks.flatMap((task) => [task.name, task.type, task.target]),
    ].filter(Boolean).join(' ').toLowerCase().includes(query));
  }, [serverRows, serverSearch]);

  const globalTaskCount = tasks.filter((task) => task.all_clients).length;
  const unboundTaskCount = tasks.filter(isUnboundTask).length;
  const selectedTaskCount = tasks.length - globalTaskCount - unboundTaskCount;
  const activeSearch = viewMode === 'task' ? taskSearch : serverSearch;
  const currentResultCount = viewMode === 'task' ? filteredTasks.length : filteredServerRows.length;

  const openAdd = () => {
    setEditingTask(null);
    setDialogOpen(true);
    void ensureClients();
  };

  const openAssign = (client: ClientLite) => {
    setAssignClient(client);
  };

  const mergeUpdatedTasks = (updated: PingTask[]) => {
    if (updated.length === 0) return;
    setTasks((current) => current.map((item) => updated.find((task) => task.id === item.id) ?? item));
  };

  const openEdit = (task: PingTask) => {
    setEditingTask(task);
    setDialogOpen(true);
    void ensureClients();
  };

  const handleDelete = () => runAction('ping:delete', async () => {
    if (!deleteTask) return;
    const result = await apiFetch('/admin/ping/delete', {
      method: 'POST',
      body: JSON.stringify({ id: deleteTask.id }),
    });
    if (result.success) {
      toast.success('删除成功');
      const deletedId = deleteTask.id;
      setDeleteTask(null);
      setTasks((current) => current.filter((task) => task.id !== deletedId));
    } else {
      toast.error(result.error || '删除失败');
    }
  });

  // 有搜索 / 范围筛选时列表只是任务的子集，拖拽结果无法对应完整顺序，因此暂停拖拽（与「服务器」页一致）。
  const taskDragDisabled = Boolean(taskSearch.trim()) || scopeFilter !== 'all';

  const handleTaskDragEnd = async (event: DragEndEvent) => {
    taskDragBoundsRef.current = null;
    const { active, over } = event;
    if (!over || active.id === over.id || taskDragDisabled) return;

    const oldIndex = tasks.findIndex((item) => item.id === active.id);
    const newIndex = tasks.findIndex((item) => item.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const previousTasks = tasks;
    const nextTasks = arrayMove(tasks, oldIndex, newIndex);
    const request = ++taskOrderRef.current;
    setTasks(nextTasks);

    try {
      const result = await apiFetch('/admin/ping/reorder', {
        method: 'POST',
        body: JSON.stringify({ ids: nextTasks.map((item) => item.id) }),
      });
      // 连续拖拽时只认最后一次请求的结果，较早请求的回包不再回滚 / 提示。
      if (taskOrderRef.current !== request) return;

      if (result.success) {
        toast.success('排序已更新');
      } else {
        toast.error(result.error || '排序失败');
        setTasks(previousTasks);
        void loadData(true);
      }
    } catch (error) {
      if (taskOrderRef.current !== request) return;
      toast.error(error instanceof Error ? error.message : '排序失败');
      setTasks(previousTasks);
      void loadData(true);
    }
  };

  if (loading) return <Loading />;

  return (
    <div className="sa-scope admin-ping-page admin-dashboard-page">
      <div className="admin-parent-title-row">
        <div className="sa-page-title">
          <Activity size={20} />
          <span>延迟监测</span>
        </div>
      </div>

      {loadError && (
        <div className="sa-alert" role="alert">
          <span>{loadError}</span>
          <SaButton variant="outline" size="sm" onClick={() => void loadData()}>重试</SaButton>
        </div>
      )}

      <StatGrid
        label="延迟监测概览"
        items={[
          { label: '任务总数', value: String(tasks.length), detail: `当前结果 ${currentResultCount}`, icon: <Activity /> },
          { label: '全局任务', value: String(globalTaskCount), detail: '默认应用到全部服务器', icon: <Globe /> },
          { label: '定向任务', value: String(selectedTaskCount), detail: '只在指定服务器运行', icon: <Server /> },
          { label: '未分配', value: String(unboundTaskCount), detail: unboundTaskCount > 0 ? '尚未绑定服务器，暂不运行' : '没有闲置任务', icon: <Unlink /> },
        ]}
      />

      <SaCard className="admin-ping-panel">
        <div className="sa-toolbar admin-ping-filter-toolbar">
          <div className="sa-toolbar-group">
            <Segmented
              label="视图"
              value={viewMode}
              onChange={(value) => setViewMode(value as TaskViewMode)}
              options={[{ value: 'task', label: '任务视图' }, { value: 'server', label: '服务器视图' }]}
            />
            <div className="sa-search">
              <Search size={14} aria-hidden="true" />
              <input
                className="sa-input admin-ping-search"
                placeholder={viewMode === 'task' ? '搜索任务' : '搜索服务器'}
                aria-label={viewMode === 'task' ? '搜索任务' : '搜索服务器'}
                value={activeSearch}
                onChange={(event) => {
                  if (viewMode === 'task') {
                    setTaskSearch(event.target.value);
                  } else {
                    setServerSearch(event.target.value);
                  }
                }}
              />
            </div>
            <select
              className="sa-input sa-select admin-ping-scope-select"
              aria-label="范围筛选"
              value={scopeFilter}
              onChange={(event) => setScopeFilter(event.target.value as TaskScopeFilter)}
            >
              <option value="all">全部范围</option>
              <option value="global">全局任务</option>
              <option value="selected">定向任务</option>
              <option value="unbound">未分配</option>
            </select>
          </div>
          <div className="sa-toolbar-group">
            <SaButton size="sm" onClick={openAdd}><Plus size={16} /> 添加任务</SaButton>
          </div>
        </div>

        {viewMode === 'task' ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={taskDragModifiers}
            onDragStart={handleTaskDragStart}
            onDragCancel={() => { taskDragBoundsRef.current = null; }}
            onDragEnd={handleTaskDragEnd}
          >
            <div className="sa-table-scroll">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th className="sa-td-narrow" aria-label="排序" />
                    <th>名称</th>
                    <th>类型</th>
                    <th>目标</th>
                    <th className="sa-col-md">间隔</th>
                    <th>应用范围</th>
                    <th className="sa-td-actions">操作</th>
                  </tr>
                </thead>
                <tbody ref={taskBodyRef}>
                  <SortableContext items={filteredTasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
                    {filteredTasks.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="sa-empty">
                          {taskSearch || scopeFilter !== 'all' ? '没有匹配的 Ping 任务' : '暂无 Ping 任务'}
                        </td>
                      </tr>
                    ) : (
                      filteredTasks.map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          boundNames={getTaskScopeLabel(task, clients)}
                          onEdit={openEdit}
                          onDelete={setDeleteTask}
                          dragDisabled={taskDragDisabled}
                        />
                      ))
                    )}
                  </SortableContext>
                </tbody>
              </table>
            </div>
          </DndContext>
        ) : (
          <div className="sa-table-scroll">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>服务器</th>
                  <th className="sa-col-md">分组</th>
                  <th>任务</th>
                  <th className="sa-td-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredServerRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="sa-empty">
                      {serverSearch || scopeFilter !== 'all' ? '没有匹配的服务器' : '暂无服务器'}
                    </td>
                  </tr>
                ) : (
                  filteredServerRows.map(({ client, boundTasks }) => (
                    <tr className="sa-tr admin-ping-server-row" key={client.uuid}>
                      <td className="sa-td-server">
                        <div className="sa-name-cell">
                          <span className="sa-ellipsis admin-ping-server-name" title={client.name}>{client.name}</span>
                          {client.region && <SaBadge variant="outline">{client.region}</SaBadge>}
                        </div>
                      </td>
                      <td className="sa-col-md"><span className="sa-muted">{client.group || '未分组'}</span></td>
                      <td>
                        <div className="sa-chips">
                          {boundTasks.length > 0 ? (
                            <>
                              <span className="sa-chip-count">{boundTasks.length} 项</span>
                              {boundTasks.map((task) => (
                                <SaBadge
                                  key={task.id}
                                  variant={task.all_clients ? 'secondary' : 'outline'}
                                  title={`${task.name} / ${task.type.toUpperCase()} / ${task.target}`}
                                >
                                  {task.name}
                                </SaBadge>
                              ))}
                            </>
                          ) : (
                            <span className="sa-muted">暂无匹配任务</span>
                          )}
                        </div>
                      </td>
                      <td className="sa-td-actions">
                        <SaButton variant="outline" size="sm" onClick={() => openAssign(client)} aria-label={`分配 ${client.name} 的监控任务`}>
                          <ListChecks size={14} /> 分配任务
                        </SaButton>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="sa-table-footer">当前 {currentResultCount} 项</div>
      </SaCard>

      <TaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        clients={clients}
        editingTask={editingTask}
        onSaved={(task) => {
          if (!task) {
            loadData();
            return;
          }
          setTasks((current) => {
            const exists = current.some((item) => item.id === task.id);
            return exists
              ? current.map((item) => item.id === task.id ? task : item)
              : [...current, task].sort((a, b) => (a.sort_order || a.id || 0) - (b.sort_order || b.id || 0));
          });
        }}
      />

      <NodeTasksDialog
        client={assignClient}
        tasks={tasks}
        onClose={() => setAssignClient(null)}
        onSaved={mergeUpdatedTasks}
      />

      <ConfirmDialog
        open={Boolean(deleteTask)}
        onOpenChange={(open) => { if (!open) setDeleteTask(null); }}
        title="删除 Ping 任务"
        description={<>确定删除 <strong>{deleteTask?.name}</strong> 吗？相关 Ping 记录也会被清理。</>}
        confirmLabel="确认删除"
        destructive
        keepOpenOnConfirm
        confirmDisabled={pendingActions.has('ping:delete')}
        onConfirm={() => { void handleDelete(); }}
      />
    </div>
  );
}
