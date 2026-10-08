const fs = require('fs');
const path = require('path');

let logFilePath = '';

function initLogger(runDir) {
  if (!runDir) return;
  fs.mkdirSync(runDir, { recursive: true });
  logFilePath = path.join(runDir, 'run.log');
}

// Optional observer (live dashboard). Must never affect logging or the run.
let eventSink = null;

function setEventSink(fn) {
  eventSink = typeof fn === 'function' ? fn : null;
}

function log(level, msg) {
  const isRapid = process.env.EXECUTION_MODE === 'rapid';
  const levelUpper = level.toUpperCase();

  if (eventSink) {
    try { eventSink(levelUpper, String(msg)); } catch (_e) {}
  }

  if (isRapid) {
    const allowed = ['CYCLE', 'OPM', 'SUCCESS', 'ERROR', 'FATAL', 'SETUP', 'DASHBOARD', 'REPORT', 'RECOVERY', 'RELAUNCH', 'LOGIN', 'POPUP', 'SCREENSHOT', 'SCREENSHOT_ERROR', 'CLEANUP'];
    if (!allowed.includes(levelUpper)) {
      // Still write to log file, but skip console.log
      const timestamp = new Date().toISOString();
      const line = `${timestamp} [${levelUpper}] ${msg}`;
      if (logFilePath) {
        try {
          fs.appendFileSync(logFilePath, `${line}\n`, 'utf8');
        } catch (_e) {}
      }
      return;
    }
  }

  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${levelUpper}] ${msg}`;
  console.log(line);

  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, `${line}\n`, 'utf8');
    } catch (_e) {
      // Logging to file is best-effort and should never crash automation.
    }
  }
}

module.exports = { log, initLogger, setEventSink };
