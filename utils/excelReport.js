'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { getRunDir } = require('./runArtifacts');

async function generateExcelReport(payload) {
  const { cycleRows = [], summary = {} } = payload || {};
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
    { header: 'Cycle', key: 'cycle', width: 10 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Duration', key: 'duration', width: 14 },
    { header: 'Recovery', key: 'recovery', width: 14 },
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
      duration: `${row.durationMs} ms`,
      recovery: row.recovery,
    });

    const statusCell = rec.getCell(2);
    const recoveryCell = rec.getCell(4);

    if (String(row.status).toUpperCase() === 'PASS') {
      statusCell.font = { color: { argb: 'FF15803D' }, bold: true };
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
      to: { row: cyclesSheet.rowCount, column: 4 },
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
    { metric: 'Success Rate', value: summary.successRate || '0.0%' },
    { metric: 'Failure Rate', value: summary.failureRate || '0.0%' },
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
