'use strict';

// Single place where LOCAL vs BROWSERSTACK differ for test.js.
// Default is local. Set EXECUTION_ENV=browserstack (see npm run stress:browserstack).

const { remote } = require('webdriverio');

const BROWSERSTACK = 'browserstack';
const LOCAL = 'local';

function getExecutionEnv() {
  const env = String(process.env.EXECUTION_ENV || LOCAL).trim().toLowerCase();
  if (env !== LOCAL && env !== BROWSERSTACK) {
    throw new Error(`Unknown EXECUTION_ENV "${env}". Use "local" or "browserstack".`);
  }
  return env;
}

function isBrowserstack() {
  return getExecutionEnv() === BROWSERSTACK;
}

// local: caller passes its existing local remote() options, unchanged.
async function createDriver(env, localRemoteOptions) {
  if (env === BROWSERSTACK) {
    const { buildBrowserstackRemoteOptions } = require('./browserstackDriver');
    return remote(buildBrowserstackRemoteOptions('stress', 'stress'));
  }
  return remote(localRemoteOptions);
}

// BrowserStack has no ADB access to the cloud device. Same shapes as utils/adb.js so control flow
// is unchanged; test.js reports these checks as "N/A" instead of using these return values.
// getAppMemoryUsage returns null: no memory data is recorded on BrowserStack.
const browserstackAdbHelpers = {
  reconnectAdb: () => false,
  ensureAdbConnected: () => true,
  checkNetworkStatus: () => true,
  getAppMemoryUsage: () => null,
  resetUiAutomator2Server: () => {},
};

function getAdbHelpers() {
  return isBrowserstack() ? browserstackAdbHelpers : require('./adb');
}

// BrowserStack app restart through Appium (no ADB). Throws if the app cannot be activated,
// so callers only count a restart when it really happened.
async function restartAppViaAppium(driver, appPackage) {
  try {
    await driver.terminateApp(appPackage);
  } catch (_e) {
    // app may already be stopped; activateApp below decides success
  }
  await driver.activateApp(appPackage);
}

function describeSession(driver) {
  const caps = (driver && driver.capabilities) || {};
  return {
    sessionId: driver && driver.sessionId,
    deviceName: caps.deviceName || (caps['appium:deviceName']) || '',
    platformVersion: caps.platformVersion || caps['appium:platformVersion'] || '',
  };
}

module.exports = {
  getExecutionEnv,
  isBrowserstack,
  createDriver,
  getAdbHelpers,
  restartAppViaAppium,
  describeSession,
};
