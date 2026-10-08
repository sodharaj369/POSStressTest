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

// Non-secret settings: browserstack.json defaults, overridden by BROWSERSTACK_* env vars.
function getEffectiveConfig() {
  return {
    appId: envString('BROWSERSTACK_APP_ID', bsConfig.appId),
    deviceName: envString('BROWSERSTACK_DEVICE', bsConfig.device.deviceName),
    platformVersion: envString('BROWSERSTACK_PLATFORM_VERSION', bsConfig.device.platformVersion),
    projectName: envString('BROWSERSTACK_PROJECT', bsConfig.project.projectName),
    buildName: envString('BROWSERSTACK_BUILD', bsConfig.project.buildName),
    sessionName: envString('BROWSERSTACK_SESSION', bsConfig.project.sessionName),
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
  const c = getEffectiveConfig();
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

function buildBrowserstackRemoteOptions(reason = 'browserstack-proof') {
  const { username, accessKey } = getCredentials();
  if (!username || !accessKey) {
    throw new Error(
      'BrowserStack credentials missing. Set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY environment variables before running this command.'
    );
  }

  const c = getEffectiveConfig();
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
        sessionName: `${c.sessionName} (${reason})`,
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
