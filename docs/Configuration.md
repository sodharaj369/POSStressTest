# Configuration Guide (config.json)

This guide describes all customization settings and threshold limits available in [config.json](file:///d:/POSStressTest/config.json).

---

## 1. Core Controls
* `mode`: `"duration"` or `"cycles"`. Govens the loop termination condition.
* `durationMins`: Number of minutes to run if `mode=duration` is set.
* `maxCycles`: Target number of order iterations to execute if `mode=cycles` is set.
* `executionMode`: `"rapid"` or `"standard"`. Rapid mode activates:
  - Cache-based button taps.
  - Skip search overlays if the target child was selected in the prior loop cycle.
  - Custom tuned Appium idle delays (`waitForIdleTimeout`).
  - Cut default delays to `0`.

---

## 2. Target Device Settings
* `udid`: ADB serial number of the target Android terminal (USB string or network socket `IP:Port`).
* `connectionMode`: `"usb"` or `"wifi"`. Determines connection retries logic.
* `keepAwake`: `true` or `false`. If enabled, issues ADB commands to keep the Android terminal screen awake during runs.
* `connectionRetryTimeoutMs`: Driver setup connection attempt limits (default: `120000` ms).
* `newCommandTimeout`: Seconds Appium waits for client commands before closing session (default: `300`).

---

## 3. POS Initialization Parameters
The following controls are used during the initial setup phase (`setupAndEnterPOS`) to navigate authentication and device binding menus:
* `schoolDev`: Dev school name string (e.g. `"Wimbledon School"`).
* `hierarchyLeft`: Left panel navigation outlet (e.g. `"testoutlet2"`).
* `hierarchyRight`: Device identifier bound to register (e.g. `"TestDevice2"`).
* `menuOption`: Target category options menu (e.g. `"Hospitality"`).

---

## 4. Test Data Pools
* `childName`: Comma-separated names list. One is chosen at random each cycle.
* Product Cart Configuration (choose one):
  * **Legacy Single-item**: Set `productName` as a comma-separated list of items (randomly selects one item at quantity 1).
  * **Random Multi-cart**: If `products` is defined (as string array or objects), the framework generates a basket based on `maxProductsPerCart` and `maxQtyPerProduct`.
  * **Explicit Basket**: If `cartProducts` is defined, the exact basket profile is ordered every cycle.

---

## 5. Timing Delays (Fine Tuning)
These are fine-tuning delays injected between page actions to allow visual transitions in standard mode (set to `0` or minimal values in rapid mode):
* `delayAfterChildMs`: Idle time after selecting child grid.
* `delayAfterProductMs`: Idle time after adding item.
* `delayAfterWalletMs`: Settle pause after selecting wallet pay.
* `delayAfterPayMs`: Settle pause after checking out.
* `delayBetweenQuantityClicksMs` / `rapidDelayBetweenQuantityClicksMs`: Delays between successive quantity clicks on the same product item.

---

## 6. Recovery & Hardening Boundaries
* `maxCycleTimeMs`: Watchdog timeout limit (default: `90000` ms). If a single ordering transaction cycle takes longer than this value, it is aborted and crash recovery is triggered.
* `maxMemoryLimitMb`: Peak PSS memory consumption allowed for the POS app (e.g., `750` MB). Exceeding this boundary triggers an automated app restart.
* `proactiveRelaunchCycles`: Relaunches the target app after N cycles to clear RAM bloat.
* `networkAndMemoryCheckEveryNCycles`: Cadence limit for checking network status and grabbing memory stats (e.g. every `6` cycles) to prevent ADB overhead on every loop cycle.
* `driverHealthCheckEveryNCycles`: Cadence limit to query Appium driver responsiveness (e.g. every `2` cycles).

---

## 7. Artifact Retention Settings
* `retention`: Group object:
  - `enabled`: `true` to clean up logs/screenshots folders automatically.
  - `cleanupOnStartup`: Runs cleanups immediately at startup.
  - `maxDays`: Clear folders older than N days.
  - `maxRunFolders`: Keep at most N run folders.
---

## 8. Authentication (PIN Login)
* `authentication`: Group object used by `pages/LoginPage.js`:
  - `enabled`: `true` to log in automatically when the PIN screen is shown. `false` skips the check entirely.
  - `pin`: 6-digit PIN for the target environment. Login fails clearly before any tap if it is missing or not exactly 6 digits.
  - `postLoginTimeoutMs`: Max wait for the PIN screen to close after the 6th digit (default: `5000` ms). Authentication is automatic, so there is no submit step.
* `POS_PIN` environment variable overrides `authentication.pin`.
* Security: the PIN is never logged. The value in `config.json` is a test-environment PIN only. Use `POS_PIN` for anything real instead of committing it.
* When the app is already authenticated, login is a single cheap probe and does nothing.

## 9. First-Launch Onboarding
* `onboarding`: Group object used by `pages/OnboardingPage.js` (runs before PIN login at startup/recovery):
  - `enabled`: `false` skips onboarding handling entirely.
  - `qrCode`: Tenant GUID typed into the manual QR entry box (DEV value). Camera scanning is not automated.
  - `timeoutMs`: Max wait per onboarding transition (default: `10000` ms).
  - `allowNotifications`: Optional. `true` allows notifications and grants the app's "Permissions Required" dialog. Default denies/cancels.
* `POS_QR_CODE` environment variable overrides `onboarding.qrCode`. The value is never logged.
* Flow: permission prompts → Skip → "Tap to manually enter QR code" → GUID → Save → PIN screen. When onboarding is already complete the handler is a single cheap probe and does nothing.
