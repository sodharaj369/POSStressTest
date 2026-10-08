'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./logger');
const { getRunDir } = require('./runArtifacts');
const stability = require('./stabilityMetrics');

/**
 * Diagnostic helper to capture failure state screenshot and XML page source.
 * Saved directly to current execution's run folder.
 */
async function capturePopupDiagnostics(driver, popupName) {
  try {
    const runDir = getRunDir();
    if (!fs.existsSync(runDir)) {
      fs.mkdirSync(runDir, { recursive: true });
    }
    const timestamp = Date.now();

    // 1. Capture and save screenshot
    const ssFilename = `screenshot_popup_error_${popupName}_${timestamp}.png`;
    const ssFilepath = path.join(runDir, ssFilename);
    await driver.saveScreenshot(ssFilepath);
    stability.increment('screenshotsCaptured');
    log("SCREENSHOT", `Saved popup failure screenshot to: ${ssFilepath}`);

    // 2. Capture and save XML page source
    const xmlFilename = `source_popup_error_${popupName}_${timestamp}.xml`;
    const xmlFilepath = path.join(runDir, xmlFilename);
    const source = await driver.getPageSource();
    fs.writeFileSync(xmlFilepath, source, 'utf8');
    log("POPUP", `Saved page source to: ${xmlFilepath}`);
  } catch (e) {
    log("WARN", `Failed to capture popup diagnostics: ${e.message}`);
  }
}

// List of registered popup handlers
const popupDefinitions = [
  {
    name: 'System Permission',

    // One findElements on permission_message. Empty result means no dialog, so this is a no-op.
    detect: async (driver) => {
      const OnboardingPage = require('../pages/OnboardingPage');
      return !!(await OnboardingPage.getSystemPermissionKind(driver));
    },

    // Reuses the onboarding policy: camera is always denied, notifications follow onboarding.allowNotifications.
    handle: async (driver) => {
      const OnboardingPage = require('../pages/OnboardingPage');
      const handled = await OnboardingPage.handleNotificationPermissionIfPresent(driver);
      if (handled) stability.increment('popupRecoveries');
      return handled;
    }
  },
  {
    name: 'Pending Orders',
    
    /**
     * Detection Criteria:
     * Title contains "Pending Orders on Device" OR body contains "orders which are not yet submitted".
     */
    detect: async (driver) => {
      try {
        const titleSelector = 'android=new UiSelector().textContains("Pending Orders on Device")';
        const bodySelector = 'android=new UiSelector().textContains("orders which are not yet submitted")';

        const titleEls = await driver.$$(titleSelector);
        const bodyEls = await driver.$$(bodySelector);

        const titleDetected = titleEls.length > 0 && await titleEls[0].isDisplayed().catch(() => false);
        const bodyDetected = bodyEls.length > 0 && await bodyEls[0].isDisplayed().catch(() => false);

        return titleDetected || bodyDetected;
      } catch (e) {
        return false;
      }
    },

    /**
     * Action: Click "Close" button. Do NOT click "Go to Orders".
     */
    handle: async (driver) => {
      log("POPUP", "Pending Orders popup detected.");

      try {
        const closeBtnSelector = 'android=new UiSelector().text("Close")';
        const closeBtn = await driver.$(closeBtnSelector);

        if (await closeBtn.isExisting() && await closeBtn.isDisplayed()) {
          await closeBtn.click();
          log("POPUP", "Clicked Close.");
          stability.increment('popupRecoveries');
          // Brief pause for modal transition/fade out
          await driver.pause(1000);
          return true;
        }
      } catch (err) {
        log("WARN", `Error clicking Close button: ${err.message}`);
      }

      // Close button not found or failed to click
      log("WARN", "Pending Orders popup detected but Close button is not found or not clickable.");
      await capturePopupDiagnostics(driver, 'PendingOrders');
      return false;
    }
  }
];

/**
 * Global Popup Handler.
 * Automatically checks and dismisses registered blocking popups.
 * Safe to call repeatedly.
 * 
 * @param {object} driver - The Appium driver instance.
 * @returns {Promise<boolean>} Returns true if a popup was successfully handled, false otherwise.
 */
async function handleGlobalPopups(driver) {
  if (!driver) return false;
  let handledAny = false;

  for (const popup of popupDefinitions) {
    try {
      if (await popup.detect(driver)) {
        const handled = await popup.handle(driver);
        if (handled) {
          handledAny = true;
        }
      }
    } catch (err) {
      log("WARN", `Error in popup handler '${popup.name}': ${err.message}`);
    }
  }

  return handledAny;
}

module.exports = {
  handleGlobalPopups,
  popupDefinitions
};
