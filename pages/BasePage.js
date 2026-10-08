const locators = require('../locators.json');
const config = require('../config.json');
const { log } = require('../utils/logger');
const stability = require('../utils/stabilityMetrics');
const { getRunDir } = require('../utils/runArtifacts');
const { handleGlobalPopups } = require('../utils/popupManager');

const defaultWait = (config.timeouts && config.timeouts.defaultWaitMs) || 15000;
const scrollSettleDelay = config.connectionMode === 'usb' ? 500 : 1500;
const defaultSwipeAreas = {
  global: { left: 0.15, top: 0.2, width: 0.7, height: 0.6 },
  hierarchyList: { left: 0.12, top: 0.22, width: 0.42, height: 0.56 },
  childList: { left: 0.12, top: 0.22, width: 0.45, height: 0.56 }
};

class BasePage {
  static getSwipeArea(areaKey = 'global') {
    const profileName = config.deviceProfile;
    const profileAreas = (config.swipeProfiles && profileName && config.swipeProfiles[profileName]) || {};
    const directOverrides = (config.swipeAreas && config.swipeAreas[areaKey]) || {};
    const profileOverrides = (profileAreas && profileAreas[areaKey]) || {};
    const defaults = defaultSwipeAreas[areaKey] || defaultSwipeAreas.global;

    return {
      left: defaults.left,
      top: defaults.top,
      width: defaults.width,
      height: defaults.height,
      ...profileOverrides,
      ...directOverrides
    };
  }

  static async swipe(driver, direction = 'up', percent = 0.75, areaKey = 'global') {
    const rect = await driver.getWindowRect();
    const area = this.getSwipeArea(areaKey);

    const left = Math.floor(rect.width * area.left);
    const top = Math.floor(rect.height * area.top);
    const width = Math.floor(rect.width * area.width);
    const height = Math.floor(rect.height * area.height);

    await driver.execute('mobile: swipeGesture', {
      left,
      top,
      width,
      height,
      direction,
      percent
    });
  }

  static async swipeUp(driver, percent = 0.75, areaKey = 'global') {
    await this.swipe(driver, 'up', percent, areaKey);
  }

  static async swipeDown(driver, percent = 0.75, areaKey = 'global') {
    await this.swipe(driver, 'down', percent, areaKey);
  }

  /**
   * Deterministic screen state detector.
   * Maps current screen elements to defined states A through H, or unknown.
   */
  static async detectCurrentState(driver) {
    try {
      const isVisible = async (selector) => {
        try {
          const els = await driver.$$(selector);
          return els.length > 0 && await els[0].isDisplayed().catch(() => false);
        } catch (e) {
          return false;
        }
      };

      // 1. State D: Search Child Overlay (looks for CLOSE button)
      if (await isVisible(`android=new UiSelector().text("${locators.closeButton}")`)) {
        return 'State_D';
      }

      // 2. State H: POS Product list with Select Wallet enabled/displayed
      if (await isVisible(`android=new UiSelector().text("${locators.selectWalletButton}")`)) {
        return 'State_H';
      }

      // 3. State G: Checkout/Pay page (looks for Pay button)
      if (await isVisible(`android=new UiSelector().text("${locators.payButton}")`)) {
        return 'State_G';
      }

      // 4. State C: POS Main ordering page (looks for Name button)
      if (await isVisible(`android=new UiSelector().text("${locators.nameButton}")`)) {
        return 'State_C';
      }

      // 5. State B: Dashboard (looks for POS button)
      if (await isVisible(`android=new UiSelector().text("${locators.posButton}")`)) {
        return 'State_B';
      }

      // 6. State E: Hierarchy Selection.
      // Some builds vary header text, so keep flexible fallbacks.
      if (
        await isVisible(`android=new UiSelector().text("${locators.hierarchyHeader}")`) ||
        await isVisible(`android=new UiSelector().textContains("school outlet hierarchy")`) ||
        await isVisible(`android=new UiSelector().textContains("Choose the school")`) ||
        await isVisible(`android=new UiSelector().text("${locators.proceedButton}")`)
      ) {
        return 'State_E';
      }

      // 7. State A: School Selection — checked BEFORE State_F to prevent prod menus
      // named "Hospitality" (same as menuOption) from being mistaken for the POS menu screen.
      if (
        await isVisible(`android=new UiSelector().text("${locators.schoolDev}")`) ||
        await isVisible(`android=new UiSelector().textContains("School")`) ||
        await isVisible(`android=new UiSelector().textContains("school")`)
      ) {
        return 'State_A';
      }

      // 8. State F: POS Menu (looks for SENIOR POS MENU button or custom menuOption)
      // Placed after State_A to avoid false-positive when school name matches menuOption text.
      if (await isVisible(`android=new UiSelector().text("${locators.menuOption}")`)) {
        return 'State_F';
      }
    } catch (e) {
      log("STATE_WARN", `Error during state detection: ${e.message}`);
    }
    return 'unknown';
  }

  static async findElementFast(driver, text, areaKey = 'global') {
    const exactSelector = `android=new UiSelector().text("${text}")`;
    const _t0 = Date.now();
    const executionMode = process.env.EXECUTION_MODE || config.executionMode || 'standard';
    const isRapid = executionMode === 'rapid';
    const maxRetries = isRapid ? 2 : 25;
    const settleDelay = isRapid ? 200 : scrollSettleDelay;

    // ── INITIAL LOOKUP ──────────────────────────────────────────────────────
    // Single non-blocking probe — return immediately if element is already visible.
    log("FASTPATH", `Immediate lookup started`);
    try {
      const initialCandidates = await driver.$$(exactSelector);
      const _initialLookupMs = Date.now() - _t0;
      if (initialCandidates.length > 0 && await initialCandidates[0].isDisplayed()) {
        log("FASTPATH", `Element found immediately | lookup=${_initialLookupMs}ms`);
        return initialCandidates[0];
      }
    } catch (e) {}

    // ── RETRY LOOP ──────────────────────────────────────────────────────────
    // Element not yet visible — allow up to ~1s for layout inflation (24 × 40ms).
    log("FASTPATH", `Retry loop entered`);
    let _retryCount = 0;
    const _retryStart = Date.now();
    for (let i = 1; i < maxRetries; i++) {
      await driver.pause(40);
      _retryCount++;
      log("FASTPATH", `Retry #${_retryCount}`);
      try {
        const candidates = await driver.$$(exactSelector);
        if (candidates.length > 0 && await candidates[0].isDisplayed()) {
          const _retryLoopMs = Date.now() - _retryStart;
          log("FASTPATH", `Element found | retry=${_retryCount} | retry_loop=${_retryLoopMs}ms | total=${Date.now() - _t0}ms`);
          return candidates[0];
        }
      } catch (e) {}
    }

    // ── SCROLL ACTIVATION ───────────────────────────────────────────────────
    const _scrollStart = Date.now();
    log("FASTPATH", `Scroll activated | pre_scroll=${_scrollStart - _t0}ms`);
    // Scroll with exact text matching
    log("SCROLL", `Element "${text}" not instantly visible. Scrolling...`);
    try {
      await driver.$(
        `android=new UiScrollable(new UiSelector().scrollable(true)).setAsVerticalList().scrollIntoView(new UiSelector().text("${text}"))`
      );
    } catch (scrollErr) {
      log("SCROLL_WARNING", `Scrollable list not found: ${scrollErr.message}. Checking direct visibility again...`);
    }

    await driver.pause(settleDelay); // let scroll settle
    log("FASTPATH", `Scroll completed | scroll=${Date.now() - _scrollStart}ms`);
    
    // RE-FIND the element after scrolling to refresh its coordinates and elementId!
    const freshElement = await driver.$(exactSelector);
    try {
      if (await freshElement.isDisplayed()) {
        return freshElement;
      }
    } catch (e) {}

    const finalElement = await driver.$(exactSelector);
    if (await finalElement.isDisplayed()) {
      return finalElement;
    }

    // Fallback for MAUI/Recycler layouts where UiScrollable metadata is unreliable.
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        await this.swipeUp(driver, 0.75, areaKey);
      } catch (swipeErr) {
        log("SCROLL_WARNING", `Swipe attempt ${attempt} failed: ${swipeErr.message}`);
      }

      await driver.pause(settleDelay);
      const swipedElement = await driver.$(exactSelector);
      try {
        if (await swipedElement.isDisplayed()) {
          return swipedElement;
        }
      } catch (e) {}
    }

    // If target is above current viewport, search back in reverse direction.
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        await this.swipeDown(driver, 0.75, areaKey);
      } catch (swipeErr) {
        log("SCROLL_WARNING", `Reverse swipe attempt ${attempt} failed: ${swipeErr.message}`);
      }

      await driver.pause(settleDelay);
      const swipedElement = await driver.$(exactSelector);
      try {
        if (await swipedElement.isDisplayed()) {
          return swipedElement;
        }
      } catch (e) {}
    }

    throw new Error(`Element with exact text "${text}" not found/displayed after scrolling`);
  }

  static async findElementContainsFast(driver, text, areaKey = 'global') {
    const selectorStr = `android=new UiSelector().textContains("${text}")`;
    const _t0 = Date.now();
    const executionMode = process.env.EXECUTION_MODE || config.executionMode || 'standard';
    const isRapid = executionMode === 'rapid';
    const maxRetries = isRapid ? 2 : 25;
    const settleDelay = isRapid ? 200 : scrollSettleDelay;

    // ── INITIAL LOOKUP ──────────────────────────────────────────────────────
    // Single non-blocking probe: if the element is already visible, return
    // immediately with no pause or retry overhead.
    try {
      const initialCandidates = await driver.$$(selectorStr);
      const _initialLookupMs = Date.now() - _t0;
      if (initialCandidates.length > 0 && await initialCandidates[0].isDisplayed()) {
        log("FASTPATH", `Element found immediately | lookup=${_initialLookupMs}ms`);
        return initialCandidates[0];
      }
    } catch (e) {}

    // ── RETRY LOOP ──────────────────────────────────────────────────────────
    // Element not yet visible — allow up to ~2.4s for layout inflation.
    let _retryCount = 0;
    const _retryStart = Date.now();
    for (let i = 1; i < maxRetries; i++) {
      await driver.pause(100);
      _retryCount++;
      try {
        const candidates = await driver.$$(selectorStr);
        if (candidates.length > 0 && await candidates[0].isDisplayed()) {
          const _retryLoopMs = Date.now() - _retryStart;
          log("FASTPATH", `Retries executed: ${_retryCount} | retry_loop=${_retryLoopMs}ms | total=${Date.now() - _t0}ms`);
          return candidates[0];
        }
      } catch (e) {}
    }

    // ── SCROLL ACTIVATION ───────────────────────────────────────────────────
    const _scrollStart = Date.now();
    log("FASTPATH", `Scroll activated | pre_scroll_elapsed=${_scrollStart - _t0}ms`);
    log("SCROLL", `Element "${text}" not instantly visible. Scrolling...`);
    try {
      await driver.$(
        `android=new UiScrollable(new UiSelector().scrollable(true)).setAsVerticalList().scrollIntoView(new UiSelector().textContains("${text}"))`
      );
    } catch (scrollErr) {
      log("SCROLL_WARNING", `Scrollable list not found: ${scrollErr.message}. Checking direct visibility again...`);
    }

    await driver.pause(settleDelay); // let scroll settle
    log("FASTPATH", `Scroll completed | scroll=${Date.now() - _scrollStart}ms`);
    
    // RE-FIND the element after scrolling to refresh its coordinates and elementId!
    const freshElement = await driver.$(selectorStr);
    try {
      if (await freshElement.isDisplayed()) {
        return freshElement;
      }
    } catch (e) {}


    const finalElement = await driver.$(selectorStr);
    if (await finalElement.isDisplayed()) {
      return finalElement;
    }

    // Fallback for MAUI/Recycler layouts where UiScrollable metadata is unreliable.
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        await this.swipeUp(driver, 0.75, areaKey);
      } catch (swipeErr) {
        log("SCROLL_WARNING", `Swipe attempt ${attempt} failed: ${swipeErr.message}`);
      }

      await driver.pause(settleDelay);
      const swipedElement = await driver.$(selectorStr);
      try {
        if (await swipedElement.isDisplayed()) {
          return swipedElement;
        }
      } catch (e) {}
    }

    // If target is above current viewport, search back in reverse direction.
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        await this.swipeDown(driver, 0.75, areaKey);
      } catch (swipeErr) {
        log("SCROLL_WARNING", `Reverse swipe attempt ${attempt} failed: ${swipeErr.message}`);
      }

      await driver.pause(settleDelay);
      const swipedElement = await driver.$(selectorStr);
      try {
        if (await swipedElement.isDisplayed()) {
          return swipedElement;
        }
      } catch (e) {}
    }

    throw new Error(`Element containing text "${text}" not found/displayed after scrolling`);
  }

  static async waitVisible(driver, el, timeout = defaultWait) {
    await el.waitForDisplayed({ timeout });
  }

  static async safeClick(driver, el, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      try {
        // Prioritize native click to support correct event bubbling in virtualized lists (e.g. child rows)
        await el.click();
        return;
      } catch (e) {
        log("WARN", `Native click failed (attempt ${i + 1}/${retries + 1}): ${e.message}`);
        
        // INTERCEPTOR HOOK: Proactively check for system dialogs/popups blocking layout
        await this.checkForAlertsAndDismiss(driver);
        
        try {
          // Fall back to coordinate-based clickGesture
          await driver.execute('mobile: clickGesture', {
            elementId: el.elementId
          });
          return;
        } catch (gestureErr) {
          if (i === retries) {
            throw new Error(`safeClick failed after ${retries} retries. Last error: ${gestureErr.message}`);
          }
          await driver.pause(350);
        }
      }
    }
  }

  static async clickText(driver, text, areaKey = 'global') {
    const el = await this.findElementFast(driver, text, areaKey);
    await this.safeClick(driver, el);
  }

  static async clickTextContains(driver, text, areaKey = 'global') {
    const el = await this.findElementContainsFast(driver, text, areaKey);
    await this.safeClick(driver, el);
  }

  /**
   * System-wide popup and alert interceptor.
   * Auto-detects and dismisses common app error modals and Android system alerts.
   */
  static async checkForAlertsAndDismiss(driver) {
    try {
      // 1. Run global popup handler first
      const handledGlobal = await handleGlobalPopups(driver);
      if (handledGlobal) {
        return true;
      }

      // Consolidated XPath targeting:
      // 1. Configured ParentPay POS popups/modals
      // 2. Native OS Dialog buttons (Wait, OK, Close app, Dismiss, Retry, Close, CLOSE)
      const popupButtons = [
        ...locators.alerts,
        "Wait",
        "Close app"
      ];
      
      const xpath = `//*[@text="${popupButtons.join('" or @text="')}"]`;
      const alertButtons = await driver.$$(xpath);
      if (alertButtons.length > 0 && await alertButtons[0].isDisplayed().catch(() => false)) {
        const btnText = await alertButtons[0].getText();
        log("POPUP", `👉 Intercepted popup/alert! Auto-dismissing with button: "${btnText}"`);
        await alertButtons[0].click();
        await driver.pause(3000); // Wait for popup transition to fade out
        stability.increment('popupRecoveries');
        return true;
      }
    } catch (e) {
      // Silent catch to prevent watchdog interference
    }
    return false;
  }

  /**
   * Enterprise-Grade Transition Monitor.
   * Periodically monitors app state during slow rendering or network-heavy transitions.
   * 
   * @param {object} driver - The Appium driver instance.
   * @param {function} successPredicate - Async function returning boolean if target state is successfully loaded.
   * @param {number} maxTimeoutMs - Maximum time to wait for transition (default 60000ms).
   * @param {number} pollIntervalMs - Interval between state checks (default 1000ms).
   * @returns {Promise<boolean>} Resolves to true if successful, throws error on crash/timeout.
   */
  static async monitorTransition(driver, successPredicate, maxTimeoutMs = 60000, pollIntervalMs = 1000) {
    const startTime = Date.now();
    log("TRANSITION", `Starting transition monitor (max timeout: ${maxTimeoutMs}ms)...`);
    let pollCount = 0;
    
    while ((Date.now() - startTime) < maxTimeoutMs) {
      // 1. Check for success state first
      try {
        if (await successPredicate()) {
          log("TRANSITION", `🎯 Target screen state loaded successfully in ${Date.now() - startTime}ms`);
          return true;
        }
      } catch (err) {
        // If driver session is dead or socket error occurred, let it bubble up to trigger restart
        const errMsg = err.message.toLowerCase();
        if (errMsg.includes("socket") || errMsg.includes("refused") || errMsg.includes("connection") || errMsg.includes("session") || errMsg.includes("instrumentation")) {
          throw err;
        }
      }
      
      // 2. Check for alerts only every 5 polls to avoid hammering UiAutomator2 on Samsung devices
      pollCount++;
      if (pollCount % 5 === 0) {
        try {
          await this.checkForAlertsAndDismiss(driver);
        } catch (alertErr) {
          const errMsg = alertErr.message.toLowerCase();
          if (errMsg.includes("instrumentation") || errMsg.includes("socket") || errMsg.includes("session")) {
            throw alertErr; // propagate real crashes
          }
          // otherwise silent - alert check failure is non-fatal
        }
      }
      
      await driver.pause(pollIntervalMs);
    }
    
    throw new Error(`Transition timed out after ${maxTimeoutMs}ms without reaching target state`);
  }

  static async saveFailureScreenshot(driver, contextName) {
    try {
      const fs = require('fs');
      const path = require('path');
        const runDir = getRunDir();
        if (!fs.existsSync(runDir)) {
          fs.mkdirSync(runDir, { recursive: true });
      }
        const filename = `screenshot_error_${contextName}_${Date.now()}.png`;
        const filepath = path.join(runDir, filename);
      await driver.saveScreenshot(filepath);
      stability.increment('screenshotsCaptured');
        log("SCREENSHOT", `Saved failure screenshot to: ${filepath}`);
      BasePage.lastScreenshotPath = filepath;
      return filepath;
    } catch (e) {
      log("SCREENSHOT_ERROR", `Failed to save screenshot: ${e.message}`);
    }
  }
}

BasePage.lastScreenshotPath = '';

module.exports = BasePage;
