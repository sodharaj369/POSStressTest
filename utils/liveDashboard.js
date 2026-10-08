'use strict';

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { getRunDir } = require('./runArtifacts');

function nowIso() {
  return new Date().toISOString();
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>POS Live Dashboard</title>
  <style>
    :root {
      --bg: #0b1320;
      --card: #111b2e;
      --text: #e5edf7;
      --muted: #93a5c1;
      --ok: #22c55e;
      --warn: #f59e0b;
      --bad: #ef4444;
      --line: #1f2c45;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      background: radial-gradient(1200px 600px at 20% -10%, #1a2b4a 0%, var(--bg) 55%);
      color: var(--text);
    }
    .wrap {
      max-width: 1180px;
      margin: 20px auto;
      padding: 0 14px;
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    h1 { margin: 0; font-size: 22px; letter-spacing: .2px; }
    .status { color: var(--muted); font-size: 13px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .card {
      background: linear-gradient(180deg, #13213a 0%, var(--card) 100%);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
    }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .3px; }
    .value { font-size: 28px; font-weight: 700; margin-top: 6px; }
    .good { color: var(--ok); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .info { color: #60a5fa; }
    .feed {
      background: #0f1a2d;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      max-height: 420px;
      overflow: auto;
    }
    .ev {
      border-bottom: 1px dashed #223350;
      padding: 8px 2px;
      font-size: 14px;
      line-height: 1.35;
    }
    .ev:last-child { border-bottom: 0; }
    .t { color: #8fb1de; font-size: 12px; margin-right: 8px; }
    .type { font-weight: 700; margin-right: 6px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1>ParentPay POS Live Dashboard</h1>
      <div class="status" id="conn">Connecting...</div>
    </div>

    <div class="grid">
      <div class="card"><div class="label">Current Cycle</div><div class="value" id="currentCycle">0</div></div>
      <div class="card"><div class="label">Orders / Minute</div><div class="value" id="opm">0.0</div></div>
      <div class="card"><div class="label">Elapsed</div><div class="value" id="elapsedText">0m 0s</div></div>
      <div class="card"><div class="label">Total Run</div><div class="value" id="totalText">0m 0s</div></div>
      <div class="card"><div class="label">Remaining</div><div class="value" id="remainingText">0m 0s</div></div>
      <div class="card"><div class="label">Success Rate</div><div class="value" id="successRate">No orders yet</div></div>
      <div class="card"><div class="label">Recoveries</div><div class="value warn" id="recoveries">0</div></div>
      <div class="card"><div class="label">Reconnects</div><div class="value warn" id="reconnects">0</div></div>
      <div class="card"><div class="label">Status</div><div class="value" id="runStatus">STARTING</div></div>
    </div>

    <div class="feed" id="feed"></div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const connEl = document.getElementById('conn');
    const feedEl = document.getElementById('feed');

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    const STATUS_CLASS = { STARTING: 'warn', RUNNING: 'info', SUCCESS: 'good', FAILED: 'bad', PARTIAL: 'warn' };
    let live = { active: false, startMs: 0, targetMs: 0 };

    function setValue(id, text, cls) {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      el.className = 'value' + (cls ? ' ' + cls : '');
    }

    function fmt(ms) {
      const t = Math.max(0, Math.floor(ms / 1000));
      return Math.floor(t / 60) + 'm ' + (t % 60) + 's';
    }

    function renderMetrics(m) {
      const status = m.runStatus ?? 'STARTING';
      setText('currentCycle', m.currentCycle ?? 0);
      setText('opm', m.ordersPerMinute ?? '0.0');
      setText('elapsedText', m.elapsedText ?? '0m 0s');
      setText('totalText', m.totalText ?? 'N/A');
      setText('remainingText', m.remainingText ?? 'N/A');
      const rate = m.successRate;
      const noOrders = rate === undefined || rate === null || rate === 'N/A';
      setValue('successRate', noOrders ? 'No orders yet' : rate, noOrders ? '' : (status === 'FAILED' ? 'bad' : status === 'SUCCESS' ? 'good' : ''));
      setText('recoveries', m.recoveries ?? 0);
      setText('reconnects', m.reconnects ?? 0);
      setValue('runStatus', status, STATUS_CLASS[status] || '');
      live = {
        active: status === 'STARTING' || status === 'RUNNING',
        startMs: m.elapsedStartMs || 0,
        targetMs: m.targetMs || 0,
      };
    }

    // Live elapsed/remaining between server pushes (browser clock only; no effect on the run).
    setInterval(() => {
      if (!live.active || !live.startMs) return;
      const elapsed = Date.now() - live.startMs;
      setText('elapsedText', fmt(elapsed));
      if (live.targetMs) setText('remainingText', fmt(live.targetMs - elapsed));
    }, 1000);

    function addEvent(ev) {
      const row = document.createElement('div');
      row.className = 'ev';
      row.innerHTML = '<span class="t">' + ev.time + '</span><span class="type">' + ev.type + '</span>' + ev.message;
      feedEl.prepend(row);
      while (feedEl.childNodes.length > 120) feedEl.removeChild(feedEl.lastChild);
    }

    const socket = io();

    socket.on('connect', () => {
      connEl.textContent = 'Connected';
      connEl.style.color = '#22c55e';
    });

    socket.on('disconnect', () => {
      connEl.textContent = 'Disconnected';
      connEl.style.color = '#ef4444';
    });

    socket.on('dashboard:init', (payload) => {
      renderMetrics(payload.metrics || {});
      (payload.events || []).forEach(addEvent);
    });

    socket.on('dashboard:metrics', renderMetrics);
    socket.on('dashboard:event', addEvent);
  </script>
</body>
</html>`;
}

async function startLiveDashboard(options = {}) {
  const port = options.port || 5050;
  const runDir = getRunDir();
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true });
  }
  const stateFile = path.join(runDir, 'live_state.json');

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });

  const state = {
    metrics: {
      currentCycle: 0,
      ordersPerMinute: '0.0',
      elapsedText: '0m 0s',
      totalText: 'N/A',
      remainingText: 'N/A',
      successRate: 'N/A',
      recoveries: 0,
      reconnects: 0,
      runStatus: 'STARTING',
    },
    events: [],
  };
  let persistTimer = null;
  let persistInFlight = false;
  let persistPending = false;

  app.get('/', (_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(dashboardHtml());
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, time: nowIso(), metrics: state.metrics });
  });

  io.on('connection', (socket) => {
    socket.emit('dashboard:init', {
      metrics: state.metrics,
      events: state.events.slice(0, 40),
    });
  });

  async function persistStateNow() {
    if (persistInFlight) {
      persistPending = true;
      return;
    }
    persistInFlight = true;
    try {
      await fs.promises.writeFile(stateFile, JSON.stringify({ updatedAt: nowIso(), ...state }, null, 2), 'utf8');
    } catch (_e) {
      // Non-fatal persistence failure should not affect live monitoring.
    } finally {
      persistInFlight = false;
      if (persistPending) {
        persistPending = false;
        await persistStateNow();
      }
    }
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistStateNow();
    }, 350);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  function updateMetrics(partial) {
    state.metrics = { ...state.metrics, ...partial };
    io.emit('dashboard:metrics', state.metrics);
    schedulePersist();
  }

  function addEvent(type, message) {
    const ev = { time: nowIso(), type: String(type || 'INFO').toUpperCase(), message: String(message || '') };
    state.events.unshift(ev);
    if (state.events.length > 200) state.events.length = 200;
    io.emit('dashboard:event', ev);
    schedulePersist();
  }

  await persistStateNow();

  async function close() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persistStateNow();
    await new Promise((resolve) => io.close(() => resolve()));
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    updateMetrics,
    addEvent,
    close,
  };
}

module.exports = { startLiveDashboard };
