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

## 2. HTML Visual Report
At the end of a stress run, [htmlReport.js](file:///d:/POSStressTest/utils/htmlReport.js) compiles a visual standalone dashboard file stored under `reports/`.

### 2.1 Visual Modules
* **Run Parameters Dashboard**: Summary cards for udid, framework, execution duration, and total order counts.
* **Phase Duration Breakdown**: Chart displaying averages for Child Selection, Cart Build, Wallet Ready, and Payment Transition.
* **Stability Summary Table**: Lists app restart metrics, Appium reconnect counts, and global popup recovery triggers.
* **Cycle Logs Table**: Complete logs of each cycle's status, duration, and corresponding memory sizes.

---

## 3. Excel Spreadsheet Metrics Logger
For detailed quantitative analysis, [excelReport.js](file:///d:/POSStressTest/utils/excelReport.js) creates an XLSX spreadsheet under `reports/`.

### 3.1 Data Schema
* **Sheet 1: Summary**: High-level OPM, duration, success rate, and memory regression stats.
* **Sheet 2: Cycles Raw Data**:
  - `Cycle`: Index number.
  - `Status`: `PASS` or `FAIL`.
  - `Duration`: Total milliseconds.
  - `Memory (MB)`: Heap dump value.
  - `Recovery Actions`: Relaunch notes or watchdog trigger flags.

---

## 4. Endurance Analytics & Regression Models
During long endurance runs (e.g. 4h+ runs), the runner passes heap data points to [longRunAnalytics.js](file:///d:/POSStressTest/utils/longRunAnalytics.js):

* **Regression Engine**: Uses a least-squares linear regression model to calculate the rate of memory growth (MB per cycle).
* **Slown-down Detection**: Compares average cycle times between the initial 10% and final 10% windows of the run to measure degradation.
* **Risk Categorization**: Flags potential leaks under four risk bands (Healthy, Memory Growth Observed, Potential Memory Retention, High Risk of Memory Leak).
