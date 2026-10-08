'use strict';

// BrowserStack App Automate driver factory.
// Isolated from the local Appium driver in tests/regression/helpers/regressionContext.js.
// Credentials come ONLY from environment variables - never hardcode them here.

const { remote } = require('webdriverio');
const bsConfig = require('../config/browserstack.json');
const { log } = require('./logger');

function envString(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}").`);
  }
  return value;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Fixed once per process so recovery sessions stay inside the same BrowserStack build.
const _processStart = new Date();
function buildTimestamp() {
  const d = _processStart;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}-${pad2(d.getMinutes())}`;
}

// Default stress names, derived from the same effective RUN_MODE / MAX_CYCLES / DURATION_MINS
// that test.js uses. Used only when no BROWSERSTACK_* override is given.
function getStressNames() {
  const appConfig = require('../config.json');
  const mode = process.env.RUN_MODE || appConfig.mode || 'duration';
  const ts = buildTimestamp();
  if (mode === 'cycles') {
    const cycles = process.env.MAX_CYCLES ? parseInt(process.env.MAX_CYCLES, 10) : (appConfig.maxCycles || 10);
    return {
      buildName: `${bsConfig.project.projectName} - Stress - Cycles-${cycles} - ${ts}`,
      sessionName: `E2E Stress - ${cycles} ${cycles === 1 ? 'Cycle' : 'Cycles'}`,
    };
  }
  const mins = process.env.DURATION_MINS ? parseFloat(process.env.DURATION_MINS) : (appConfig.durationMins || 5);
  return {
    buildName: `${bsConfig.project.projectName} - Stress - Duration-${mins}m - ${ts}`,
    sessionName: `E2E Stress - ${mins} Minutes`,
  };
}

// Non-secret settings: browserstack.json defaults, overridden by BROWSERSTACK_* env vars.
// profile 'stress' swaps the build/session defaults for stress-run names; any default
// (functional regression) profile keeps the browserstack.json names unchanged.
function getEffectiveConfig(profile = 'regression') {
  const stress = profile === 'stress' ? getStressNames() : null;
  return {
    appId: envString('BROWSERSTACK_APP_ID', bsConfig.appId),
    deviceName: envString('BROWSERSTACK_DEVICE', bsConfig.device.deviceName),
    platformVersion: envString('BROWSERSTACK_PLATFORM_VERSION', bsConfig.device.platformVersion),
    projectName: envString('BROWSERSTACK_PROJECT', bsConfig.project.projectName),
    buildName: envString('BROWSERSTACK_BUILD', stress ? stress.buildName : bsConfig.project.buildName),
    sessionName: envString('BROWSERSTACK_SESSION', stress ? stress.sessionName : bsConfig.project.sessionName),
    idleTimeoutSec: envPositiveInt('BROWSERSTACK_IDLE_TIMEOUT', bsConfig.idleTimeoutSec || 300),
    newCommandTimeout: envPositiveInt('BROWSERSTACK_COMMAND_TIMEOUT', bsConfig.newCommandTimeout || 300),
  };
}

function maskUsername(name) {
  if (!name) return '(missing)';
  return `${name.slice(0, 2)}***`;
}

// Safe summary: never includes the access key.
function printConfigSummary() {
  const c = getEffectiveConfig('stress');
  const appConfig = require('../config.json');
  const mode = process.env.RUN_MODE || appConfig.mode || 'duration';
  const durationMins = process.env.DURATION_MINS || appConfig.durationMins || 5;
  const maxCycles = process.env.MAX_CYCLES || appConfig.maxCycles || 10;
  const limit = mode === 'cycles' ? `maxCycles=${maxCycles}` : `duration=${durationMins} min`;
  [
    'Execution env : BrowserStack',
    `Username      : ${maskUsername(process.env.BROWSERSTACK_USERNAME)}`,
    `App ID        : ${c.appId}`,
    `Device        : ${c.deviceName}`,
    `Android       : ${c.platformVersion}`,
    `Project       : ${c.projectName}`,
    `Build         : ${c.buildName}`,
    `Session       : ${c.sessionName}`,
    `Idle timeout  : ${c.idleTimeoutSec}s, command timeout: ${c.newCommandTimeout}s`,
    `Run mode      : ${mode} (${limit})`,
  ].forEach((line) => log('SETUP', `[BROWSERSTACK CONFIG] ${line}`));
}

function getCredentials() {
  const username = process.env.BROWSERSTACK_USERNAME;
  const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
  return { username, accessKey };
}

function hasCredentials() {
  const { username, accessKey } = getCredentials();
  return Boolean(username && accessKey);
}

function buildBrowserstackRemoteOptions(reason = 'browserstack-proof', profile = 'regression') {
  const { username, accessKey } = getCredentials();
  if (!username || !accessKey) {
    throw new Error(
      'BrowserStack credentials missing. Set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY environment variables before running this command.'
    );
  }

  const c = getEffectiveConfig(profile);
  return {
    protocol: 'https',
    hostname: 'hub-cloud.browserstack.com',
    port: 443,
    path: '/wd/hub',
    user: username,
    key: accessKey,
    connectionRetryTimeout: 120000,
    connectionRetryCount: 1,
    capabilities: {
      platformName: 'Android',
      'appium:deviceName': c.deviceName,
      'appium:platformVersion': c.platformVersion,
      'appium:app': c.appId,
      'appium:automationName': 'UiAutomator2',
      'appium:newCommandTimeout': c.newCommandTimeout,
      'bstack:options': {
        projectName: c.projectName,
        buildName: c.buildName,
        // Stress keeps the clean session name; the reason is already in the run log.
        sessionName: profile === 'stress' ? c.sessionName : `${c.sessionName} (${reason})`,
        idleTimeout: c.idleTimeoutSec,
        debug: true,
      },
    },
  };
}

async function createBrowserstackDriverSession(reason = 'browserstack-proof') {
  log('SETUP', `Creating BrowserStack session (${reason})`);
  const driver = await remote(buildBrowserstackRemoteOptions(reason));
  log('SETUP', `BrowserStack session created: ${driver.sessionId}`);
  return driver;
}

module.exports = {
  hasCredentials,
  buildBrowserstackRemoteOptions,
  getEffectiveConfig,
  printConfigSummary,
  deviceInfo: bsConfig.device,
  createBrowserstackDriverSession,
};
