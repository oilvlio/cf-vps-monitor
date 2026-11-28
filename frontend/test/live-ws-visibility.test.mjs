import assert from 'node:assert/strict';
import test from 'node:test';
import { productionEffect } from './helpers/production-module.mjs';
import { LIVE_WS_HIDDEN_CLOSE_MS, getLiveWsReconnectDelay, isLiveWsCircuitOpen, shouldReconnectLiveWebSocket } from '../src/contexts/livePolling.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture({ hidden = false, tokenGate } = {}) {
  const document = Object.assign(new EventTarget(), { hidden });
  const window = Object.assign(new EventTarget(), { location: { origin: 'https://fixture.test' } });
  const timers = new Map();
  const sockets = [];
  let nextTimer = 0;
  let tokenReads = 0;
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    constructor() { super(); sockets.push(this); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const refs = {
    reconnectTimeoutRef: { current: null }, initialSnapshotTimeoutRef: { current: null },
    hiddenCloseTimeoutRef: { current: null }, wsRef: { current: null },
    wsOpenRef: { current: false }, wsFailStreakRef: { current: 0 },
  };
  const cleanup = productionEffect('src/contexts/LiveDataContext.tsx', 'let connectionRequest = 0', {
    authLoading: false, enabled: true, viewer: true, includeHidden: false,
    document, window, WebSocket: Socket, ...refs,
    liveScopeRef: { current: { active: true, hasSnapshot: false } },
    setLoading() {}, setError() {}, fetchLiveData() {},
    getCachedPublicBootstrap: () => null, normalizeLiveDataResponse: () => null,
    normalizeViewerTokenResponse: value => value,
    fetch: async () => { tokenReads++; await tokenGate; return Response.json({ token: 'fixture' }); },
    buildLiveWebSocketUrl: () => 'wss://fixture.test/api/ws/live', buildLiveWebSocketProtocols: () => [],
    LIVE_WS_HIDDEN_CLOSE_MS, LIVE_WS_INITIAL_SNAPSHOT_TIMEOUT_MS: 4000,
    shouldReconnectLiveWebSocket, getLiveWsReconnectDelay, isLiveWsCircuitOpen,
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  })();
  return {
    refs, sockets, timers, cleanup, get tokenReads() { return tokenReads; },
    visibility(hidden) { document.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); },
    fireHiddenClose() {
      const id = refs.hiddenCloseTimeoutRef.current;
      assert.ok(timers.has(id));
      const timer = timers.get(id);
      timers.delete(id);
      assert.equal(timer.delay, LIVE_WS_HIDDEN_CLOSE_MS);
      timer.callback();
    },
  };
}

test('a hidden viewer closes after 45s without recording a failure and reconnects when visible', async () => {
  const f = fixture();
  try {
    await settle();
    assert.equal(f.sockets.length, 1);
    f.visibility(true);
    f.fireHiddenClose();
    assert.equal(f.sockets[0].readyState, 3);
    assert.equal(f.refs.wsRef.current, null);
    assert.equal(f.refs.wsFailStreakRef.current, 0);
    assert.equal(f.refs.reconnectTimeoutRef.current, null);
    f.visibility(false);
    await settle();
    assert.equal(f.sockets.length, 2);
  } finally { f.cleanup(); }
});

test('returning before the hidden deadline cancels closure and cleanup removes timers', async () => {
  const f = fixture();
  await settle();
  f.visibility(true);
  const timer = f.refs.hiddenCloseTimeoutRef.current;
  f.visibility(true);
  assert.equal(f.refs.hiddenCloseTimeoutRef.current, timer, 'repeated hidden events cannot extend the deadline');
  f.visibility(false);
  assert.equal(f.timers.has(timer), false);
  assert.equal(f.sockets[0].readyState, 1);
  f.visibility(true);
  f.cleanup();
  assert.equal(f.timers.size, 0);
});

test('an initially hidden page waits until visible before acquiring a viewer connection', async () => {
  const f = fixture({ hidden: true });
  try {
    await settle();
    assert.equal(f.tokenReads, 0);
    assert.equal(f.sockets.length, 0);
    f.visibility(false);
    await settle();
    assert.equal(f.sockets.length, 1);
  } finally { f.cleanup(); }
});

test('a delayed token response cannot create a connection after the hidden deadline', async () => {
  const gate = Promise.withResolvers();
  const f = fixture({ tokenGate: gate.promise });
  try {
    f.visibility(true);
    f.fireHiddenClose();
    gate.resolve();
    await settle();
    assert.equal(f.sockets.length, 0);
    f.visibility(false);
    await settle();
    assert.equal(f.sockets.length, 1);
  } finally { f.cleanup(); }
});
