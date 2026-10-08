const BasePage = require('./BasePage');
const locators = require('../locators.json');
const { log } = require('../utils/logger');
const { isBrowserstack } = require('../utils/driverFactory');
const { getRunDir } = require('../utils/runArtifacts');
const LoginPage = require('./LoginPage');
const config = require('../config.json');

const screenReadyTimeoutMs = (config.timeouts && config.timeouts.screenLoadWaitMs) || 20000;
// Back arrow position as a fraction of the screen. Derived from the local tablet tap (131, 65) on 2304x1440.
const BACK_TAP_RATIO = { x: 131 / 2304, y: 65 / 1440 };

class HierarchyPage {
  static async isDisplayed(driver) {
    const header = await driver.$(`android=new UiSelector().text("${locators.hierarchyHeader}")`);
    try {
      return await header.isExisting() && await header.isDisplayed();
    } catch (e) {
      return false;
    }
  }

  static async selectLeftOption(driver) {
    log("HIERARCHY", `Selecting left hierarchy option: "${locators.hierarchyLeft}"...`);
    await BasePage.clickText(driver, locators.hierarchyLeft, 'hierarchyList');
    log("HIERARCHY", "Left hierarchy selected");
  }

  static async selectRightOption(driver) {
    log("HIERARCHY", `Selecting right hierarchy option: "${locators.hierarchyRight}"...`);
    await BasePage.clickText(driver, locators.hierarchyRight, 'hierarchyList');
    log("HIERARCHY", "Right hierarchy selected");
  }

  // BrowserStack only. Saves a screenshot and page source (no input values) for diagnosing hierarchy state.
  static async captureStateDiagnostics(driver, label) {
    try {
      const fs = require('fs');
      const path = require('path');
      const runDir = getRunDir();
      if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
      const base = path.join(runDir, `browserstack_${label}_${Date.now()}`);
      await driver.saveScreenshot(`${base}.png`);
      fs.writeFileSync(`${base}.xml`, await driver.getPageSource(), 'utf8');
      log("DIAGNOSTIC", `Saved BrowserStack ${label} screenshot and page source: ${base}.(png|xml)`);
    } catch (e) {
      log("DIAGNOSTIC_WARNING", `Failed to capture ${label} diagnostics: ${e.message}`);
    }
  }

  // Exact header of the school list. The hierarchy page header is longer ("...school outlet hierarchy"), so it does not match.
  static async isSchoolSelectionScreen(driver) {
    const header = await driver.$$(`android=new UiSelector().text("${locators.schoolListHeader || 'Choose the school'}")`);
    return header.length > 0 && await header[0].isDisplayed().catch(() => false);
  }

  static async isSchoolListDisplayed(driver) {
    const state = await BasePage.detectCurrentState(driver);
    if (state === 'State_A') return { ok: true, state };
    if (await this.isSchoolSelectionScreen(driver)) return { ok: true, state: 'State_A' };
    const school = await driver.$$(`android=new UiSelector().textContains("${locators.schoolDev}")`);
    const found = school.length > 0 && await school[0].isDisplayed().catch(() => false);
    return { ok: found, state: found ? 'State_A' : state };
  }

  /**
   * BrowserStack only. Waits for the expected screen and fails fast on the PIN screen.
   * mode "school": school list (State_A). mode "hierarchy": school list or hierarchy page (State_A / State_E).
   */
  static async waitForSchoolSelectionScreen(driver, mode = 'hierarchy') {
    const start = Date.now();
    let state = 'unknown';
    while ((Date.now() - start) < screenReadyTimeoutMs) {
      if (await LoginPage.isPinScreenDisplayed(driver)) {
        throw new Error('Unexpected screen: PIN screen is displayed, expected school selection/hierarchy.');
      }
      const school = await this.isSchoolListDisplayed(driver);
      state = school.state;
      if (school.ok || (mode === 'hierarchy' && state === 'State_E')) return state;
      await driver.pause(250);
    }
    throw new Error(`Unexpected screen state "${state}" after ${screenReadyTimeoutMs}ms, expected school selection/hierarchy.`);
  }

  static async selectSchool(driver) {
    if (isBrowserstack()) {
      await this.waitForSchoolSelectionScreen(driver, 'school');
    }
    log("HIERARCHY", `Selecting school: "${locators.schoolDev}"...`);
    try {
      await BasePage.clickText(driver, locators.schoolDev, 'hierarchyList');
    } catch (exactErr) {
      log("HIERARCHY_WARNING", `Exact school match failed: ${exactErr.message}. Retrying with textContains...`);
      await BasePage.clickTextContains(driver, locators.schoolDev, 'hierarchyList');
    }
    log("HIERARCHY", "School selected");
  }

  static async completeHierarchySetup(driver) {
    log("HIERARCHY", "Completing hierarchy selection flow...");
    await this.selectRightOption(driver);

    await driver.pause(5000);
    log("HIERARCHY", "Waiting for Proceed button...");
    await BasePage.clickTextContains(driver, locators.proceedButton);
    log("HIERARCHY", "Proceed clicked");

    log("HIERARCHY", "Waiting for confirmation popup...");
    const yesButton = await driver.$(`android=new UiSelector().text("${locators.yesButton}")`);
    await yesButton.waitForDisplayed({ timeout: 15000 });
    await BasePage.safeClick(driver, yesButton);
    log("HIERARCHY", "Clicked YES on popup");

    // STATE VERIFICATION: Ensure we transitioned back to Dashboard successfully
    log("HIERARCHY", "Verifying Dashboard loaded successfully...");
    const posBtn = await driver.$(`android=new UiSelector().text("${locators.posButton}")`);
    await BasePage.waitVisible(driver, posBtn, 20000);
  }

  static async clickBackButton(driver) {
    log("HIERARCHY", "Clicking back button to return to school selection...");
    try {
      // Direct ADB input tap on the back button coordinates to guarantee navigation!
      const targetUdid = isBrowserstack() ? "" : (driver.capabilities.udid || "");
      if (targetUdid) {
        log("HIERARCHY", `Executing ADB input tap at [131, 65] on device "${targetUdid}"...`);
        const { execSync } = require('child_process');
        execSync(`adb -s ${targetUdid} shell input tap 131 65`);
        await driver.pause(3000);
        return;
      }
    } catch (adbErr) {
      log("HIERARCHY_WARNING", `ADB input tap failed: ${adbErr.message}`);
    }

    if (isBrowserstack()) {
      const rect = await driver.getWindowRect();
      const x = Math.round(rect.width * BACK_TAP_RATIO.x);
      const y = Math.round(rect.height * BACK_TAP_RATIO.y);
      log("HIERARCHY", `Tapping back arrow via W3C pointer at [${x}, ${y}] (window ${rect.width}x${rect.height})...`);
      await driver.action('pointer', { parameters: { pointerType: 'touch' } })
        .move({ x, y })
        .down()
        .up()
        .perform();
      const state = await this.waitForSchoolSelectionScreen(driver, 'school');
      log("HIERARCHY", `Back navigation verified: ${state} (school selection)`);
      return;
    }

    try {
      // Tap at coordinates (100, 65) which is the absolute center area of the top-left back arrow
      log("HIERARCHY", "Tapping back arrow at coordinates [100, 65]...");
      await driver.execute('mobile: clickGesture', { x: 100, y: 65 });
      await driver.pause(3000);
      return;
    } catch (e) {
      log("HIERARCHY_WARNING", `Failed to click back coordinates: ${e.message}`);
    }

    try {
      const backBtn = await driver.$('android=new UiSelector().text("")');
      if (await backBtn.isExisting() && await backBtn.isDisplayed()) {
        await BasePage.safeClick(driver, backBtn);
        log("HIERARCHY", "Back button clicked successfully");
        await driver.pause(3000);
        return;
      }
    } catch (e) {
      log("HIERARCHY_WARNING", `Failed to click back button: ${e.message}`);
    }
    log("HIERARCHY", "Falling back to system back gesture...");
    await driver.back();
    await driver.pause(3000);
  }
}

module.exports = HierarchyPage;
