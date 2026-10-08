'use strict';

const fs = require('fs');
const path = require('path');
const { getRunDir, isRunDirInitialized } = require('./runArtifacts');

function pad(v) {
  return String(v).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function formatDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function row(label, value, cls = '') {
  return `<tr><td>${esc(label)}</td><td class="${cls}">${esc(value)}</td></tr>`;
}

function bsConfigRows(cfg) {
  const c = cfg || {};
  return row('BrowserStack App ID', c.appId || 'Unknown')
    + row('BrowserStack Project', c.projectName || 'Unknown')
    + row('BrowserStack Build', c.buildName || 'Unknown')
    + row('BrowserStack Session Name', c.sessionName || 'Unknown');
}

function toNumberPercent(value) {
  const n = Number(String(value || '').replace('%', '').trim());
  return Number.isFinite(n) ? n : 0;
}

function classifyRunHealth({ status, stability, longRun, startupHealth }) {
  const { assessMemoryHealth } = require('./longRunAnalytics');
  const memHealth = assessMemoryHealth(longRun?.memoryLeak || {}, longRun?.slowdown || {}, stability);

  const successRate = toNumberPercent(stability?.successRate);
  const fatalFailures = Number(stability?.fatalFailures || 0);
  const appiumReady = startupHealth?.appiumReady;
  const adbConnected = startupHealth?.adbConnected;
  const slowdownDetected = Boolean(longRun?.slowdown?.detected);

  const hasSystemFailures = (status !== 'SUCCESS' && status !== 'STOPPED_NO_ORDER') || fatalFailures > 0 || successRate < 98 || appiumReady === false || adbConnected === false;

  if (hasSystemFailures || memHealth.status === 'High Risk of Memory Leak') {
    const reasons = [];
    if (status !== 'SUCCESS') reasons.push('Run did not complete successfully.');
    if (fatalFailures > 0) reasons.push(`Fatal failures observed (${fatalFailures}).`);
    if (successRate < 98) reasons.push(`Success rate below target (${successRate.toFixed(1)}%).`);
    if (appiumReady === false) reasons.push('Startup health gate: Appium not ready.');
    if (adbConnected === false) reasons.push('Startup health gate: ADB not connected.');
    
    if (memHealth.status === 'High Risk of Memory Leak') {
      reasons.push('Significant memory growth combined with performance degradation and instability detected.');
      reasons.push('Detailed heap dump analysis is strongly recommended.');
    } else if (memHealth.status !== 'Healthy') {
      reasons.push(memHealth.verdictText);
    }
    return { verdict: 'At Risk', cls: 'fail', reasons };
  }

  if (memHealth.status === 'Potential Memory Retention') {
    return {
      verdict: 'Monitor',
      cls: 'recovery',
      reasons: [
        'Memory growth exceeded expected thresholds.',
        'Performance degradation or recovery activity detected.',
        'Heap analysis is recommended.'
      ]
    };
  }

  if (memHealth.status === 'Memory Growth Observed') {
    const slope = longRun?.memoryLeak?.slopeMbPerCycle || 0;
    return {
      verdict: 'Monitor',
      cls: 'recovery',
      reasons: [
        'Sustained memory growth observed across sampled cycles.',
        `Average growth rate: ${slope.toFixed(3)} MB/cycle.`,
        'No significant cycle-duration drift detected.',
        'No failures or recoveries occurred.',
        'Additional endurance testing is recommended.'
      ]
    };
  }

  if (slowdownDetected) {
    return {
      verdict: 'Monitor',
      cls: 'recovery',
      reasons: [
        'Cycle slowdown trend detected (stability still acceptable).',
        'No significant memory anomalies detected.'
      ]
    };
  }

  return {
    verdict: 'Healthy',
    cls: 'pass',
    reasons: [
      'Memory usage remained stable during the run.',
      'No significant performance degradation detected.'
    ]
  };
}

function buildRecommendations({ performance, longRun, stability }) {
  const { assessMemoryHealth } = require('./longRunAnalytics');
  const memHealth = assessMemoryHealth(longRun?.memoryLeak || {}, longRun?.slowdown || {}, stability);

  const tips = [];
  const bottlenecks = performance?.bottlenecks || [];
  const topBottleneck = bottlenecks[0]?.label;
  const slowdownDetected = Boolean(longRun?.slowdown?.detected);
  const recoveryCount = Number(longRun?.recoverySpikes?.totalRecoveries || 0);
  const reconnects = Number(stability?.adbReconnects || 0);

  if (topBottleneck) {
    tips.push(`Primary bottleneck is ${topBottleneck}; focus tuning there first.`);
  }
  if (slowdownDetected) {
    tips.push('Slowdown trend detected: compare first-window vs last-window cycle timings and inspect backend response drift.');
  }
  
  if (memHealth.status === 'High Risk of Memory Leak') {
    tips.push('Detailed heap dump analysis is strongly recommended due to high risk of memory leak.');
  } else if (memHealth.status === 'Potential Memory Retention') {
    tips.push('Potential memory retention: perform heap analysis and review app cache/navigation patterns.');
  } else if (memHealth.status === 'Memory Growth Observed') {
    tips.push('Memory growth observed: consider extending duration of smoke runs or adjusting memory limits.');
  }

  if (reconnects > 0 || recoveryCount > 0) {
    tips.push('Recoveries occurred: verify device/network stability and review corresponding run.log segments.');
  }
  if (tips.length === 0) {
    tips.push('No immediate action needed; continue periodic long-run smokes to confirm trend stability.');
  }

  return tips.slice(0, 4);
}

function buildRecentCyclesTable(cycleRows) {
  if (!Array.isArray(cycleRows) || cycleRows.length === 0) {
    return '<p class="muted">No cycle-level rows captured for this run.</p>';
  }

  const recent = cycleRows.slice(-10).reverse();
  const rows = recent.map((r) => {
    const statusText = String(r.status || 'UNKNOWN').toUpperCase();
    const statusCls = statusText === 'PASS' ? 'pass' : (statusText === 'NO_ORDER' ? 'neutral' : 'fail');
    const recoveryYes = String(r.recovery || '').toLowerCase() === 'yes';
    return `<tr>
      <td>${esc(r.cycle)}</td>
      <td class="${statusCls}">${esc(statusText)}</td>
      <td>${esc(`${r.durationMs} ms`)}</td>
      <td class="${recoveryYes ? 'recovery' : ''}">${esc(r.recovery || 'No')}</td>
    </tr>`;
  }).join('');

  return `<table>
    <thead>
      <tr><th>Cycle</th><th>Status</th><th>Duration</th><th>Recovered</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function rateText(stability, key) {
  const orders = Number(stability.cyclesCompleted || 0);
  const failed = Number(stability.cyclesFailed || 0);
  if (orders === 0 && failed === 0) return 'N/A (no orders yet)';
  return stability[key] || 'N/A';
}

function buildCycleDetailsTable(cycleRows) {
  if (!Array.isArray(cycleRows) || cycleRows.length === 0) {
    return '<p class="muted">No cycle-level rows captured for this run.</p>';
  }
  const time = (v) => (v ? String(v).replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '-');
  const rows = cycleRows.map((r) => {
    const statusText = String(r.status || 'UNKNOWN').toUpperCase();
    const statusCls = statusText === 'PASS' ? 'pass' : (statusText === 'NO_ORDER' ? 'neutral' : 'fail');
    const recoveryYes = String(r.recovery || '').toLowerCase() === 'yes';
    const shot = r.screenshot ? `<a href="${esc(encodeURI(r.screenshot))}">${esc(r.screenshot)}</a>` : '-';
    const reason = [r.failureCategory, r.errorMessage].filter(Boolean).join(': ') || r.failureReason || '-';
    return `<tr>
      <td>${esc(r.cycle)}</td>
      <td class="${statusCls}">${esc(statusText)}</td>
      <td>${esc(time(r.startTime))}</td>
      <td>${esc(time(r.endTime))}</td>
      <td>${esc(`${r.durationMs} ms`)}</td>
      <td>${esc(r.child || '-')}</td>
      <td>${esc(r.product || '-')}</td>
      <td>${esc(r.order || '-')}</td>
      <td class="${recoveryYes ? 'recovery' : ''}">${esc(r.recovery || 'No')}</td>
      <td>${esc(r.reconnect != null ? r.reconnect : 0)}</td>
      <td>${esc(statusText === 'PASS' ? '-' : reason)}</td>
      <td>${shot}</td>
      <td>${esc(r.notes || '-')}</td>
    </tr>`;
  }).join('');

  return `<div style="overflow-x:auto"><table>
    <thead>
      <tr><th>Cycle</th><th>Status</th><th>Start</th><th>End</th><th>Duration</th><th>Child</th><th>Product</th><th>Order</th><th>Recovery</th><th>Reconnect</th><th>Failure Reason</th><th>Screenshot</th><th>Notes</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function buildSessionsSection(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return '';
  const rows = sessions.map((s, i) => `<tr>
      <td>${i + 1}</td>
      <td><a href="${esc(s.url)}">${esc(s.sessionId)}</a></td>
      <td>${esc(s.reason || '-')}</td>
      <td>${esc(s.createdAt || '-')}</td>
    </tr>`).join('');
  return `<section class="card">
        <h2>BrowserStack Sessions (${sessions.length})</h2>
        <table>
          <thead><tr><th>#</th><th>Session ID</th><th>Reason</th><th>Created</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function buildFailuresSection(cycleRows) {
  const failed = (cycleRows || []).filter((r) => String(r.status).toUpperCase() === 'FAIL');
  if (failed.length === 0) return '';
  const rows = failed.map((r) => `<tr>
      <td>${esc(r.cycle)}</td>
      <td>${esc(r.failureCategory || 'Unclassified')}</td>
      <td>${esc(r.errorMessage || r.failureReason || '-')}</td>
      <td>${r.screenshot ? `<a href="${esc(encodeURI(r.screenshot))}">${esc(r.screenshot)}</a>` : '-'}</td>
      <td>${esc(r.sessionId || '-')}</td>
    </tr>`).join('');
  return `<section class="card" style="grid-column:1/-1">
        <h2>Failures / Diagnostics</h2>
        <table>
          <thead><tr><th>Cycle</th><th>Category</th><th>Error</th><th>Screenshot</th><th>Session</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function buildHtml(payload) {
  const {
    status: rawStatus,
    startTime,
    endTime,
    metadata,
    startupHealth,
    performance,
    stability,
    longRun,
    cycleRows,
    noOrder,
    sessions,
  } = payload;
  const status = rawStatus === 'SUCCESS' && Number(stability.cyclesFailed || 0) > 0 ? 'PARTIAL' : rawStatus;
  const noOrderCycles = Number((noOrder && noOrder.cycles) || 0);
  const noOrderStopReason = (noOrder && noOrder.stopReason) || null;

  const bottlenecks = (performance.bottlenecks || [])
    .map((b) => `<li>${esc(b.label)} - ${esc(`${b.ms} ms`)}</li>`)
    .join('');

  const failureReasons = Object.entries(stability.failureReasons || {});
  const failureRows = failureReasons.length
    ? failureReasons.map(([k, v]) => row(k, v)).join('')
    : row('No failures recorded', '-');

  const statusClass = status === 'SUCCESS' ? 'pass' : ((status === 'STOPPED_NO_ORDER' || status === 'PARTIAL') ? 'neutral' : 'fail');
  const recoveryClass = (stability.recoveredFailures || 0) > 0 ? 'recovery' : '';
  const longRunData = longRun || {};
  const slowdown = longRunData.slowdown || {};
  const memoryLeak = longRunData.memoryLeak || {};
  const recoverySpikes = longRunData.recoverySpikes || {};
  const startup = startupHealth || {};
  const boolText = (v) => (v === true ? 'Yes' : (v === false ? 'No' : (v === 'N/A' ? 'Not Applicable' : 'Unknown')));
  const isBs = startup.executionEnv === 'browserstack';
  const { assessMemoryHealth } = require('./longRunAnalytics');
  const memHealth = assessMemoryHealth(memoryLeak, slowdown, stability);
  const runHealth = classifyRunHealth({ status: rawStatus, stability, longRun: longRunData, startupHealth: startup });
  const recommendations = buildRecommendations({ performance, longRun: longRunData, stability });
  const successRateNum = toNumberPercent(stability.successRate || '0%');
  const failureRateNum = toNumberPercent(stability.failureRate || '0%');
  const attempts = Number(stability.attempts || 0);
  const recentCyclesTable = buildCycleDetailsTable(cycleRows);
  const sessionsSection = isBs ? buildSessionsSection(sessions) : '';
  const failuresSection = buildFailuresSection(cycleRows);
  const executionLabel = isBs ? 'BrowserStack' : 'Local Device';
  const watchdogEvents = Object.entries(stability.failureReasons || {})
    .filter(([k]) => /watchdog/i.test(k))
    .reduce((n, [, v]) => n + Number(v || 0), 0);
  const cyclesRequested = startup.runMode === 'cycles' && startup.maxCycles != null ? startup.maxCycles : 'N/A (duration mode)';
  const durationRequested = startup.runMode === 'cycles' ? 'N/A (cycle mode)' : (startup.durationMins != null ? `${startup.durationMins} mins` : 'N/A');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ParentPay POS Stress Test - ${esc(executionLabel)}</title>
  <style>
    :root {
      --bg: #f4f6f8;
      --card: #ffffff;
      --text: #1f2937;
      --muted: #6b7280;
      --pass: #15803d;
      --fail: #b91c1c;
      --recovery: #c2410c;
      --border: #e5e7eb;
    }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .wrap {
      max-width: 1100px;
      margin: 24px auto;
      padding: 0 16px;
    }
    .header {
      background: linear-gradient(135deg, #0f172a, #1e293b);
      color: #fff;
      border-radius: 12px;
      padding: 18px 20px;
      margin-bottom: 18px;
    }
    .pill {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .2px;
    }
    .pass { color: var(--pass); font-weight: 700; }
    .fail { color: var(--fail); font-weight: 700; }
    .neutral { color: #6b7280; font-weight: 700; }
    .recovery { color: var(--recovery); font-weight: 700; }
    .muted { color: var(--muted); }
    .kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .kpi {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
    }
    .kpi .label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }
    .kpi .value {
      font-size: 20px;
      font-weight: 800;
      line-height: 1.1;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 14px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,.06);
    }
    h2 {
      margin: 0 0 10px;
      font-size: 16px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th {
      text-align: left;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      border-bottom: 1px solid var(--border);
      padding: 7px 0;
    }
    td {
      padding: 7px 0;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    td:first-child {
      color: var(--muted);
      width: 45%;
      padding-right: 8px;
    }
    ul {
      margin: 6px 0 0 18px;
      padding: 0;
    }
    .footer {
      margin-top: 14px;
      color: var(--muted);
      font-size: 12px;
    }
    .meter-wrap {
      display: grid;
      gap: 8px;
    }
    .meter-label {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 2px;
    }
    .meter {
      background: #eef2f7;
      border: 1px solid var(--border);
      border-radius: 8px;
      height: 10px;
      overflow: hidden;
    }
    .meter-fill {
      height: 100%;
      border-radius: 8px;
    }
    .meter-success { background: linear-gradient(90deg, #16a34a, #15803d); }
    .meter-failure { background: linear-gradient(90deg, #ef4444, #b91c1c); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1 style="margin:0 0 6px; font-size:22px;">ParentPay POS Stress Test</h1>
      <div style="margin-bottom:6px;">Execution: <strong>${esc(executionLabel)}</strong> &middot; Start: ${esc(formatDateTime(startTime))} &middot; End: ${esc(formatDateTime(endTime))} &middot; Duration: ${esc(formatDuration(new Date(endTime) - new Date(startTime)))}</div>
      <div class="pill ${statusClass}">Status: ${esc(status)}</div>
    </div>

    <section class="kpis">
      <div class="kpi">
        <div class="label">Orders / Minute</div>
        <div class="value">${esc(performance.ordersPerMinute || 'N/A')}</div>
      </div>
      <div class="kpi">
        <div class="label">Success Rate</div>
        <div class="value pass">${esc(rateText(stability, 'successRate'))}</div>
      </div>
      <div class="kpi">
        <div class="label">Cycles</div>
        <div class="value">${esc(String(performance.completedCycles || 0))}</div>
      </div>
      <div class="kpi">
        <div class="label">Recoveries</div>
        <div class="value recovery">${esc(String(stability.recoveredFailures || 0))}</div>
      </div>
      <div class="kpi">
        <div class="label">Run Health</div>
        <div class="value ${runHealth.cls}">${esc(runHealth.verdict)}</div>
      </div>
    </section>

    <div class="grid">
      <section class="card">
        <h2>Stress Run Overview</h2>
        <table>
          ${row('Execution', executionLabel)}
          ${row('Status', status, statusClass)}
          ${row('Run Mode', startup.runMode || 'Unknown')}
          ${row('Cycles Requested', cyclesRequested)}
          ${row('Duration Requested', durationRequested)}
          ${row('Cycles Completed', stability.cyclesCompleted || 0)}
          ${row('Successful Orders', stability.cyclesCompleted || 0)}
          ${row('Failed Orders', stability.cyclesFailed || 0, (stability.cyclesFailed || 0) > 0 ? 'fail' : '')}
          ${row('NO_ORDER Cycles', noOrderCycles, noOrderCycles > 0 ? 'neutral' : '')}
          ${row('Success Rate', rateText(stability, 'successRate'))}
          ${row('Failure Rate', rateText(stability, 'failureRate'))}
          ${row('Orders / Minute', performance.ordersPerMinute || 'N/A')}
          ${row('Recoveries', stability.recoveredFailures || 0)}
          ${row('Reconnects', stability.adbReconnects || 0)}
          ${row('Watchdog Events', watchdogEvents)}
          ${row('Total Execution Time', formatDuration(new Date(endTime) - new Date(startTime)))}
          ${isBs ? row('Run Folder', payload.runDir ? path.basename(payload.runDir) : 'Unknown') : ''}
        </table>
      </section>

      ${sessionsSection}
      <section class="card">
        <h2>Run Health Verdict</h2>
        <table>
          ${row('Verdict', runHealth.verdict, runHealth.cls)}
          ${row('Run Status', status, statusClass)}
          ${row('Total Attempts', attempts || 0)}
          ${row('No-Order Cycles (not failures)', noOrderCycles, noOrderCycles > 0 ? 'neutral' : '')}
          ${noOrderStopReason ? row('Stop Reason', noOrderStopReason, 'neutral') : ''}
          ${row('Fatal Failures', stability.fatalFailures || 0, (stability.fatalFailures || 0) > 0 ? 'fail' : 'pass')}
        </table>
        <div style="margin-top:8px; font-size:14px;">
          <strong>Why This Verdict</strong>
          <ul>${runHealth.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        </div>
      </section>

      <section class="card">
        <h2>Execution Summary</h2>
        <table>
          ${row('Start Time', formatDateTime(startTime))}
          ${row('End Time', formatDateTime(endTime))}
          ${row('Duration', formatDuration(new Date(endTime) - new Date(startTime)))}
          ${row('Stability Duration', stability.durationText || formatDuration(stability.durationMs || 0))}
          ${row('Device Name', metadata.deviceName || 'Unknown')}
          ${row('Android Version', metadata.androidVersion || 'Unknown')}
          ${row('Appium Version', metadata.appiumVersion || 'Unknown')}
          ${row('Execution Status', status, statusClass)}
        </table>
      </section>

      <section class="card">
        <h2>Startup Health Gate</h2>
        <table>
          ${startup.executionEnv === 'browserstack' ? row('Execution Environment', 'BrowserStack') + row('BrowserStack Session ID', startup.browserstackSessionId || 'Unknown') + row('Memory Monitoring', 'Not Applicable') + bsConfigRows(startup.browserstackConfig) : ''}
          ${row(isBs ? 'Local Appium Server' : 'Appium Ready', boolText(startup.appiumReady), startup.appiumReady === true ? 'pass' : (startup.appiumReady === false ? 'fail' : ''))}
          ${row(isBs ? 'ADB' : 'ADB Connected', boolText(startup.adbConnected), startup.adbConnected === true ? 'pass' : (startup.adbConnected === false ? 'fail' : ''))}
          ${row(isBs ? 'Local Network Check' : 'Network Online', boolText(startup.networkOnline), startup.networkOnline === true ? 'pass' : (startup.networkOnline === false ? 'fail' : ''))}
          ${row('Run Mode', startup.runMode || 'Unknown')}
          ${row('Duration Target', startup.durationMins != null ? `${startup.durationMins} mins` : 'N/A')}
          ${row('Cycle Target', startup.maxCycles != null ? startup.maxCycles : 'N/A')}
          ${row('Framework', startup.framework || 'Unknown')}
          ${row('Unattended', boolText(startup.unattended), startup.unattended === true ? 'recovery' : '')}
          ${row('UDID', startup.udid || 'Unknown')}
        </table>
      </section>

      <section class="card">
        <h2>Performance Summary</h2>
        <table>
          ${row('Completed Cycles', performance.completedCycles || 0)}
          ${row('Orders Per Minute', performance.ordersPerMinute || 'N/A')}
          ${row('Average Cycle Time', `${performance.averageCycleMs || 0} ms`)}
          ${row('Child Selection Avg', `${performance.phaseAveragesMs?.childSelection || 0} ms`)}
          ${row('Cart Build Avg', `${performance.phaseAveragesMs?.cartBuild || 0} ms`)}
          ${row('Wallet Selection Avg', `${performance.phaseAveragesMs?.walletSelection || 0} ms`)}
          ${row('Payment Avg', `${performance.phaseAveragesMs?.payment || 0} ms`)}
        </table>
        <div style="margin-top:8px; font-size:14px;">
          <strong>Top Bottlenecks</strong>
          <ul>${bottlenecks || '<li>None</li>'}</ul>
        </div>
        <div class="meter-wrap" style="margin-top:10px;">
          <div>
            <div class="meter-label">Success Distribution (${esc(stability.successRate || '0.0%')} pass / ${esc(stability.failureRate || '0.0%')} fail)</div>
            <div class="meter"><div class="meter-fill meter-success" style="width:${Math.max(0, Math.min(100, successRateNum))}%;"></div></div>
          </div>
          <div>
            <div class="meter-label">Failure Portion</div>
            <div class="meter"><div class="meter-fill meter-failure" style="width:${Math.max(0, Math.min(100, failureRateNum))}%;"></div></div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Stability Summary</h2>
        <table>
          ${row('Cycles Completed', stability.cyclesCompleted || 0)}
          ${row('Cycles Failed', stability.cyclesFailed || 0)}
          ${row('Success Rate', rateText(stability, 'successRate'), 'pass')}
          ${row('Failure Rate', rateText(stability, 'failureRate'), (stability.cyclesFailed || 0) > 0 ? 'fail' : '')}
          ${row('Recovery Rate', stability.recoveryRate || '0.0%', recoveryClass)}
          ${row('Popup Recoveries', stability.popupRecoveries || 0, (stability.popupRecoveries || 0) > 0 ? 'recovery' : '')}
          ${row('ADB Reconnects', stability.adbReconnects || 0, (stability.adbReconnects || 0) > 0 ? 'recovery' : '')}
          ${row('App Restarts', stability.appRestarts || 0, (stability.appRestarts || 0) > 0 ? 'recovery' : '')}
          ${row('Session Rebuilds', stability.sessionRebuilds || 0, (stability.sessionRebuilds || 0) > 0 ? 'recovery' : '')}
          ${row('Screenshots Captured', stability.screenshotsCaptured || 0)}
        </table>
      </section>

      <section class="card">
        <h2>Failure Summary</h2>
        <table>
          ${row('Fatal Failures', stability.fatalFailures || 0, (stability.fatalFailures || 0) > 0 ? 'fail' : '')}
          ${row('Total Attempts', attempts || 0)}
          ${failureRows}
        </table>
      </section>

      <section class="card">
        <h2>Memory Health Summary</h2>
        <table>
          ${row('Memory Health Status', memHealth.status, memHealth.statusClass)}
          ${row('Memory Trend', memHealth.trend)}
          ${row('Memory Net Increase', `${memoryLeak.netIncreaseMb || 0} MB`)}
          ${row('Memory Slope', `${memoryLeak.slopeMbPerCycle || 0} MB/cycle`)}
          ${row('Leak Risk', memHealth.risk, memHealth.riskClass)}
          ${row('Recommendation', memHealth.recommendation)}
        </table>
      </section>

      <section class="card">
        <h2>Long Run Analytics</h2>
        <table>
          ${row('Cycles Tracked', longRunData.totalCyclesTracked || 0)}
          ${row('Cycle Duration Trend', slowdown.detected ? 'Slowdown Detected' : 'Stable', slowdown.detected ? 'fail' : 'pass')}
          ${row('Cycle 1 -> Last', `${slowdown.firstCycleSeconds || 0}s -> ${slowdown.lastCycleSeconds || 0}s`)}
          ${row('Trend Window Size', slowdown.windowSize || 'N/A')}
          ${row('Slowdown Percent', `${slowdown.slowdownPercent || 0}%`, slowdown.detected ? 'fail' : 'pass')}
          ${row('Slowdown Note', slowdown.reason || 'N/A')}
          ${row('Memory Health Status', memHealth.status, memHealth.statusClass)}
          ${row('Memory Net Increase', `${memoryLeak.netIncreaseMb || 0} MB`)}
          ${row('Memory Slope', `${memoryLeak.slopeMbPerCycle || 0} MB/cycle`)}
          ${row('Memory Note', memoryLeak.reason || 'N/A')}
          ${row('Recovery Spikes', recoverySpikes.detected ? 'Detected' : 'Not Detected', recoverySpikes.detected ? 'recovery' : 'pass')}
          ${row('Recovery Count', recoverySpikes.totalRecoveries || 0, (recoverySpikes.totalRecoveries || 0) > 0 ? 'recovery' : '')}
          ${row('Recovery Baseline Rate', recoverySpikes.baselineRate != null ? recoverySpikes.baselineRate : 'N/A')}
          ${row('Recovery Note', recoverySpikes.reason || 'N/A')}
        </table>
      </section>

      <section class="card">
        <h2>Actionable Recommendations</h2>
        <ul>${recommendations.map((tip) => `<li>${esc(tip)}</li>`).join('')}</ul>
      </section>

      <section class="card" style="grid-column:1/-1">
        <h2>Cycle Details</h2>
        ${recentCyclesTable}
      </section>
      ${failuresSection}
    </div>

    <div class="footer">Generated by ParentPay POS Automation Framework</div>
  </div>
</body>
</html>`;
}

function generateReport(payload) {
  if (!isRunDirInitialized()) {
    throw new Error('Run folder not initialised (initRunArtifacts must run first); refusing to write report to a shared path.');
  }
  const runDir = getRunDir();
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true });
  }

  const stamp = formatTimestamp(new Date());
  const fileName = `report_${stamp}.html`;
  const fullPath = path.join(runDir, fileName);
  const html = buildHtml(payload);
  fs.writeFileSync(fullPath, html, 'utf8');
  return fullPath;
}

module.exports = { generateReport };
