const config = require('../config.json');
const locators = require('../locators.json');
const { log } = require('../utils/logger');

const APP_PACKAGE = 'com.parentpay.PointOfService';
const SYSTEM_PERMISSION_MESSAGE_ID = 'com.android.permissioncontroller:id/permission_message';
const SYSTEM_ALLOW_ID = 'com.android.permissioncontroller:id/permission_allow_button';
// Android uses permission_deny_button first, then permission_deny_and_dont_ask_again_button on a repeat prompt.
const SYSTEM_DENY_REGEX = '.*:id/permission_deny(_and_dont_ask_again)?_button';
const NOTIFICATION_TEXT = 'send you notifications';
// Camera prompt shows around the QR screen. Manual entry is used, so it is always denied.
const CAMERA_TEXT = 'take pictures and record video';

const SKIP_BUTTON_ID = `${APP_PACKAGE}:id/skip_button`;
// Container of the "Tap to manually enter QR code" text on the QR method selection screen.
const MANUAL_ENTRY_ID = `${APP_PACKAGE}:id/tap_enter_pin`;
const HOME_MARKER_ID = `${APP_PACKAGE}:id/initial_home_button`;

// App AlertDialogs. Their buttons share android:id/button1 (positive) and button2 (negative).
const APP_DIALOG_TITLE_ID = `${APP_PACKAGE}:id/alertTitle`;
const PERMISSIONS_REQUIRED_TITLE = 'Permissions Required';
const DIALOG_MESSAGE_ID = 'android:id/message';
const GUID_DIALOG_MESSAGE = 'Enter the tenant GUID';
const DIALOG_POSITIVE_ID = 'android:id/button1';
const DIALOG_NEGATIVE_ID = 'android:id/button2';
const GUID_INPUT_CLASS = 'android.widget.EditText';

const DEFAULT_TIMEOUT_MS = 10000;

const byResourceId = (id) => `android=new UiSelector().resourceId("${id}")`;
// One lookup that matches any first-launch element. Keeps the already-onboarded path to a single query.
const ANY_ONBOARDING_SELECTOR =
  'android=new UiSelector().resourceIdMatches(".*:id/(skip_button|permission_message|alertTitle|tap_enter_pin|message)")';

class OnboardingPage {
  static isEnabled() {
    return !(config.onboarding && config.onboarding.enabled === false);
  }

  static getTimeoutMs() {
    return (config.onboarding && config.onboarding.timeoutMs) || DEFAULT_TIMEOUT_MS;
  }

  // Deny by default. Set onboarding.allowNotifications=true in config.json to allow.
  static shouldAllowNotifications() {
    return !!(config.onboarding && config.onboarding.allowNotifications === true);
  }

  // Never log the returned value.
  static getConfiguredQrCode() {
    const value = process.env.POS_QR_CODE || (config.onboarding && config.onboarding.qrCode);
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error('Onboarding failed: QR/GUID value is not configured. Set onboarding.qrCode in config.json or the POS_QR_CODE environment variable.');
    }
    return String(value).trim();
  }

  static async findDisplayed(driver, selector) {
    try {
      const els = await driver.$$(selector);
      if (els.length === 0) return null;
      return (await els[0].isDisplayed().catch(() => false)) ? els[0] : null;
    } catch (e) {
      return null;
    }
  }

  static async textOf(driver, selector) {
    const el = await this.findDisplayed(driver, selector);
    if (!el) return null;
    try {
      return await el.getText();
    } catch (e) {
      return null;
    }
  }

  // Cheap probe: Skip exists only on the first onboarding screen.
  static async isOnboardingDisplayed(driver) {
    return !!(await this.findDisplayed(driver, byResourceId(SKIP_BUTTON_ID)));
  }

  static async isQrMethodSelectionDisplayed(driver) {
    return !!(await this.findDisplayed(driver, byResourceId(MANUAL_ENTRY_ID)));
  }

  // Returns 'notification', 'camera' or null.
  static async getSystemPermissionKind(driver) {
    const text = await this.textOf(driver, byResourceId(SYSTEM_PERMISSION_MESSAGE_ID));
    if (!text) return null;
    const lower = text.toLowerCase();
    if (lower.includes(NOTIFICATION_TEXT)) return 'notification';
    if (lower.includes(CAMERA_TEXT)) return 'camera';
    return null;
  }

  static async isPermissionsRequiredDialogDisplayed(driver) {
    const title = await this.textOf(driver, byResourceId(APP_DIALOG_TITLE_ID));
    return title === PERMISSIONS_REQUIRED_TITLE;
  }

  static async isQrInputDisplayed(driver) {
    const msg = await this.textOf(driver, byResourceId(DIALOG_MESSAGE_ID));
    return msg === GUID_DIALOG_MESSAGE;
  }

  static async isPinScreenDisplayed(driver) {
    return !!(await this.findDisplayed(driver, byResourceId(locators.login.digits.one)));
  }

  static async isHomeDisplayed(driver) {
    return !!(await this.findDisplayed(driver, byResourceId(HOME_MARKER_ID)));
  }

  static async clickAndWaitGone(driver, selector, label) {
    const el = await this.findDisplayed(driver, selector);
    if (!el) return false;
    await el.click();
    await driver.waitUntil(async () => !await this.findDisplayed(driver, selector), {
      timeout: this.getTimeoutMs(),
      interval: 200,
      timeoutMsg: `${label} did not close`
    });
    return true;
  }

  // System prompt: notification and camera are denied unless notifications are explicitly allowed.
  static async handleNotificationPermissionIfPresent(driver) {
    try {
      const kind = await this.getSystemPermissionKind(driver);
      if (!kind) return false;
      const allow = kind === 'notification' && this.shouldAllowNotifications();
      log('ONBOARDING', `${kind} permission prompt detected. Selecting "${allow ? 'Allow' : "Don't allow"}"`);
      const selector = allow
        ? byResourceId(SYSTEM_ALLOW_ID)
        : `android=new UiSelector().resourceIdMatches("${SYSTEM_DENY_REGEX}")`;
      return await this.clickAndWaitGone(driver, selector, 'Permission prompt');
    } catch (e) {
      log('ONBOARDING', `Permission prompt handling failed: ${e.message}`);
      return false;
    }
  }

  // App AlertDialog "Permissions Required" (Cancel / Grant). Cancel is enough: onboarding and login continue without it.
  static async handleBackgroundServicePermissionIfPresent(driver) {
    try {
      if (!await this.isPermissionsRequiredDialogDisplayed(driver)) return false;
      const allow = this.shouldAllowNotifications();
      log('ONBOARDING', `Background-service permissions dialog detected. Selecting "${allow ? 'Grant' : 'Cancel'}"`);
      return await this.clickAndWaitGone(driver, byResourceId(allow ? DIALOG_POSITIVE_ID : DIALOG_NEGATIVE_ID), 'Permissions dialog');
    } catch (e) {
      log('ONBOARDING', `Permissions dialog handling failed: ${e.message}`);
      return false;
    }
  }

  static async skipInitialQrOnboarding(driver) {
    const skip = await this.findDisplayed(driver, byResourceId(SKIP_BUTTON_ID));
    if (!skip) return false;
    log('ONBOARDING', 'Initial QR onboarding detected. Clicking Skip');
    await skip.click();
    return true;
  }

  static async selectManualQrEntry(driver) {
    const el = await this.findDisplayed(driver, byResourceId(MANUAL_ENTRY_ID));
    if (!el) return false;
    log('ONBOARDING', 'QR method selection detected. Choosing manual entry');
    await el.click();
    return true;
  }

  // Enters the configured GUID and saves. The value is never logged.
  static async enterQrCode(driver, qrCode) {
    const input = await this.findDisplayed(driver, `android=new UiSelector().className("${GUID_INPUT_CLASS}")`);
    if (!input) throw new Error('Onboarding failed: GUID input field not found.');
    log('ONBOARDING', 'GUID input detected. Entering configured value');
    await input.setValue(qrCode);
    const save = await this.findDisplayed(driver, byResourceId(DIALOG_POSITIVE_ID));
    if (!save) throw new Error('Onboarding failed: GUID Save button not found.');
    await save.click();
  }

  static async detectStep(driver) {
    if (await this.isPinScreenDisplayed(driver) || await this.isHomeDisplayed(driver)) return 'done';
    if (await this.getSystemPermissionKind(driver)) return 'permission';
    if (await this.isPermissionsRequiredDialogDisplayed(driver)) return 'permissionsDialog';
    if (await this.isQrInputDisplayed(driver)) return 'qrInput';
    if (await this.isOnboardingDisplayed(driver)) return 'skip';
    if (await this.isQrMethodSelectionDisplayed(driver)) return 'manualEntry';
    return 'none';
  }

  // Waits for the UI to leave `previous` and settle on a known step (or finish).
  static async waitForNextStep(driver, previous) {
    let step = previous;
    await driver.waitUntil(async () => {
      step = await this.detectStep(driver);
      return step !== 'none' && step !== previous;
    }, { timeout: this.getTimeoutMs(), interval: 200 }).catch(() => {});
    return step;
  }

  // Resolves once the app reaches the PIN screen (or home, if no PIN is required).
  static async waitForOnboardingCompletion(driver) {
    return driver.waitUntil(async () => await this.isPinScreenDisplayed(driver) || await this.isHomeDisplayed(driver), {
      timeout: this.getTimeoutMs(),
      interval: 250,
      timeoutMsg: 'Onboarding did not reach the PIN or home screen after saving the GUID'
    });
  }

  // Single lookup and return when onboarding is already complete.
  static async handleIfRequired(driver) {
    if (!this.isEnabled()) return false;
    if (!await this.findDisplayed(driver, ANY_ONBOARDING_SELECTOR)) return false;

    let step = await this.detectStep(driver);
    if (step === 'none' || step === 'done') return false;

    log('ONBOARDING', 'First-launch setup in progress');
    let handled = false;
    // Hard cap on transitions so an unexpected UI cannot loop forever.
    for (let i = 0; i < 12 && step !== 'none' && step !== 'done'; i++) {
      const previous = step;
      switch (step) {
        case 'permission':
          await this.handleNotificationPermissionIfPresent(driver);
          break;
        case 'permissionsDialog':
          await this.handleBackgroundServicePermissionIfPresent(driver);
          break;
        case 'skip':
          await this.skipInitialQrOnboarding(driver);
          break;
        case 'manualEntry':
          await this.selectManualQrEntry(driver);
          break;
        case 'qrInput':
          await this.enterQrCode(driver, this.getConfiguredQrCode());
          await this.waitForOnboardingCompletion(driver);
          break;
      }
      handled = true;
      step = await this.waitForNextStep(driver, previous);
      if (step === previous) {
        log('ONBOARDING', `Setup step "${previous}" did not advance`);
        break;
      }
    }

    if (step === 'done') log('ONBOARDING', 'Onboarding complete');
    return handled;
  }
}

module.exports = OnboardingPage;
