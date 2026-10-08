# Troubleshooting & Diagnostics Guide

This document lists common issues encountered during stress tests, diagnostic steps, and mitigation strategies.

---

## 1. Appium Driver Issues

### 1.1 Appium Server Not Reachable / Connection Terminated
* **Symptom**: Runner console shows `Unable to create Appium session` or `Appium server not reachable`.
* **Resolution**:
  1. Confirm the Appium process is running on the host machine:
     ```bash
     appium --port 4723
     ```
  2. Query server status directly from a browser or curl:
     ```bash
     curl http://127.0.0.1:4723/status
     ```
  3. Ensure the UiAutomator2 driver package is installed on the Appium server:
     ```bash
     appium driver list
     ```
     If missing, install it:
     ```bash
     appium driver install uiautomator2
     ```

### 1.2 UiAutomator2 Service Hangs
* **Symptom**: WebdriverIO throws socket hangs or connection refusal during execution.
* **Resolution**:
  The framework tries to clear and reset the target server packages automatically. If it fails, run these commands manually:
  ```bash
  adb shell pm clear io.appium.uiautomator2.server
  adb shell pm clear io.appium.uiautomator2.server.test
  ```

---

## 2. ADB & Device Connectivity Issues

### 2.1 Device Listed as Offline or Unauthorized
* **Symptom**: ADB commands return `device offline` or logs show `ADB device is not connected`.
* **Resolution**:
  1. Verify the hardware connection: unplug and replug the USB cable.
  2. Toggle **USB Debugging** off and back on in the target device's Developer Options menu.
  3. Run:
     ```bash
     adb kill-server
     adb start-server
     adb devices
     ```
  4. If unauthorized, accept the key authorization prompt on the device screen.

### 2.2 Wi-Fi Socket Disconnections
* **Symptom**: Latency spikes or connection drops during Wi-Fi runs.
* **Resolution**:
  1. Ping the device IP to verify socket stability.
  2. Re-establish the link:
     ```bash
     adb connect <device-ip>:5555
     ```

---

## 3. Test Flow Instability

### 3.1 Watchdog Timeout Fires Repeatedly
* **Symptom**: Cycles fail with `WATCHDOG_TIMEOUT` (exceeding 90s standard limit).
* **Resolution**:
  1. Check `screenshots/` directory for failure snapshots. If a custom modal is blocking the screen, register a new handler inside [popupManager.js](file:///d:/POSStressTest/utils/popupManager.js).
  2. Verify network responsiveness: a laggy internet connection can slow down child search overlays or payment processing times beyond the watchdog limit.
  3. Check memory trends: cumulative memory leaks may slow down MAUI transition rendering.

### 3.1.1 Android Permission Dialog Blocks the POS
* **Symptom**: POS grid is visible in the screenshot with an Android dialog on top (for example "Allow Point of Service to take pictures and record video?"). Menu clicks time out and the transition monitor waits the full 60 s.
* **Resolution**: The global popup handler (`System Permission` in [popupManager.js](file:///d:/POSStressTest/utils/popupManager.js)) denies camera prompts using the onboarding policy. If a new kind of permission text appears, extend `getSystemPermissionKind` in `pages/OnboardingPage.js`.

### 3.1.2 BrowserStack Run Reports `FAILED` but npm Exits 0
* `[FATAL]` failures are caught inside `test.js`, so `npm run stress:browserstack` can exit 0. Judge the run by `run.log`, the stability report status and the dashboard status, not the exit code alone.

### 3.1.3 BrowserStack Debugging
* Session video and Appium command logs are available from the BrowserStack dashboard (or REST API `/app-automate/sessions/<id>.json`) using the session ID printed at startup.
* `mobile: clickGesture` is not supported on BrowserStack. Back navigation and raw ADB steps are skipped on BrowserStack by design.

### 3.1.4 Allergen Restriction Toast
* **Symptom**: `[TOAST] ... allergen restrictions` in `run.log`, followed by `[ALLERGEN] ... restricted` and the next product being tried.
* This is expected, not a failure. If a toast shows but is not recognised (generic `Select Wallet button not enabled`), check `allergenRestriction.toastKeywords` in `config.json` against the toast text logged as `[TOAST]`.
* `NO_ORDER` cycles mean every child/product was restricted. Review the child and product config if they repeat.

### 3.2 Dynamic Locator Mismatches
* **Symptom**: Runner cannot find element targets (e.g. child name grid cells).
* **Resolution**:
  1. Check if the element values defined in `config.json` match spelling and case precisely with the UI.
  2. Inspect the screen structure using **Appium Inspector** to verify selectors inside [locators.json](file:///d:/POSStressTest/locators.json) align with the target MAUI layout.
