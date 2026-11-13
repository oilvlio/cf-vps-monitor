#!/usr/bin/env node
/**
 * 刷新 monitor 契约的形状黄金样本。
 *
 * 用法一：从一个运行中的 monitor hub 录制（推荐，最贴近真实序列化）
 *   node scripts/refresh-monitor-golden.mjs --from-hub-url http://127.0.0.1:8080
 *
 * 用法二：从已录制的原始响应快照生成（themes 仓库 preview/hub.js 或线上 hub）
 *   node scripts/refresh-monitor-golden.mjs --from-capture ./capture.json
 *   capture.json: { "me": {...}, "nodes": {...}, "metrics": {...}, "ping": {...} }
 *
 * 只抽取「形状」：键集合、值类型、必填/可选。具体数值不写入 golden。
 * 更新形状后必须同步更新 worker/test-support/monitor-golden/GOLDEN_SOURCE 的 pin。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const goldenPath = path.join(root, 'worker/test-support/monitor-golden/hub-golden.json');

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeSet(values) {
  const types = [...new Set(values.map(typeOf))].sort();
  return types.length === 1 ? types[0] : types;
}

/** 从一组对象里抽取键集合 + 类型；keys 缺失于部分对象时记为可选。 */
function shapeOfObjects(objects) {
  const present = new Map();
  for (const object of objects) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue;
    for (const [key, value] of Object.entries(object)) {
      if (!present.has(key)) present.set(key, []);
      present.get(key).push(value);
    }
  }
  const keys = [...present.keys()];
  const types = {};
  const optional = [];
  for (const key of keys) {
    types[key] = typeSet(present.get(key));
    if (present.get(key).length < objects.length) optional.push(key);
  }
  return { keys, types, optional };
}

function pickRows(body) {
  const metrics = Array.isArray(body?.metrics) ? body.metrics : [];
  const ping = Array.isArray(body?.ping) ? body.ping : [];
  return { metrics, ping };
}

function buildEndpoints({ me, nodesBody, metricsBody, pingBody }) {
  const nodes = Array.isArray(nodesBody?.nodes) ? nodesBody.nodes : [];
  const online = nodes.filter(node => node?.online === true);
  const sample = online.length > 0 ? online : nodes;
  const liveMetrics = sample.map(node => node?.metrics).filter(Boolean);

  const { metrics: metricRows, ping: pingRowsMixed } = pickRows(metricsBody);
  const { ping: pingRows } = pickRows(pingBody);
  const pingRowsAll = pingRows.length > 0 ? pingRows : pingRowsMixed;
  const wsFrame = { nodes: [], admin: Boolean(nodesBody?.admin) };

  const nodeShape = shapeOfObjects(sample);
  const nodeMetricsShape = shapeOfObjects(liveMetrics);

  return {
    me: shapeOfObjects([me ?? {}]),
    node: nodeShape,
    nodeMetrics: {
      ...nodeMetricsShape,
      // hub 的 metrics 里 load 只在 agent 上报时存在。
      optional: nodeMetricsShape.optional,
    },
    metricsEnvelope: {
      keys: ['metrics', 'ping', 'probes', 'loss', 'step'],
      types: {
        metrics: 'array',
        ping: 'array',
        probes: 'object',
        loss: 'object',
        step: 'number',
      },
    },
    metricsRow: { ...shapeOfObjects(metricRows.slice(0, 50)), optional: [] },
    pingRow: {
      ...shapeOfObjects(pingRowsAll.slice(0, 50)),
      required: ['task_id', 'ts', 'latency'],
    },
    wsFrame: shapeOfObjects([wsFrame]),
    themeConfig: { type: 'object' },
  };
}

async function fromHubUrl(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const get = async (pathname) => {
    const response = await fetch(`${base}${pathname}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}`);
    return response.json();
  };

  const me = await get('/api/me');
  const nodesBody = await get('/api/nodes');
  const nodes = Array.isArray(nodesBody?.nodes) ? nodesBody.nodes : [];
  const candidate = nodes.find(node => node?.online === true) ?? nodes[0];
  if (!candidate || !Number.isInteger(candidate.id)) {
    throw new Error('hub 没有可用的整数 id 节点，无法录制 metrics');
  }
  const metricsBody = await get(`/api/nodes/${candidate.id}/metrics?hours=6&points=1440`);
  const pingBody = await get(`/api/nodes/${candidate.id}/metrics?hours=6&points=1440&series=ping`);
  return { me, nodesBody, metricsBody, pingBody };
}

async function fromCapture(file) {
  const capture = JSON.parse(await readFile(path.resolve(file), 'utf8'));
  const me = capture.me ?? {};
  const nodesBody = capture.nodes ?? capture.nodesBody ?? {};
  const metricsBody = capture.metrics ?? capture.metricsBody ?? {};
  const pingBody = capture.ping ?? {};
  return { me, nodesBody, metricsBody, pingBody };
}

function mergeGolden(previous, endpoints) {
  return {
    contractVersion: previous.contractVersion,
    generatedFrom: previous.generatedFrom,
    sourcePin: previous.sourcePin,
    notes: previous.notes,
    endpoints,
    invariants: previous.invariants,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const hubUrlIndex = args.indexOf('--from-hub-url');
  const captureIndex = args.indexOf('--from-capture');
  if (hubUrlIndex === -1 && captureIndex === -1) {
    console.error('用法：node scripts/refresh-monitor-golden.mjs --from-hub-url <url> | --from-capture <file>');
    process.exit(1);
  }

  const previous = JSON.parse(await readFile(goldenPath, 'utf8'));
  const captured = hubUrlIndex !== -1
    ? await fromHubUrl(args[hubUrlIndex + 1])
    : await fromCapture(args[captureIndex + 1]);

  const endpoints = buildEndpoints(captured);
  const merged = mergeGolden(previous, endpoints);
  await writeFile(goldenPath, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`已刷新 ${path.relative(root, goldenPath)}`);
  console.log(`  node keys:      ${endpoints.node.keys.length}`);
  console.log(`  metrics keys:   ${endpoints.nodeMetrics.keys.length}`);
  console.log(`  metricsRow:     ${endpoints.metricsRow.keys.length}`);
  console.log(`  pingRow:        ${endpoints.pingRow.keys.length}`);
}

await main();
