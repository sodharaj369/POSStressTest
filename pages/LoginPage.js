const BasePage = require('./BasePage');
const config = require('../config.json');
const locators = require('../locators.json');
const { log } = require('../utils/logger');

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const PIN_LENGTH = 6;
const defaultPostLoginTimeoutMs = 5000;

const byResourceId = (id) => `android=new UiSelector().resourceId("${id}")`;

class LoginPage {
  static isEnabled() {
    return !(config.authentication && config.authentication.enabled === false);
  }

  static getPostLoginTimeoutMs() {
    return (config.authentication && config.authentication.postLoginTimeoutMs) || defaultPostLoginTimeoutMs;
  }

  // Never log the returned value.
  static getConfiguredPin() {
    const pin = process.env.POS_PIN || (config.authentication && config.authentication.pin);
    if (pin === undefined || pin === null || String(pin) === '') {
      throw new Error('Authentication failed: PIN is not configured. Set authentication.pin in config.json or the POS_PIN environment variable.');
    }
    const value = String(pin);
    if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(value)) {
      throw new Error(`Authentication failed: configured PIN must be exactly ${PIN_LENGTH} digits.`);
    }
    return value;
  }

  static async isVisible(driver, selector) {
    try {
      const els = await driver.$$(selector);
      return els.length > 0 && await els[0].isDisplayed().catch(() => false);
    } catch (e) {
      return false;
    }
  }

  // Cheap probe: one lookup when absent; a second lookup only to confirm a real keypad.
  static async isPinScreenDisplayed(driver) {
    const keys = locators.login.digits;
    if (!await this.isVisible(driver, byResourceId(keys.one))) return false;
    return this.isVisible(driver, byResourceId(keys.zero));
  }

  static async isErrorDialogDisplayed(driver) {
    const title = `android=new UiSelector().resourceId("${locators.login.errorDialogTitle}").text("${locators.login.errorDialogTitleText}")`;
    return this.isVisible(driver, title);
  }

  static async getPinInputLength(driver) {
    try {
      const input = await driver.$(`android=new UiSelector().className("${locators.login.pinInputClass}")`);
      return (await input.getText()).length;
    } catch (e) {
      return -1;
    }
  }

  static async enterPin(driver, pin) {
    for (const ch of String(pin)) {
      const id = locators.login.digits[DIGIT_WORDS[Number(ch)]];
      const key = await driver.$(byResourceId(id));
      await BasePage.waitVisible(driver, key, 5000);
      await BasePage.safeClick(driver, key);
    }
  }

  static async clearPin(driver) {
    const backspace = `android=new UiSelector().className("android.widget.Button").text("${locators.login.backspaceText}")`;
    for (let i = 0; i < PIN_LENGTH; i++) {
      if (await this.getPinInputLength(driver) <= 0) return;
      const el = await driver.$(backspace);
      await BasePage.safeClick(driver, el);
    }
  }

  /**
   * Waits for the PIN screen to go away after the last digit.
   * Returns once the keypad is gone. Throws immediately if the error dialog appears.
   */
  static async waitForAuthenticated(driver, timeoutMs = this.getPostLoginTimeoutMs()) {
    const start = Date.now();
    while ((Date.now() - start) < timeoutMs) {
      if (await this.isErrorDialogDisplayed(driver)) {
        throw new Error('Authentication failed: error dialog shown after PIN entry.');
      }
      if (!await this.isPinScreenDisplayed(driver) && !await this.isVisible(driver, byResourceId(locators.login.errorDialogOk))) {
        return Date.now() - start;
      }
      await driver.pause(250);
    }
    if (await this.isErrorDialogDisplayed(driver)) {
      throw new Error('Authentication failed: error dialog shown after PIN entry.');
    }
    throw new Error(`Authentication failed: PIN screen still displayed after ${timeoutMs}ms.`);
  }

  static async waitForKnownState(driver, timeoutMs) {
    const start = Date.now();
    let state = 'unknown';
    while ((Date.now() - start) < timeoutMs) {
      state = await BasePage.detectCurrentState(driver);
      if (state !== 'unknown') return state;
      await driver.pause(500);
    }
    return state;
  }

  /**
   * Dismisses the auth-failure dialog and confirms the PIN screen is back with an empty field.
   * Returns false if the dialog is not showing.
   */
  static async handleInvalidPinDialog(driver) {
    if (!await this.isErrorDialogDisplayed(driver)) return false;

    log("LOGIN", "Authentication error dialog detected. Dismissing.");
    const ok = await driver.$(byResourceId(locators.login.errorDialogOk));
    await BasePage.safeClick(driver, ok);

    const okGone = await driver.waitUntil(
      async () => !await this.isVisible(driver, byResourceId(locators.login.errorDialogOk)),
      { timeout: 5000, interval: 250 }
    ).catch(() => false);
    if (!okGone) throw new Error('Authentication error dialog did not close after pressing Ok.');

    const pinBack = await driver.waitUntil(
      async () => this.isPinScreenDisplayed(driver),
      { timeout: 5000, interval: 250 }
    ).catch(() => false);
    if (!pinBack) throw new Error('PIN screen did not return after dismissing the error dialog.');

    if (await this.getPinInputLength(driver) > 0) {
      await this.clearPin(driver);
    }
    log("LOGIN", "Error dialog dismissed. PIN screen ready for another attempt.");
    return true;
  }

  /**
   * Logs in only if the PIN screen is showing. Returns true if a login was performed, false if not needed.
   * Throws on failure so the app is never silently treated as authenticated.
   */
  static async loginIfRequired(driver) {
    if (!this.isEnabled()) return false;
    if (!await this.isPinScreenDisplayed(driver)) return false;

    log("LOGIN", "PIN screen detected");
    try {
      const pin = this.getConfiguredPin();
      log("LOGIN", "Entering configured PIN");
      await this.enterPin(driver, pin);

      log("LOGIN", "Waiting for authentication");
      const elapsed = await this.waitForAuthenticated(driver);

      const screenLoadMs = (config.timeouts && config.timeouts.screenLoadWaitMs) || 20000;
      const state = await this.waitForKnownState(driver, screenLoadMs);
      if (state === 'unknown') {
        throw new Error('Authentication failed: no known app state after PIN screen closed.');
      }
      log("LOGIN", `Authentication successful (PIN screen closed in ${elapsed}ms, state: ${state})`);
      return true;
    } catch (err) {
      log("LOGIN", `Authentication failed: ${err.message}`);
      await BasePage.saveFailureScreenshot(driver, 'login_failure');
      try {
        await this.handleInvalidPinDialog(driver);
      } catch (dialogErr) {
        log("LOGIN", `Error dialog cleanup failed: ${dialogErr.message}`);
      }
      throw err;
    }
  }
}

module.exports = LoginPage;
