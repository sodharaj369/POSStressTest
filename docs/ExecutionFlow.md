# End-to-End Execution Flow

This document details the step-by-step control logic of the test runner ([test.js](file:///d:/POSStressTest/test.js)) during a stress testing session.

---

## 1. Startup & Pre-Flight Checklist

Before launching the transaction loop, the runner executes a sequence of validation checks:

```
[Start] -> Parse config.json -> Start Live Dashboard (Port 5050)
           │
           ▼
     Check Appium Health (Port 4723)
           │
           ▼
     Check ADB Device Status
           │
           ▼
     Launch POS App via ADB -> Create Driver Session
                               │
                               ▼
                        [Enter POM Setup]
```

1. **Configurations Parsing**: Reads `config.json` and checks if environment variables (`MAX_CYCLES`, `BENCHMARK_CYCLES`, `CI`) override default settings.
2. **Dashboard Initialization**: Starts the Live Dashboard server on Port 5050 via Socket.io.
3. **Appium Connection Verification**: Queries `http://127.0.0.1:4723/status` to confirm the Appium server is responsive.
4. **ADB Connection Verification**: Confirms target UDID is listed as `device` using ADB commands.
5. **App Package Launch**: Executes ADB command to launch MainActivity, wait 3 seconds, then establishes the Appium driver session.

---

## 2. Startup Setup (`setupAndEnterPOS`)
Runs a series of UI page objects to handle school dev and left/right hierarchy settings. Before state detection it calls `LoginPage.loginIfRequired()`, which enters the configured PIN only if the PIN screen is showing and does nothing otherwise. This ensures the app is loaded to the main POS ordering screen (grid page) prior to the transaction loop. If a crash happens during this phase, it triggers up to 5 startup recovery attempts.

---

## 3. The Ordering Transaction Loop

Once setup succeeds, the framework enters a while loop governed by the `shouldContinue()` constraint (evaluating duration or cycles).

```
+--------------------------------------------------------+
|                   Start Loop Cycle                     |
+--------------------------------------------------------+
                           │
                           ▼
                  Connectivity Checks
       (ADB ping; cadence-based memory & network checks)
                           │
                           ▼
                  Relaunch Check
       (Proactive app bounce if cycle count threshold hit)
                           │
                           ▼
                 Generate Cart & Child
      (Random names & configurations chosen from pool)
                           │
                           ▼
                 Watchdog Race Starts
   ┌───────────────────────┴───────────────────────┐
   ▼                                               ▼
Transaction Promise                            Watchdog Timeout
- Select Child                                 (Fires if frozen
- Build Basket                                  for > 60 seconds)
- Select Wallet                                    │
- Process Payment                                  ▼
   │                                           Teardown Driver
   ▼                                           Reset ADB / UIA2
Record Success                                 Relaunch App
Update Dashboard/Metrics                       Re-enter POS Setup
                           │                       │
                           ▼                       ▼
+--------------------------------------------------------+
|                     Next Cycle                         |
+--------------------------------------------------------+
```

### Step 3.1: Pre-Cycle Controls & Cadence Checks
* **ADB Gate**: Pings device via ADB.
* **Network & Memory Profiling**: Dumps memory stats at the configured cadence (`networkAndMemoryCheckEveryNCycles`). If heap size exceeds `maxMemoryLimitMb`, a proactive memory recycling event is queued.
* **Proactive Bounce Check**: Relaunches and re-authenticates the app if `proactiveRelaunchCycles` count is exceeded, mitigating cumulative heap bloat.
* **Pre-Cycle Appium Ping**: Calls `driver.getWindowSize()` at a regular interval to test Appium command responsiveness before starting the transaction.

### Step 3.2: Transaction Watchdog Race
To prevent the runner from hanging on a frozen UI element, the transaction phase is executed via `Promise.race()` against a watchdog timeout (defaulting to 60 seconds):
1. **Child Selection**: Resolves grid target name.
2. **Cart Build**: Adds generated products to the basket.
3. **Wallet Selection**: Selects pay options.
4. **Payment**: Executes pay tap and polls for the transition to the initial POS menu.

*If the transaction resolves first:* Watchdog timer is cleared, and the run is recorded as `PASS`.
*If the watchdog timer resolves first:* Rejects with `WATCHDOG_TIMEOUT` and throws the thread into the recovery handler.

---

## 4. Teardown & Reports Generation
When the exit criteria are met:
1. **Analytics Engine Processing**: Evaluates memory slopes and calculates final OPM throughput.
2. **Excel Sheet Compile**: Saves run logs to `reports/`.
3. **HTML Report Compile**: Generates a web report containing graphs and stability metrics, then opens the file in the browser.
4. **Dashboard Shutdown**: Stops the live dashboard server.
