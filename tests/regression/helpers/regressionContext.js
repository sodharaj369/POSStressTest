'use strict';

const fs = require('fs');
const path = require('path');
const { remote } = require('webdriverio');
const { execSync } = require('child_process');

const config = require('../../../config.json');
const locators = require('../../../locators.json');
const BasePage = require('../../../pages/BasePage');
const DashboardPage = require('../../../pages/DashboardPage');
const LoginPage = require('../../../pages/LoginPage');
const OnboardingPage = require('../../../pages/OnboardingPage');
const HierarchyPage = require('../../../pages/HierarchyPage');
const POSPage = require('../../../pages/POSPage');
const CheckoutPage = require('../../../pages/CheckoutPage');
const { handleGlobalPopups } = require('../../../utils/popupManager');
const { log } = require('../../../utils/logger');
const { resetUiAutomator2Server, ensureAdbConnected } = require('../../../utils/adb');
const { assertCondition } = require('../assertions/assertions');

const defaultLocatorSnapshot = {
  schoolDev: locators.schoolDev,
  hierarchyLeft: locators.hierarchyLeft,
  hierarchyRight: locators.hierarchyRight,
  menuOption: locators.menuOption,
};

if (config.schoolDev) locators.schoolDev = config.schoolDev;
if (config.hierarchyLeft) locators.hierarchyLeft = config.hierarchyLeft;
if (config.hierarchyRight) locators.hierarchyRight = config.hierarchyRight;
if (config.menuOption) locators.menuOption = config.menuOption;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseConfigList(value) {
  if (!value) return [];
  return String(value).split(',').map((v) => v.trim()).filter(Boolean);
}

function getConfiguredChild() {
  const children = parseConfigList(config.childName);
  assertCondition(children.length > 0, 'No child is configured in config.json', 'At least one configured childName', 'childName is empty');
  return children[0];
}

function getConfiguredProduct() {
  const productFromLegacy = parseConfigList(config.productName);
  if (productFromLegacy.length > 0) return productFromLegacy[0];

  if (Array.isArray(config.cartProducts) && config.cartProducts.length > 0 && config.cartProducts[0].name) {
    return String(config.cartProducts[0].name);
  }

  if (Array.isArray(config.products) && config.products.length > 0) {
    const first = config.products[0];
    if (typeof first === 'string') return first;
    if (first && first.name) return String(first.name);
  }

  throw new Error('No configured test product found in config.json');
}

async function checkAppiumHealth() {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: 4723,
      path: '/status',
      timeout: 4000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const status = JSON.parse(data);
          if (status.value && status.value.ready) {
            resolve(true);
            return;
          }
          reject(new Error('Appium server is not ready'));
        } catch (e) {
          reject(new Error(`Appium status parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Appium server not reachable: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Appium status request timed out'));
    });
  });
}

function getDeviceUdid() {
  const configured = config.udid && String(config.udid).trim();
  if (configured) return configured;

  const output = execSync('adb devices').toString();
  const lines = output.trim().split('\n').slice(1);
  const devices = lines
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[1] === 'device')
    .map((parts) => parts[0]);

  if (devices.length === 1) {
    return devices[0];
  }

  throw new Error('Unable to determine device UDID. Configure a single device with config.udid for functional regression.');
}

function buildRemoteOptions(targetUdid) {
  return {
    hostname: '127.0.0.1',
    port: 4723,
    path: '/',
    connectionRetryTimeout: config.connectionRetryTimeoutMs || 120000,
    connectionRetryCount: config.connectionRetryCount !== undefined ? config.connectionRetryCount : 1,
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:deviceName': 'Android',
      'appium:udid': targetUdid,
      'appium:appPackage': 'com.parentpay.PointOfService',
      'appium:appActivity': 'com.parentpay.PointOfService.MainActivity',
      'appium:noReset': true,
      'appium:newCommandTimeout': config.newCommandTimeout || 300,
      'appium:adbExecTimeout': config.adbExecTimeoutMs || 120000,
      'appium:uiautomator2ServerInstallTimeout': config.uia2InstallTimeoutMs || 120000,
      'appium:uiautomator2ServerLaunchTimeout': config.uia2LaunchTimeoutMs || 120000,
      'appium:disableWindowAnimation': config.disableWindowAnimation !== false,
      'appium:ignoreHiddenApiPolicyError': true,
    },
  };
}

async function createDriverSession(targetUdid, reason = 'functional-regression') {
  const attempts = config.driverInitRetries || 3;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      log('SETUP', `Creating Appium session (${reason}) attempt ${attempt}/${attempts}`);
      const driver = await remote(buildRemoteOptions(targetUdid));
      await driver.getWindowSize();
      return driver;
    } catch (e) {
      lastError = e;
      log('SETUP_WARNING', `Session creation failed: ${e.message}`);
      try {
        resetUiAutomator2Server(targetUdid);
        execSync(`adb -s ${targetUdid} shell am force-stop com.parentpay.PointOfService`);
        execSync(`adb -s ${targetUdid} shell am start -n com.parentpay.PointOfService/com.parentpay.PointOfService.MainActivity`);
      } catch (resetErr) {
        log('ADB_WARNING', `Driver creation recovery warning: ${resetErr.message}`);
      }
      await sleep(2500);
    }
  }

  throw new Error(`Unable to create Appium session: ${lastError ? lastError.message : 'Unknown error'}`);
}

async function launchOrActivateApp(driver, targetUdid) {
  try {
    await driver.activateApp('com.parentpay.PointOfService');
  } catch (e) {
    log('SETUP_WARNING', `activateApp failed: ${e.message}. Falling back to adb start.`);
    execSync(`adb -s ${targetUdid} shell am start -n com.parentpay.PointOfService/com.parentpay.PointOfService.MainActivity`);
  }
  await driver.pause(1500);
}

async function waitForKnownState(driver, timeoutMs = 30000) {
  const start = Date.now();
  let lastState = 'unknown';

  // Once per call, not per loop pass. No-op when onboarding is already completed.
  try {
    await OnboardingPage.handleIfRequired(driver);
  } catch (e) {
    log('WARN', `Onboarding handler error: ${e.message}`);
  }

  while ((Date.now() - start) < timeoutMs) {
    // PIN login (no-op when authenticated). Throws on failure so it is not reported as unknown state.
    await LoginPage.loginIfRequired(driver);

    try {
      await handleGlobalPopups(driver);
      await BasePage.checkForAlertsAndDismiss(driver);
    } catch (e) {
      // best effort popup handling
    }

    const state = await BasePage.detectCurrentState(driver);
    if (state && state !== 'unknown') {
      return state;
    }

    lastState = state;
    await driver.pause(750);
  }

  return lastState;
}

async function tryClickMenuOptionFallback(driver) {
  const candidates = [];
  if (config.menuOption) candidates.push(String(config.menuOption));
  if (defaultLocatorSnapshot.menuOption) candidates.push(String(defaultLocatorSnapshot.menuOption));

  for (const option of [...new Set(candidates)]) {
    try {
      const match = await driver.$$(`android=new UiSelector().text("${option}")`);
      if (match.length > 0 && await match[0].isDisplayed().catch(() => false)) {
        await BasePage.safeClick(driver, match[0]);
        return option;
      }
    } catch (e) {
      // continue with next candidate
    }
  }

  // If no candidate is immediately visible, keep proven stress behavior as fallback.
  await POSPage.clickMenuOption(driver);
  return locators.menuOption;
}

async function clickCandidateText(driver, candidates, areaKey = 'global', contains = false) {
  const unique = [...new Set(candidates.filter(Boolean).map((v) => String(v)))];

  for (const value of unique) {
    try {
      if (contains) {
        await BasePage.clickTextContains(driver, value, areaKey);
      } else {
        await BasePage.clickText(driver, value, areaKey);
      }
      return value;
    } catch (e) {
      // continue with next candidate
    }
  }

  throw new Error(`None of the expected values were found: ${unique.join(', ')}`);
}

async function selectSchoolForRegression(driver) {
  return clickCandidateText(
    driver,
    [config.schoolDev, defaultLocatorSnapshot.schoolDev],
    'hierarchyList',
    true
  );
}

async function selectLeftOptionForRegression(driver) {
  return clickCandidateText(
    driver,
    [config.hierarchyLeft, defaultLocatorSnapshot.hierarchyLeft],
    'hierarchyList',
    false
  );
}

async function selectRightOptionForRegression(driver) {
  return clickCandidateText(
    driver,
    [config.hierarchyRight, defaultLocatorSnapshot.hierarchyRight],
    'hierarchyList',
    false
  );
}

async function completeHierarchySetupForRegression(driver) {
  const posBtn = await driver.$(`android=new UiSelector().text("${locators.posButton}")`);
  if (await posBtn.isDisplayed().catch(() => false)) {
    return;
  }

  try {
    await selectRightOptionForRegression(driver);
  } catch (rightErr) {
    // If configured right option is unavailable, allow currently-selected device context to continue.
    log('HIERARCHY_WARNING', `Configured right hierarchy option unavailable (${rightErr.message}). Proceeding with existing selection.`);
  }

  await driver.pause(1500);
  await BasePage.clickTextContains(driver, locators.proceedButton);
  const yesButton = await driver.$(`android=new UiSelector().text("${locators.yesButton}")`);
  await yesButton.waitForDisplayed({ timeout: 15000 });
  await BasePage.safeClick(driver, yesButton);

  const posBtnAfter = await driver.$(`android=new UiSelector().text("${locators.posButton}")`);
  await BasePage.waitVisible(driver, posBtnAfter, 20000);
}

async function ensureAtChildSelection(driver) {
  let state = await waitForKnownState(driver, config.timeouts?.screenLoadWaitMs || 20000);
  if (state === 'unknown') {
    for (let attempt = 1; attempt <= 3 && state === 'unknown'; attempt++) {
      log('STATE_WARN', `Unknown state before navigation. Recovery attempt ${attempt}/3`);
      try {
        await handleGlobalPopups(driver);
        await BasePage.checkForAlertsAndDismiss(driver);
      } catch (e) {
        // best effort only
      }

      try {
        await driver.activateApp('com.parentpay.PointOfService');
      } catch (e) {
        // no-op if activate fails
      }

      await driver.pause(2500);
      state = await waitForKnownState(driver, config.timeouts?.screenLoadWaitMs || 20000);
    }
  }

  log('STATE', `Functional navigation starting from state: ${state}`);

  switch (state) {
    case 'State_D':
      return 'State_D';
    case 'State_C':
      await POSPage.clickName(driver);
      return 'State_D';
    case 'State_F':
      await tryClickMenuOptionFallback(driver);
      await POSPage.clickName(driver);
      return 'State_D';
    case 'State_B':
      await DashboardPage.clickPOS(driver);
      await tryClickMenuOptionFallback(driver);
      await POSPage.clickName(driver);
      return 'State_D';
    case 'State_G':
      await CheckoutPage.clickPay(driver);
      return ensureAtChildSelection(driver);
    case 'State_H':
      await POSPage.clickSelectWallet(driver);
      await CheckoutPage.clickPay(driver);
      return ensureAtChildSelection(driver);
    case 'State_E':
      await completeHierarchySetupForRegression(driver);
      await DashboardPage.clickPOS(driver);
      await tryClickMenuOptionFallback(driver);
      await POSPage.clickName(driver);
      return 'State_D';
    case 'State_A':
      await selectSchoolForRegression(driver);
      await selectLeftOptionForRegression(driver);
      await completeHierarchySetupForRegression(driver);
      await DashboardPage.clickPOS(driver);
      await tryClickMenuOptionFallback(driver);
      await POSPage.clickName(driver);
      return 'State_D';
    default:
      throw new Error(`Unable to navigate to child selection from unsupported state: ${state}`);
  }
}

async function ensureSessionHealthy(driver) {
  await driver.getWindowSize();
}

async function captureFailureArtifacts(driver, artifacts, caseId) {
  const stamp = Date.now();
  const screenshotPath = path.join(artifacts.screenshotsDir, `${caseId}_${stamp}.png`);
  const sourcePath = path.join(artifacts.diagnosticsDir, `${caseId}_${stamp}.xml`);

  try {
    await driver.saveScreenshot(screenshotPath);
  } catch (e) {
    // continue even if screenshot capture fails
  }

  try {
    const source = await driver.getPageSource();
    fs.writeFileSync(sourcePath, source, 'utf8');
  } catch (e) {
    // continue even if source capture fails
  }

  return {
    screenshotPath,
    sourcePath,
  };
}

module.exports = {
  config,
  locators,
  checkAppiumHealth,
  getDeviceUdid,
  createDriverSession,
  ensureAdbConnected,
  launchOrActivateApp,
  waitForKnownState,
  ensureAtChildSelection,
  ensureSessionHealthy,
  getConfiguredChild,
  getConfiguredProduct,
  captureFailureArtifacts,
};
