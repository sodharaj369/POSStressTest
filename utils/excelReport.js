'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { getRunDir, isRunDirInitialized } = require('./runArtifacts');

async function generateExcelReport(payload) {
  const { cycleRows = [], summary = {}, sessions = [], runInfo = {} } = payload || {};
  if (!isRunDirInitialized()) {
    throw new Error('Run folder not initialised (initRunArtifacts must run first); refusing to write report to a shared path.');
  }
  const runDir = getRunDir();
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true });
  }

  const outPath = path.join(runDir, 'report.xlsx');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ParentPay POS Automation';
  workbook.created = new Date();

  const cyclesSheet = workbook.addWorksheet('Cycles');
  cyclesSheet.views = [{ state: 'frozen', ySplit: 1 }];
  cyclesSheet.columns = [
    { header: 'Cycle', key: 'cycle', width: 8 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Start', key: 'start', width: 22 },
    { header: 'End', key: 'end', width: 22 },
    { header: 'Duration', key: 'duration', width: 12 },
    { header: 'Child', key: 'child', width: 22 },
    { header: 'Product', key: 'product', width: 28 },
    { header: 'Order', key: 'order', width: 12 },
    { header: 'Recovery', key: 'recovery', width: 10 },
    { header: 'Reconnect', key: 'reconnect', width: 10 },
    { header: 'Failure Reason', key: 'failure', width: 40 },
    { header: 'Notes', key: 'notes', width: 50 },
  ];

  const headerFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F2937' },
  };

  cyclesSheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = headerFill;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  for (const row of cycleRows) {
    const rec = cyclesSheet.addRow({
      cycle: row.cycle,
      status: row.status,
      start: row.startTime || '',
      end: row.endTime || '',
      duration: `${row.durationMs} ms`,
      child: row.child || '',
      product: row.product || '',
      order: row.order || '',
      recovery: row.recovery,
      reconnect: row.reconnect != null ? row.reconnect : 0,
      failure: String(row.status).toUpperCase() === 'PASS'
        ? ''
        : ([row.failureCategory, row.errorMessage].filter(Boolean).join(': ') || row.failureReason || ''),
      notes: row.notes || '',
    });

    const statusCell = rec.getCell(2);
    const recoveryCell = rec.getCell(9);

    if (String(row.status).toUpperCase() === 'PASS') {
      statusCell.font = { color: { argb: 'FF15803D' }, bold: true };
    } else if (String(row.status).toUpperCase() === 'NO_ORDER') {
      statusCell.font = { color: { argb: 'FF6B7280' }, bold: true };
    } else {
      statusCell.font = { color: { argb: 'FFB91C1C' }, bold: true };
    }

    if (String(row.recovery).toUpperCase() === 'YES') {
      recoveryCell.font = { color: { argb: 'FFC2410C' }, bold: true };
    }
  }

  if (cyclesSheet.rowCount > 1) {
    cyclesSheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: cyclesSheet.rowCount, column: 12 },
    };
  }

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.views = [{ state: 'frozen', ySplit: 1 }];
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 28 },
    { header: 'Value', key: 'value', width: 24 },
  ];

  summarySheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = headerFill;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  const summaryRows = [
    { metric: 'Cycles Completed', value: summary.cyclesCompleted || 0 },
    { metric: 'Cycles Failed', value: summary.cyclesFailed || 0 },
    { metric: 'Total Attempts', value: summary.attempts || 0 },
    { metric: 'No-Order Cycles (not failures)', value: summary.noOrderCycles || 0 },
    ...(summary.noOrderStopReason ? [{ metric: 'Stop Reason', value: summary.noOrderStopReason }] : []),
    { metric: 'Success Rate', value: (summary.cyclesCompleted || 0) === 0 && (summary.cyclesFailed || 0) === 0 ? 'N/A (no orders yet)' : (summary.successRate || 'N/A') },
    { metric: 'Failure Rate', value: (summary.cyclesCompleted || 0) === 0 && (summary.cyclesFailed || 0) === 0 ? 'N/A (no orders yet)' : (summary.failureRate || 'N/A') },
    { metric: 'Orders Per Minute', value: summary.ordersPerMinute || 'N/A' },
    { metric: 'Recoveries', value: summary.recoveries || 0 },
    { metric: 'Reconnects', value: summary.reconnects || 0 },
    { metric: 'App Restarts', value: summary.appRestarts || 0 },
    { metric: 'Session Rebuilds', value: summary.sessionRebuilds || 0 },
    { metric: 'Screenshots Captured', value: summary.screenshotsCaptured || 0 },
    { metric: 'Fatal Failures', value: summary.fatalFailures || 0 },
    { metric: 'Slowdown Detected', value: summary.longRun?.slowdownDetected ? 'Yes' : 'No' },
    { metric: 'Slowdown Percent', value: `${summary.longRun?.slowdownPercent ?? 0}%` },
    { metric: 'Memory Leak Indicator', value: summary.longRun?.memoryLeakDetected ? 'Yes' : 'No' },
    { metric: 'Memory Slope (MB/cycle)', value: `${summary.longRun?.memorySlopeMbPerCycle ?? 0}` },
    { metric: 'Memory Net Increase (MB)', value: `${summary.longRun?.memoryNetIncreaseMb ?? 0}` },
    { metric: 'Recovery Spikes', value: summary.longRun?.recoverySpikesDetected ? 'Yes' : 'No' },
    { metric: 'Recovery Count', value: summary.longRun?.recoveryCount ?? 0 },
  ];

  summaryRows.forEach((r) => summarySheet.addRow(r));

  for (let i = 2; i <= summarySheet.rowCount; i++) {
    const metric = String(summarySheet.getRow(i).getCell(1).value || '');
    const valueCell = summarySheet.getRow(i).getCell(2);
    if (metric === 'Success Rate') {
      valueCell.font = { color: { argb: 'FF15803D' }, bold: true };
    }
    if (metric === 'Failure Rate') {
      valueCell.font = { color: { argb: 'FFB91C1C' }, bold: true };
    }
    if (metric === 'Recoveries') {
      valueCell.font = { color: { argb: 'FFC2410C' }, bold: true };
    }
    if (metric === 'Slowdown Detected' || metric === 'Memory Leak Indicator') {
      const isYes = String(valueCell.value || '').toLowerCase() === 'yes';
      valueCell.font = { color: { argb: isYes ? 'FFB91C1C' : 'FF15803D' }, bold: true };
    }
    if (metric === 'Recovery Spikes') {
      const isYes = String(valueCell.value || '').toLowerCase() === 'yes';
      valueCell.font = { color: { argb: isYes ? 'FFC2410C' : 'FF15803D' }, bold: true };
    }
    if (metric === 'Fatal Failures') {
      const count = Number(valueCell.value || 0);
      valueCell.font = { color: { argb: count > 0 ? 'FFB91C1C' : 'FF15803D' }, bold: true };
    }
  }

  const startup = summary.startupHealth || {};
  const healthSheet = workbook.addWorksheet('Startup Health');
  healthSheet.views = [{ state: 'frozen', ySplit: 1 }];
  healthSheet.columns = [
    { header: 'Check', key: 'check', width: 30 },
    { header: 'Value', key: 'value', width: 24 },
  ];

  healthSheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = headerFill;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  const asYesNoUnknown = (v) => (v === true ? 'Yes' : (v === false ? 'No' : (v === 'N/A' ? 'Not Applicable' : 'Unknown')));
  const isBs = startup.executionEnv === 'browserstack';
  const healthRows = [
    ...(isBs ? [
      { check: 'Execution Environment', value: 'BrowserStack' },
      { check: 'BrowserStack Session ID', value: startup.browserstackSessionId || 'Unknown' },
      { check: 'BrowserStack App ID', value: (startup.browserstackConfig || {}).appId || 'Unknown' },
      { check: 'BrowserStack Project', value: (startup.browserstackConfig || {}).projectName || 'Unknown' },
      { check: 'BrowserStack Build', value: (startup.browserstackConfig || {}).buildName || 'Unknown' },
      { check: 'BrowserStack Session Name', value: (startup.browserstackConfig || {}).sessionName || 'Unknown' },
      { check: 'Memory Monitoring', value: 'Not Applicable' },
    ] : []),
    { check: isBs ? 'Local Appium Server' : 'Appium Ready', value: asYesNoUnknown(startup.appiumReady) },
    { check: isBs ? 'ADB' : 'ADB Connected', value: asYesNoUnknown(startup.adbConnected) },
    { check: isBs ? 'Local Network Check' : 'Network Online', value: asYesNoUnknown(startup.networkOnline) },
    { check: 'Run Mode', value: startup.runMode || 'Unknown' },
    { check: 'Duration Target (mins)', value: startup.durationMins ?? 'N/A' },
    { check: 'Cycle Target', value: startup.maxCycles ?? 'N/A' },
    { check: 'Framework', value: startup.framework || 'Unknown' },
    { check: 'Unattended', value: asYesNoUnknown(startup.unattended) },
    { check: 'UDID', value: startup.udid || 'Unknown' },
  ];
  healthRows.forEach((r) => healthSheet.addRow(r));

  // Environment sheet: execution identity and run metadata (shared by Local and BrowserStack).
  const meta = runInfo.metadata || {};
  const bsCfg = startup.browserstackConfig || {};
  const envSheet = workbook.addWorksheet('Environment');
  envSheet.columns = [
    { header: 'Item', key: 'item', width: 28 },
    { header: 'Value', key: 'value', width: 60 },
  ];
  envSheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = headerFill;
  });
  const fmt = (d) => (d ? new Date(d).toISOString() : '');
  [
    { item: 'Report', value: 'ParentPay POS Stress Test' },
    { item: 'Execution', value: isBs ? 'BrowserStack' : 'Local Device' },
    { item: 'Status', value: runInfo.status || '' },
    { item: 'Start Time', value: fmt(runInfo.startTime) },
    { item: 'End Time', value: fmt(runInfo.endTime) },
    { item: 'Device', value: meta.deviceName || 'Unknown' },
    { item: 'Android Version', value: meta.androidVersion || 'Unknown' },
    { item: 'Appium / Automation', value: meta.appiumVersion || 'Unknown' },
    { item: 'Run Mode', value: startup.runMode || 'Unknown' },
    { item: 'Cycles Requested', value: startup.runMode === 'cycles' ? (startup.maxCycles ?? 'N/A') : 'N/A (duration mode)' },
    { item: 'Duration Requested (mins)', value: startup.runMode === 'cycles' ? 'N/A (cycle mode)' : (startup.durationMins ?? 'N/A') },
    { item: 'Run Folder', value: runInfo.runDir ? path.basename(runInfo.runDir) : '' },
    ...(isBs ? [
      { item: 'BrowserStack Project', value: bsCfg.projectName || 'Unknown' },
      { item: 'BrowserStack Build', value: bsCfg.buildName || 'Unknown' },
      { item: 'BrowserStack Session Name', value: bsCfg.sessionName || 'Unknown' },
      { item: 'BrowserStack App ID', value: bsCfg.appId || 'Unknown' },
    ] : []),
  ].forEach((r) => envSheet.addRow(r));

  // Failures / Diagnostics sheet
  const failSheet = workbook.addWorksheet('Failures');
  failSheet.columns = [
    { header: 'Cycle', key: 'cycle', width: 8 },
    { header: 'Category', key: 'category', width: 28 },
    { header: 'Error', key: 'error', width: 70 },
    { header: 'Screenshot', key: 'shot', width: 40 },
    { header: 'Session', key: 'session', width: 40 },
  ];
  failSheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = headerFill;
  });
  cycleRows
    .filter((r) => String(r.status).toUpperCase() === 'FAIL')
    .forEach((r) => failSheet.addRow({
      cycle: r.cycle,
      category: r.failureCategory || 'Unclassified',
      error: r.errorMessage || r.failureReason || '',
      shot: r.screenshot || '',
      session: r.sessionId || '',
    }));

  // BrowserStack session sheet (all sessions used by this run, including recovery rebuilds)
  if (isBs) {
    const sessSheet = workbook.addWorksheet('BrowserStack Sessions');
    sessSheet.columns = [
      { header: '#', key: 'n', width: 5 },
      { header: 'Session ID', key: 'id', width: 44 },
      { header: 'Reason', key: 'reason', width: 24 },
      { header: 'Created', key: 'created', width: 26 },
      { header: 'Dashboard URL', key: 'url', width: 80 },
    ];
    sessSheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = headerFill;
    });
    sessions.forEach((s, i) => sessSheet.addRow({
      n: i + 1,
      id: s.sessionId,
      reason: s.reason || '',
      created: s.createdAt || '',
      url: { text: s.url, hyperlink: s.url },
    }));
  }

  for (let i = 2; i <= healthSheet.rowCount; i++) {
    const valueCell = healthSheet.getRow(i).getCell(2);
    const text = String(valueCell.value || '').toLowerCase();
    if (text === 'yes') {
      valueCell.font = { color: { argb: 'FF15803D' }, bold: true };
    } else if (text === 'no') {
      valueCell.font = { color: { argb: 'FFB91C1C' }, bold: true };
    }
  }

  await workbook.xlsx.writeFile(outPath);
  return outPath;
}

module.exports = { generateExcelReport };
