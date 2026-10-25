import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Dialog,
  Flex,
  Grid,
  Heading,
  Select,
  Switch,
  Table,
  Tabs,
  Text,
  TextField,
} from '@radix-ui/themes';
import { Activity, ArrowDown, ArrowUp, ListChecks, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { useAdminAction } from '../../hooks/useAdminAction';

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
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  task: PingTask;
  boundNames: string;
  onEdit: (task: PingTask) => void;
  onDelete: (task: PingTask) => void;
  onMove: (task: PingTask, direction: 'up' | 'down') => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  return (
    <Table.Row>
      <Table.Cell>
        <Flex direction="column" gap="1">
          <Text size="2" weight="bold">{task.name}</Text>
          <Text
            className="admin-ping-task-scope"
            size="1"
            color="gray"
            title={task.all_clients ? '默认应用到全部服务器' : (boundNames || '未分配服务器，暂不运行')}
          >
            {task.all_clients ? '默认应用到全部服务器' : (boundNames || '未分配服务器，暂不运行')}
          </Text>
        </Flex>
      </Table.Cell>
      <Table.Cell><Badge variant="soft">{task.type.toUpperCase()}</Badge></Table.Cell>
      <Table.Cell><Text size="1" style={{ fontFamily: 'monospace' }}>{task.target}</Text></Table.Cell>
      <Table.Cell>
        {task.all_clients ? (
          <Badge color="green">所有服务器</Badge>
        ) : isUnboundTask(task) ? (
          <Badge color="amber" variant="soft">未分配</Badge>
        ) : (
          <Badge color="blue" variant="soft">{task.clients?.length || 0} 台服务器</Badge>
        )}
      </Table.Cell>
      <Table.Cell>
        <Flex gap="1" wrap="nowrap" style={{ whiteSpace: 'nowrap' }}>
          <Button size="1" variant="soft" onClick={() => onMove(task, 'up')} disabled={!canMoveUp} title="上移" aria-label={`上移 ${task.name}`}>
            <ArrowUp size={13} />
          </Button>
          <Button size="1" variant="soft" onClick={() => onMove(task, 'down')} disabled={!canMoveDown} title="下移" aria-label={`下移 ${task.name}`}>
            <ArrowDown size={13} />
          </Button>
          <Button size="1" variant="soft" onClick={() => onEdit(task)}>
            <Pencil size={13} /> 编辑
          </Button>
          <Button size="1" variant="soft" color="red" onClick={() => onDelete(task)}>
            <Trash2 size={13} /> 删除
          </Button>
        </Flex>
      </Table.Cell>
    </Table.Row>
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

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const tasksData = await apiFetch('/admin/ping');
      if (Array.isArray(tasksData)) setTasks(tasksData);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ping 任务加载失败';
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  const ensureClients = useCallback(async () => {
    if (clientsLoaded) return;
    try {
      const clientsData = await apiFetch('/admin/clients');
      if (Array.isArray(clientsData)) {
        setClients(clientsData);
        setClientsLoaded(true);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '服务器列表加载失败');
    }
  }, [apiFetch, clientsLoaded]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (viewMode === 'server') void ensureClients();
  }, [ensureClients, viewMode]);

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

  const moveTask = async (task: PingTask, direction: 'up' | 'down') => {
    const currentIndex = tasks.findIndex((item) => item.id === task.id);
    if (currentIndex < 0) return;
    const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (nextIndex < 0 || nextIndex >= tasks.length) return;

    const nextTasks = [...tasks];
    [nextTasks[currentIndex], nextTasks[nextIndex]] = [nextTasks[nextIndex], nextTasks[currentIndex]];
    setTasks(nextTasks);

    try {
      const result = await apiFetch('/admin/ping/reorder', {
        method: 'POST',
        body: JSON.stringify({ ids: nextTasks.map((item) => item.id) }),
      });

      if (result.success) {
        toast.success('排序已更新');
      } else {
        toast.error(result.error || '排序失败');
        loadData();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '排序失败');
      loadData();
    }
  };

  if (loading) return <Loading />;

  return (
    <Flex className="admin-ping-page" direction="column" gap="2">
      {loadError && <Flex align="center" gap="2"><Text color="red" role="alert">{loadError}</Text><Button size="1" variant="soft" onClick={() => void loadData()}>重试</Button></Flex>}
      <Flex className="admin-parent-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2">
          <Activity size={20} />
          <Heading size="5">延迟监测</Heading>
          <Badge size="1" variant="soft" color="gray">{tasks.length} 个任务</Badge>
        </Flex>
      </Flex>

      <Flex className="admin-subnav-action-row" justify="between" align="center" wrap="wrap" gap="3">
        <Tabs.Root value={viewMode} onValueChange={(value) => setViewMode(value as TaskViewMode)}>
          <Tabs.List className="admin-subnav-row">
            <Tabs.Trigger value="task">任务视图</Tabs.Trigger>
            <Tabs.Trigger value="server">服务器视图</Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>
        <Button onClick={openAdd}><Plus size={16} /> 添加任务</Button>
      </Flex>

      <Card>
        <div className="admin-ping-filter-toolbar">
          <div className="admin-ping-filter-top-row">
            <TextField.Root
              className="admin-ping-search"
              placeholder={viewMode === 'task' ? '搜索任务' : '搜索服务器'}
              value={activeSearch}
              onChange={(event) => {
                if (viewMode === 'task') {
                  setTaskSearch(event.target.value);
                } else {
                  setServerSearch(event.target.value);
                }
              }}
            >
              <TextField.Slot><Search size={14} /></TextField.Slot>
            </TextField.Root>

            <Select.Root value={scopeFilter} onValueChange={(value) => setScopeFilter(value as TaskScopeFilter)}>
              <Select.Trigger className="admin-ping-scope-select" />
              <Select.Content>
                <Select.Item value="all">全部范围</Select.Item>
                <Select.Item value="global">全局任务</Select.Item>
                <Select.Item value="selected">定向任务</Select.Item>
                <Select.Item value="unbound">未分配</Select.Item>
              </Select.Content>
            </Select.Root>

            <Flex className="admin-ping-filter-stats" gap="2" wrap="wrap" align="center">
              <Badge variant="soft" color="blue">当前结果 {currentResultCount}</Badge>
              <Badge variant="soft" color="green">全局 {globalTaskCount}</Badge>
              <Badge variant="soft" color="amber">定向 {selectedTaskCount}</Badge>
              {unboundTaskCount > 0 && <Badge variant="soft" color="gray">未分配 {unboundTaskCount}</Badge>}
            </Flex>
          </div>
        </div>
      </Card>

      {viewMode === 'task' ? (
        <Card style={{ overflowX: 'auto' }}>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>名称</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>类型</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>目标</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>应用范围</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell width="220px">操作</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {filteredTasks.length === 0 ? (
                <Table.Row>
                  <Table.Cell colSpan={5}>
                    <Text color="gray" align="center" style={{ display: 'block', padding: 24 }}>
                      {taskSearch || scopeFilter !== 'all' ? '没有匹配的 Ping 任务' : '暂无 Ping 任务'}
                    </Text>
                  </Table.Cell>
                </Table.Row>
              ) : (
                filteredTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    boundNames={getTaskScopeLabel(task, clients)}
                    onEdit={openEdit}
                    onDelete={setDeleteTask}
                    onMove={moveTask}
                    canMoveUp={tasks.findIndex((item) => item.id === task.id) > 0}
                    canMoveDown={tasks.findIndex((item) => item.id === task.id) < tasks.length - 1}
                  />
                ))
              )}
            </Table.Body>
          </Table.Root>
        </Card>
      ) : (
        <div className="admin-ping-server-grid">
          {filteredServerRows.length === 0 ? (
            <div className="admin-ping-server-empty">
              <Text color="gray">
                {serverSearch || scopeFilter !== 'all' ? '没有匹配的服务器' : '暂无服务器'}
              </Text>
            </div>
          ) : (
            filteredServerRows.map(({ client, boundTasks }) => (
              <div className="admin-ping-server-card" key={client.uuid}>
                <Flex className="admin-ping-server-card-head" justify="between" align="start" gap="2" wrap="wrap">
                  <Box className="admin-ping-server-main">
                    <Text className="admin-ping-server-name" size="2" weight="bold" title={client.name}>
                      {client.name}
                    </Text>
                    <Flex className="admin-ping-server-meta" gap="1" wrap="wrap" align="center">
                      <Badge size="1" variant="soft" color="gray">{client.group || '未分组'}</Badge>
                      {client.region ? (
                        <Badge size="1" variant="soft">{client.region}</Badge>
                      ) : (
                        <Text size="1" color="gray">无区域</Text>
                      )}
                    </Flex>
                  </Box>
                  <Flex className="admin-ping-server-actions" align="center" gap="2">
                    <Badge className="admin-ping-server-count" size="1" variant="soft" color={boundTasks.length > 0 ? 'blue' : 'gray'}>
                      {boundTasks.length} 项
                    </Badge>
                    <Button size="1" variant="soft" onClick={() => openAssign(client)} aria-label={`分配 ${client.name} 的监控任务`}>
                      <ListChecks size={13} /> 分配任务
                    </Button>
                  </Flex>
                </Flex>

                <div className="admin-ping-server-task-list">
                  {boundTasks.length > 0 ? boundTasks.map((task) => (
                    <Badge
                      className="admin-ping-server-task-chip"
                      key={task.id}
                      size="1"
                      variant="soft"
                      color={task.all_clients ? 'green' : 'blue'}
                      title={`${task.name} / ${task.type.toUpperCase()} / ${task.target}`}
                    >
                      {task.name}
                    </Badge>
                  )) : (
                    <Text size="1" color="gray">暂无匹配任务</Text>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
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

      <Dialog.Root open={Boolean(deleteTask)} onOpenChange={(open) => !open && setDeleteTask(null)}>
        <Dialog.Content aria-describedby={undefined} style={{ maxWidth: 420 }}>
          <Dialog.Title>删除 Ping 任务</Dialog.Title>
          <Text size="2">
            确定删除 <strong>{deleteTask?.name}</strong> 吗？相关 Ping 记录也会被清理。
          </Text>
          <Flex gap="3" justify="end" mt="4">
            <Button variant="soft" onClick={() => setDeleteTask(null)}>取消</Button>
            <Button color="red" onClick={handleDelete} disabled={pendingActions.has('ping:delete')}>确认删除</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Flex>
  );
}
