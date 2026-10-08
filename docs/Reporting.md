# Reporting & Live Dashboard Guide

This document describes the three reporting interfaces (Live Web Dashboard, static HTML Visual Report, and Excel Spreadsheet Log) and the memory trend analysis modules.

---

## 1. Live Web Dashboard (Port 5050)
The Live Dashboard exposes real-time execution statistics via WebSockets. It is served by [liveDashboard.js](file:///d:/POSStressTest/utils/liveDashboard.js) utilizing **Express and Socket.io**.

### 1.1 Key Real-Time Data Points
* **Orders Per Minute (OPM)**: Computed on a rolling window of recent cycles to exclude startup overhead.
* **Cycle Counters**: Total passes, failures, and recovery incidents.
* **Heap Memory Graph**: Displays target application memory consumption over time.
* **System Event Logs**: Reconnect events, watchdog triggers, and session rebuilding warnings.

### 1.1.1 Status Lifecycle
The Status card shows the real run state, not the connection state:

| Status | Meaning | Colour |
|---|---|---|
| `STARTING` | Dashboard is up; setup (onboarding, PIN, hierarchy, POS entry) is still running | amber |
| `RUNNING` | The order loop has begun | blue |
| `SUCCESS` | Run finished with no failed cycles | green |
| `PARTIAL` | Run finished, some cycles completed and some failed | amber |
| `FAILED` | Fatal error, or no cycle completed and at least one failed | red |

* **Success Rate** shows `No orders yet` (neutral) until at least one cycle has completed or failed. After that it shows `completed / (completed + failed)`.
* **Elapsed / Remaining** tick live in the browser. Remaining is `N/A` until the order loop starts and always `N/A` in cycles mode.
* **Current Cycle** keeps the last real cycle number when the final or fatal update arrives.
* **Event feed** receives the explicit dashboard events plus existing startup log lines (`ONBOARDING`, `LOGIN`, `HIERARCHY`, `POS_MENU`, `STATE`, `POPUP`, `Starting Cycle`, startup retry errors). The hook is `setEventSink` in `utils/logger.js`; it never affects logging.
* `live_state.json` in the run folder stores the same metrics and events.

### 1.2 Configuration
The dashboard is controlled via `config.json` parameters:
* `liveDashboardEnabled`: `true` or `false` to turn the server on/off.
* `liveDashboardPort`: Target port binding (defaults to `5050`).
* `liveDashboardAutoOpen`: `true` to launch the dashboard inside the host machine's default browser automatically at startup.

---

## 1.9 Run Folder (Artifact Ownership)
Every stress run (local or BrowserStack) owns one folder: `logs/<YYYY-MM-DD_HH-mm-ss>` (a `-2`, `-3` suffix is added if the name already exists). It is created once by `initRunArtifacts()` in [runArtifacts.js](file:///d:/POSStressTest/utils/runArtifacts.js) at startup. Cycles and recovery/reconnect sessions never create new folders.

Contents: `run.log`, `report_<stamp>.html`, `report.xlsx`, `live_state.json`, `summary.json`, failure screenshots, and (BrowserStack) `browserstack/sessions.json`.

* Report generators throw if the run folder was not initialised. They never write to a shared path.
* `logs/latest_summary_<mode>.json` is still overwritten each run. It is only a pointer for `benchmark.js`. Use the per-run `summary.json` for history.
* Functional regression runs use their own `reports/functional-regression*/` folders (see [FunctionalRegression](FunctionalRegression.md)).

---

## 2. HTML Visual Report
At the end of a stress run, [htmlReport.js](file:///d:/POSStressTest/utils/htmlReport.js) writes `report_<stamp>.html` into the run folder. Local and BrowserStack stress runs use the same report. Only the Execution label (`Local Device` / `BrowserStack`), the BrowserStack environment rows and the sessions table differ.

### 2.1 Visual Modules
* **Header**: "ParentPay POS Stress Test", Execution, start, end, duration, and status (`SUCCESS`, `PARTIAL`, `FAILED`, `STOPPED_NO_ORDER`).
* **Stress Run Overview**: run mode, cycles/duration requested, cycles completed, successful and failed orders, `NO_ORDER` cycles, success/failure rate, OPM, recoveries, reconnects, watchdog events, total time. Rates show `N/A (no orders yet)` when nothing has run.
* **BrowserStack Sessions** (BrowserStack only): every session used by the run, including recovery rebuilds, with dashboard links. Access keys are never shown.
* **Phase Duration Breakdown**, **Stability Summary**, memory and long-run sections.
* **Cycle Details**: cycle, status, start, end, duration, child, product, order, recovery, reconnect, failure reason, screenshot link, notes (restricted products and skipped children).
* **Failures / Diagnostics**: category, error, screenshot and session for each failed cycle.

### 2.2 Cycle Statuses
| Status | Meaning |
|---|---|
| `PASS` | Order completed |
| `NO_ORDER` | No compatible child/product (allergen restrictions). Neutral, not a failure, not counted in failure rate |
| `FAIL` | Automation or application failure |

Run status `STOPPED_NO_ORDER` means the run stopped after `allergenRestriction.maxConsecutiveNoOrderCycles` consecutive `NO_ORDER` cycles. `PARTIAL` means the run finished but some cycles failed.

---

## 3. Excel Spreadsheet Metrics Logger
For detailed quantitative analysis, [excelReport.js](file:///d:/POSStressTest/utils/excelReport.js) writes `report.xlsx` into the run folder.

### 3.1 Data Schema
* **Cycles**: Cycle, Status, Start, End, Duration, Child, Product, Order, Recovery, Reconnect, Failure Reason, Notes.
* **Summary**: OPM, success/failure rate (`N/A` with no orders), no-order count and stop reason, recoveries, reconnects, memory and long-run stats.
* **Startup Health**: execution environment and startup checks.
* **Environment**: execution, status, times, device, Android, run mode, targets, run folder, BrowserStack project/build/session/app ID.
* **Failures**: category, error, screenshot, session per failed cycle.
* **BrowserStack Sessions** (BrowserStack only): session IDs, reason, created time, dashboard URL.

---

## 4. Endurance Analytics & Regression Models
During long endurance runs (e.g. 4h+ runs), the runner passes heap data points to [longRunAnalytics.js](file:///d:/POSStressTest/utils/longRunAnalytics.js):

* **Regression Engine**: Uses a least-squares linear regression model to calculate the rate of memory growth (MB per cycle).
* **Slown-down Detection**: Compares average cycle times between the initial 10% and final 10% windows of the run to measure degradation.
* **Risk Categorization**: Flags potential leaks under four risk bands (Healthy, Memory Growth Observed, Potential Memory Retention, High Risk of Memory Leak).
