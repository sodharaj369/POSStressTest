const BasePage = require('./BasePage');
const locators = require('../locators.json');
const config   = require('../config.json');
const { log }  = require('../utils/logger');
const perf     = require('../utils/perfMetrics');

// ─── Fast-path state flags ────────────────────────────────────────────────────
// These are set to true after the first successful navigation to each screen.
// They allow direct-visibility probes on subsequent cycles before falling back
// to scroll/search. Flags survive within a run; crash/relaunch keeps them true
// because the fast-path probe always falls back gracefully if not visible.
const _state = {
  childListLoaded: false,  // set after first successful child selection
  menuLoaded:      false,  // set after first successful product click
};

class POSPage {
  static lastSelectedChild = null;
  // Outcome of the most recent selectCompatibleCart call (report/diagnostics only).
  static lastSelection = null;
  static _productCache = new Map();

  static _isFatalDriverError(err) {
    const msg = ((err && err.message) || '').toLowerCase();
    return msg.includes('instrumentation process is not running') ||
      msg.includes('instrumentation') ||
      msg.includes('cannot be proxied') ||
      msg.includes('socket') ||
      msg.includes('session') ||
      msg.includes('refused') ||
      msg.includes('connection');
  }

  static async _waitWalletEnabled(driver, timeoutMs = 3500, intervalMs = 30) {
    const selector = `android=new UiSelector().text("${locators.selectWalletButton}")`;
    const start = Date.now();
    let pollCount = 0;
    let firstVisibleAt = null;
    let firstEnabledAt = null;

    while ((Date.now() - start) < timeoutMs) {
      pollCount++;
      try {
        const matches = await driver.$$(selector);
        if (matches.length > 0) {
          if (firstVisibleAt == null) {
            firstVisibleAt = Date.now();
          }
          const enabled = await matches[0].isEnabled();
          if (enabled) {
            firstEnabledAt = Date.now();
            log("TIMING", `Wallet Ready Polls = ${pollCount}`);
            log("TIMING", `Wallet Ready Visible Wait = ${firstVisibleAt - start}ms`);
            log("TIMING", `Wallet Ready Enable Wait = ${firstEnabledAt - start}ms`);
            return matches[0];
          }
        }
      } catch (err) {
        if (this._isFatalDriverError(err)) {
          throw new Error(`INSTRUMENTATION_CRASH_DETECTED: ${err.message}`);
        }
      }

      await driver.pause(intervalMs);
    }

    throw new Error(`Select Wallet button not enabled within ${timeoutMs}ms`);
  }

  static async swipeChildList(driver, direction = 'up', percent = 0.75) {
    if (direction === 'down') {
      await BasePage.swipeDown(driver, percent, 'childList');
      return;
    }
    await BasePage.swipeUp(driver, percent, 'childList');
  }

  static async isMenuDisplayed(driver) {
    const menuBtn = await driver.$(`android=new UiSelector().text("${locators.menuOption}")`);
    try {
      return await menuBtn.isExisting() && await menuBtn.isDisplayed();
    } catch (e) {
      return false;
    }
  }

  static async isPOSMainDisplayed(driver) {
    const nameBtn = await driver.$(`android=new UiSelector().text("${locators.nameButton}")`);
    try {
      return await nameBtn.isExisting() && await nameBtn.isDisplayed();
    } catch (e) {
      return false;
    }
  }

  static async isSearchChildDisplayed(driver) {
    const matches = await driver.$$(`android=new UiSelector().text("${locators.closeButton}")`);
    return matches.length > 0 && await matches[0].isDisplayed().catch(() => false);
  }

  static async isProductPageWithSelectedProduct(driver) {
    const selectWalletBtn = await driver.$(`android=new UiSelector().text("${locators.selectWalletButton}")`);
    try {
      return await selectWalletBtn.isExisting() && await selectWalletBtn.isDisplayed() && await selectWalletBtn.isEnabled();
    } catch (e) {
      return false;
    }
  }

  static async clickMenuOption(driver) {
    log("POS_MENU", `Clicking menu option: "${locators.menuOption}"...`);
    const targetSelector = `android=new UiSelector().text("${locators.nameButton}")`;
    const nameBtn = await driver.$(targetSelector);

    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        log("POS_MENU", `Clicking menu option attempt ${attempt}/4...`);
        const menuBtn = await BasePage.findElementFast(driver, locators.menuOption);
        await BasePage.safeClick(driver, menuBtn);
        
        // Wait up to 10 seconds for transition before retrying click
        let transitioned = false;
        const start = Date.now();
        while ((Date.now() - start) < 10000) {
          // Proactively clear any network failure or server error alerts that block loading
          try {
            await BasePage.checkForAlertsAndDismiss(driver);
          } catch (e) {}

          if (await nameBtn.isExisting() && await nameBtn.isDisplayed().catch(() => false)) {
            transitioned = true;
            break;
          }
          await driver.pause(500);
        }
        
        if (transitioned) {
          log("POS_MENU", `Successfully transitioned to POS page after clicking "${locators.menuOption}"`);
          return;
        }
        log("POS_MENU_WARNING", `Click on "${locators.menuOption}" did not transition within 10s. Retrying click...`);
      } catch (err) {
        log("POS_MENU_WARNING", `Error during menu option click attempt ${attempt}: ${err.message}`);
        await driver.pause(1000);
      }
    }
    
    // Final wait/fallback to monitor transition
    await BasePage.monitorTransition(driver, async () => {
      return await nameBtn.isExisting() && await nameBtn.isDisplayed();
    }, 60000, 1000);
  }

  static async clickName(driver) {
    log("POS", "Clicking 'Name' button to open Search Child...");
    const nameBtn = await BasePage.findElementFast(driver, locators.nameButton);
    await BasePage.safeClick(driver, nameBtn);
    
    // Monitor transition to Search Child overlay for up to 30 seconds
    const closeSelector = `android=new UiSelector().text("${locators.closeButton}")`;
    await BasePage.monitorTransition(driver, async () => {
      const closeMatches = await driver.$$(closeSelector);
      return closeMatches.length > 0 && await closeMatches[0].isDisplayed().catch(() => false);
    }, 30000, 60);
  }

  static async selectChild(driver, childName) {
    log("POS", `Searching and selecting child: "${childName}"...`);

    const executionMode = process.env.EXECUTION_MODE || config.executionMode || 'standard';
    const isRapid = executionMode === 'rapid';

    // ── RAPID MODE CHILD CONTEXT REUSE ──────────────────────────────────────────
    if (isRapid && childName === POSPage.lastSelectedChild) {
      log("CHILD_FASTPATH", `Rapid mode: reusing child context for "${childName}". Attempting rapid select.`);
      const _rapidStart = Date.now();
      try {
        const matches = await driver.$$(`android=new UiSelector().textContains("${childName}")`);
        if (matches.length > 0 && await matches[0].isDisplayed().catch(() => false)) {
          const _rapidLocate = Date.now() - _rapidStart;
          const _clickStart = Date.now();
          await BasePage.safeClick(driver, matches[0]);
          const _rapidClick = Date.now() - _clickStart;
          
          log("POS", `Child "${childName}" selected rapidly`);
          perf.recordLocateBreakdown('immediate', _rapidLocate);
          perf.record(perf.PHASES.CHILD_LOCATE,     _rapidLocate);
          perf.record(perf.PHASES.CHILD_CLICK,      _rapidClick);
          perf.record(perf.PHASES.CHILD_TRANSITION, 0); // Skip transition wait in rapid mode
          POSPage.lastSelectedChild = childName;
          _state.childListLoaded = true;
          return;
        }
      } catch (e) {
        log("CHILD_FASTPATH_WARN", `Rapid child selection failed: ${e.message}. Falling back to normal flow.`);
      }
    }

    // ── SCREEN REUSE FAST PATH ────────────────────────────────────────────────
    // After payment the app returns to the child list screen scrolled to the
    // last selected child. If the target child is already visible without
    // opening the Name/search overlay, click it directly and skip both the
    // Name button tap and the search interaction.
    //
    // Works for two scenarios:
    //   a) Overlay already open (State_D) — child visible in overlay list.
    //   b) Main POS screen (State_C) — child visible directly in the list.
    //
    // On probe failure or unsuccessful click verification, falls through to
    // the existing Name/search flow unchanged.
    try {
      const closeSelector = `android=new UiSelector().text("${locators.closeButton}")`;
      // Pre-locate: overlay state probe — NOT counted in locate time, but is real overhead
      const _srPreLocateStart = Date.now();
      const closePre = await driver.$$(closeSelector);
      const overlayWasOpen = closePre.length > 0 && await closePre[0].isDisplayed().catch(() => false);
      const _srPreLocateMs = Date.now() - _srPreLocateStart;
      log("CHILD_FASTPATH", `Immediate lookup started | pre_locate_overhead=${_srPreLocateMs}ms (overlay state check — not in locate timer)`);

      // Single non-retrying probe for child on the current screen
      let screenTarget = null;
      const _srLocateStart = Date.now();

      if (isRapid) {
        // In rapid mode, skip exact match probe and go straight to textContains to save RTT
        const srContainsMatches = await driver.$$(`android=new UiSelector().textContains("${childName}")`);
        const srContainsVisible = srContainsMatches.length > 0 && await srContainsMatches[0].isDisplayed().catch(() => false);
        if (srContainsVisible) {
          screenTarget = srContainsMatches[0];
          log("CHILD_FASTPATH", `Element found immediately (contains match, rapid)`);
        }
      } else {
        const _t1 = Date.now();
        const srExactMatches = await driver.$$(`android=new UiSelector().text("${childName}")`);
        const _exactQueryMs = Date.now() - _t1;
        const _t2 = Date.now();
        const srExactVisible = srExactMatches.length > 0 && await srExactMatches[0].isDisplayed().catch(() => false);
        const _exactVisMs = Date.now() - _t2;

        if (srExactVisible) {
          screenTarget = srExactMatches[0];
          log("CHILD_FASTPATH", `Element found immediately (exact match) | exact_query=${_exactQueryMs}ms | vis_check=${_exactVisMs}ms`);
        } else {
          const _t3 = Date.now();
          const srContainsMatches = await driver.$$(`android=new UiSelector().textContains("${childName}")`);
          const _containsQueryMs = Date.now() - _t3;
          const _t4 = Date.now();
          const srContainsVisible = srContainsMatches.length > 0 && await srContainsMatches[0].isDisplayed().catch(() => false);
          const _containsVisMs = Date.now() - _t4;
          if (srContainsVisible) {
            screenTarget = srContainsMatches[0];
            log("CHILD_FASTPATH", `Element found immediately (contains match) | exact_query=${_exactQueryMs}ms | exact_vis=${_exactVisMs}ms | contains_query=${_containsQueryMs}ms | contains_vis=${_containsVisMs}ms`);
          } else {
            log("CHILD_FASTPATH", `Element not visible on screen | exact_query=${_exactQueryMs}ms | exact_vis=${_exactVisMs}ms | contains_query=${_containsQueryMs}ms | contains_vis=${_containsVisMs}ms`);
          }
        }
      }
      const _srLocateMs = Date.now() - _srLocateStart;

      if (screenTarget) {
        log("FASTPATH", `Child "${childName}" already visible on screen — clicking directly (skipping Name/search)`);
        const _srClickStart = Date.now();
        await BasePage.safeClick(driver, screenTarget);
        const _srClickMs = Date.now() - _srClickStart;
        const _srTransStart = Date.now();

        // Verify the click produced the expected screen transition
        let srSucceeded = false;
        if (overlayWasOpen) {
          // Overlay scenario: wait for close button to disappear (overlay dismissed)
          await driver.waitUntil(
            async () => {
              const cur = await driver.$$(closeSelector);
              return !(cur.length > 0 && await cur[0].isDisplayed().catch(() => false));
            },
            { timeout: 600, interval: 30 }
          ).catch(() => {});
          const closeAfter = await driver.$$(closeSelector);
          srSucceeded = !(closeAfter.length > 0 && await closeAfter[0].isDisplayed().catch(() => false));
        } else {
          // Main-screen scenario: wait for Name button to disappear (navigated to product page)
          const nameSelector = `android=new UiSelector().text("${locators.nameButton}")`;
          await driver.waitUntil(
            async () => {
              const nameMatches = await driver.$$(nameSelector);
              return !(nameMatches.length > 0 && await nameMatches[0].isDisplayed().catch(() => false));
            },
            { timeout: 1500, interval: 50 }
          ).catch(() => {});
          const nameAfter = await driver.$$(nameSelector);
          srSucceeded = !(nameAfter.length > 0 && await nameAfter[0].isDisplayed().catch(() => false));
        }

        if (srSucceeded) {
          log("POS", `Child "${childName}" selected via screen reuse fast path`);
          const _srTransMs = Date.now() - _srTransStart;
          log("TIMING", `Child Locate = ${_srLocateMs}ms`);
          log("TIMING", `Child Click = ${_srClickMs}ms`);
          log("TIMING", `Child Transition = ${_srTransMs}ms`);
          perf.recordLocateBreakdown('immediate', _srLocateMs);
          perf.record(perf.PHASES.CHILD_LOCATE,     _srLocateMs);
          perf.record(perf.PHASES.CHILD_CLICK,      _srClickMs);
          perf.record(perf.PHASES.CHILD_TRANSITION, _srTransMs);
          perf.recordFastpath('childScreen', true);
          _state.childListLoaded = true;
          POSPage.lastSelectedChild = childName;
          return;
        }
        // Click registered but transition did not complete — fall through to Name/search
        log("POS_WARNING", "Screen reuse click did not produce expected transition, falling back to Name/search...");
        perf.recordFastpath('childScreen', false);
      } else {
        log("FALLBACK", `Child "${childName}" not visible on screen — using Name/search flow`);
        perf.recordFastpath('childScreen', false);
      }
    } catch (srErr) {
      log("POS_WARNING", `Screen reuse probe failed (${srErr.message}), proceeding with Name/search`);
      perf.recordFastpath('childScreen', false);
    }

    // ── FAST PATH ─────────────────────────────────────────────────────────────
    // After the first successful cycle the child list overlay position is known.
    // Attempt a single direct-visibility probe before triggering scroll/search.
    if (_state.childListLoaded) {
      try {
        // Check CLOSE overlay open state AND child visibility in one batch of parallel-ish probes.
        // If overlay is not open, click Name and wait. If already open, skip clickName entirely.
        const closeSelector = `android=new UiSelector().text("${locators.closeButton}")`;
        const _fpLocateStart = Date.now();
        log("CHILD_FASTPATH", `Immediate lookup started`);
        const closePre = await driver.$$(closeSelector);
        const overlayAlreadyOpen = closePre.length > 0 && await closePre[0].isDisplayed().catch(() => false);
        const _fpOverheadMs = Date.now() - _fpLocateStart;
        if (!overlayAlreadyOpen) {
          log("CHILD_FASTPATH", `Overlay not open — calling clickName | overlay_check=${_fpOverheadMs}ms`);
          await this.clickName(driver);
        } else {
          log("CHILD_FASTPATH", `Overlay already open | overlay_check=${_fpOverheadMs}ms`);
        }
        // Single non-retrying probe — no scrolling, no waiting
        // _fpProbeStart marks the pure element-find time (after any overlay-open overhead)
        const _fpProbeStart = Date.now();
        let fastTarget = null;
        const fastExactMatches = await driver.$$(`android=new UiSelector().text("${childName}")`);
        const fastExactVisible = fastExactMatches.length > 0 &&
          await fastExactMatches[0].isDisplayed().catch(() => false);
        if (fastExactVisible) {
          fastTarget = fastExactMatches[0];
        } else {
          const fastContainsMatches = await driver.$$(`android=new UiSelector().textContains("${childName}")`);
          const fastContainsVisible = fastContainsMatches.length > 0 &&
            await fastContainsMatches[0].isDisplayed().catch(() => false);
          if (fastContainsVisible) {
            fastTarget = fastContainsMatches[0];
          }
        }
        const _fpProbeMs = Date.now() - _fpProbeStart;
        const _fpLocateMs = Date.now() - _fpLocateStart;
        // _fpLocateMs includes overlay check + optional clickName (screen navigation) + probe.
        // _fpProbeMs is the pure element-find time only.

        if (fastTarget) {
          log("CHILD_FASTPATH", `Element found immediately | probe=${_fpProbeMs}ms | total_locate=${_fpLocateMs}ms${!overlayAlreadyOpen ? ' (includes clickName overhead — not pure locate)' : ''}`);
          log("FASTPATH", `Child visible, skipping search`);
          perf.recordFastpath('child', true);
          const _fpClickStart = Date.now();
          await BasePage.safeClick(driver, fastTarget);
          const _fpClickMs = Date.now() - _fpClickStart;
          const _fpTransStart = Date.now();

          const closeSelector = `android=new UiSelector().text("${locators.closeButton}")`;
          let stillOpenMatches = await driver.$$(closeSelector);
          let stillOpen = stillOpenMatches.length > 0 && await stillOpenMatches[0].isDisplayed().catch(() => false);
          if (stillOpen) {
            await driver.waitUntil(
              async () => {
                const current = await driver.$$(closeSelector);
                return !(current.length > 0 && await current[0].isDisplayed().catch(() => false));
              },
              { timeout: 600, interval: 30 }
            ).catch(() => {});
            stillOpenMatches = await driver.$$(closeSelector);
            stillOpen = stillOpenMatches.length > 0 && await stillOpenMatches[0].isDisplayed().catch(() => false);
          }
          if (!stillOpen) {
            log("POS", `Child "${childName}" selected via direct fast path`);
            const _fpTransMs = Date.now() - _fpTransStart;
            log("TIMING", `Child Locate = ${_fpLocateMs}ms`);
            log("TIMING", `Child Click = ${_fpClickMs}ms`);
            log("TIMING", `Child Transition = ${_fpTransMs}ms`);
            perf.recordLocateBreakdown('immediate', _fpProbeMs);
            perf.record(perf.PHASES.CHILD_LOCATE,     _fpLocateMs);
            perf.record(perf.PHASES.CHILD_CLICK,      _fpClickMs);
            perf.record(perf.PHASES.CHILD_TRANSITION, _fpTransMs);
            POSPage.lastSelectedChild = childName;
            return; // ✅ fast-path success
          }
          // Click registered but overlay still showing — fall through to search
          log("POS_WARNING", "Fast path click did not close overlay, falling back to search...");
        } else {
          log("CHILD_FASTPATH", `Retry loop entered — element not visible after single probe | probe=${_fpProbeMs}ms`);
          log("SEARCH", `Child not visible, using search`);
        }
      } catch (fastErr) {
        log("POS_WARNING", `Fast path probe failed (${fastErr.message}), falling back to search...`);
      }
      perf.recordFastpath('child', false);
    } else {
      log("SEARCH", `Child not visible, using search`);
      perf.recordFastpath('child', false);
    }

    // ── SEARCH PATH ───────────────────────────────────────────────────────────
    // Existing scroll + retry logic — unchanged.
    let childSelected = false;
    const _spLoopStart = Date.now();
    let _spClickStart = 0, _spTransStart = 0;
    for (let attempt = 1; attempt <= 5; attempt++) {
      log("POS", `Selecting child "${childName}" - Attempt ${attempt}/5...`);
      try {
        if (!(await this.isSearchChildDisplayed(driver))) {
          log("POS", "Search Child overlay not visible. Re-opening Name search...");
          await this.clickName(driver);
        }

        let childElement = null;
        const exactMatches = await driver.$$( `android=new UiSelector().text("${childName}")` );
        const exactVisible = exactMatches.length > 0 && await exactMatches[0].isDisplayed().catch(() => false);
        if (exactVisible) {
          childElement = exactMatches[0];
        }

        if (!exactVisible) {
          childElement = await BasePage.findElementContainsFast(driver, childName, 'childList');
        }
        
        // Use safeClick with dual native click & gesture support for bubble-up clicks in RecyclerView
        _spClickStart = Date.now();
        await BasePage.safeClick(driver, childElement);
        _spTransStart = Date.now();
        
        // Adaptive stabilization: return quickly if overlay closes immediately, but allow brief settle window.
        const closeSelector = `android=new UiSelector().text("${locators.closeButton}")`;
        let closeMatches = await driver.$$(closeSelector);
        let stillVisible = closeMatches.length > 0 && await closeMatches[0].isDisplayed().catch(() => false);
        if (stillVisible) {
          await driver.waitUntil(
            async () => {
              const current = await driver.$$(closeSelector);
              return !(current.length > 0 && await current[0].isDisplayed().catch(() => false));
            },
            {
              timeout: 600,
              interval: 30
            }
          ).catch(() => {});
          closeMatches = await driver.$$(closeSelector);
          stillVisible = closeMatches.length > 0 && await closeMatches[0].isDisplayed().catch(() => false);
        }
        
        if (!stillVisible) {
          log("POS", `🎉 Child "${childName}" successfully selected (Search overlay closed)`);
          const _spLocateMs = _spClickStart - _spLoopStart;
          const _spClickMs  = _spTransStart - _spClickStart;
          const _spTransMs  = Date.now() - _spTransStart;
          log("TIMING", `Child Locate = ${_spLocateMs}ms`);
          log("TIMING", `Child Click = ${_spClickMs}ms`);
          log("TIMING", `Child Transition = ${_spTransMs}ms`);
          perf.recordLocateBreakdown('search', _spLocateMs);
          perf.record(perf.PHASES.CHILD_LOCATE,     _spLocateMs);
          perf.record(perf.PHASES.CHILD_CLICK,      _spClickMs);
          perf.record(perf.PHASES.CHILD_TRANSITION, _spTransMs);
          POSPage.lastSelectedChild = childName;
          childSelected = true;
          break;
        }
        
        log("POS_WARNING", `Child selection click did not register. Search overlay is still open. Retrying...`);

        const direction = attempt % 2 === 0 ? 'down' : 'up';
        log("POS", `Swiping child list ${direction} to locate/select target child...`);
        await this.swipeChildList(driver, direction, 0.75);
        await driver.pause(150);
      } catch (err) {
        log("POS_WARNING", `Attempt ${attempt} to select child failed: ${err.message}`);

        try {
          const direction = attempt % 2 === 0 ? 'down' : 'up';
          log("POS", `Fallback swipe ${direction} on child list after failure...`);
          await this.swipeChildList(driver, direction, 0.75);
        } catch (swipeErr) {
          log("POS_WARNING", `Fallback child-list swipe failed: ${swipeErr.message}`);
        }

        await driver.pause(150);
      }
    }

    if (!childSelected) {
      throw new Error(`Failed to select child "${childName}" after retries`);
    }
    _state.childListLoaded = true;
  }

  static async selectProduct(driver, productName) {
    log("POS", `Searching and selecting product: "${productName}"...`);
    let productEl = null;

    // Fast path: product is usually already visible right after child selection.
    const exactSelector = `android=new UiSelector().text("${productName}")`;
    const containsSelector = `android=new UiSelector().textContains("${productName}")`;
    for (let i = 0; i < 8; i++) {
      try {
        const exactMatches = await driver.$$(exactSelector);
        if (exactMatches.length > 0 && await exactMatches[0].isDisplayed()) {
          productEl = exactMatches[0];
          break;
        }
      } catch (e) {}

      try {
        const containsMatches = await driver.$$(containsSelector);
        if (containsMatches.length > 0 && await containsMatches[0].isDisplayed()) {
          productEl = containsMatches[0];
          break;
        }
      } catch (e) {}

      await driver.pause(40);
    }

    // Fallback path: use robust finder with scrolling only when fast path does not find product.
    if (!productEl) {
      productEl = await BasePage.findElementContainsFast(driver, productName);
    }

    await BasePage.safeClick(driver, productEl);

    // Fast-path wait: product selection is usually immediate, so poll quickly for wallet readiness.
    const walletBtn = await driver.$(`android=new UiSelector().text("${locators.selectWalletButton}")`);
    await walletBtn.waitForDisplayed({ timeout: 15000, interval: 75 });
    await driver.waitUntil(
      async () => await walletBtn.isEnabled(),
      {
        timeout: 15000,
        interval: 60,
        timeoutMsg: 'Expected Select Wallet button to become enabled after product selection'
      }
    );
  }

  // ─── Allergen restriction handling ──────────────────────────────────────────
  // A restricted product is an EXPECTED business outcome, not an automation failure.

  // Toast text confirmed on a real device: "Product is unavailable due to allergen restrictions".
  // Keywords come only from config.allergenRestriction.toastKeywords.
  static _allergenToastKeywords() {
    const kw = config.allergenRestriction && config.allergenRestriction.toastKeywords;
    return Array.isArray(kw) ? kw.map(k => String(k).toLowerCase()).filter(k => k.length > 0) : [];
  }

  // Poll window for the restriction toast after a product click. The app shows it immediately,
  // so the first poll normally catches it; the window only bounds the "no toast" case.
  static ALLERGEN_TOAST_WAIT_MS = 3000;
  static ALLERGEN_TOAST_POLL_MS = 100;

  static async _toastTexts(driver) {
    const texts = [];
    try {
      const toasts = await driver.$$('//android.widget.Toast');
      for (const t of toasts) {
        const text = (await t.getText().catch(() => '')) || '';
        if (text) texts.push(text);
      }
    } catch (e) {
      if (this._isFatalDriverError(e)) throw e;
    }
    return texts;
  }

  /**
   * Primary allergen signal. Polls (bounded) for a toast matching a configured keyword after a
   * product click. Returns the toast text when restricted, otherwise null.
   * Disabled when no keywords are configured. When the cart was empty before the click, an
   * enabled Select Wallet means the product was added, so polling stops early.
   */
  static async _waitForAllergenToast(driver, productName, cartWasEmpty) {
    const keywords = this._allergenToastKeywords();
    if (keywords.length === 0) return null;

    const seen = new Set();
    const deadline = Date.now() + POSPage.ALLERGEN_TOAST_WAIT_MS;
    while (true) {
      for (const text of await this._toastTexts(driver)) {
        if (!seen.has(text)) {
          seen.add(text);
          log("TOAST", `Observed toast after clicking "${productName}": "${text}"`);
        }
        if (keywords.some(k => text.toLowerCase().includes(k))) return text;
      }
      if (cartWasEmpty && await this._isSelectWalletReady(driver)) return null;
      if (Date.now() >= deadline) return null;
      await driver.pause(POSPage.ALLERGEN_TOAST_POLL_MS);
    }
  }

  static async _isSelectWalletReady(driver) {
    try {
      const matches = await driver.$$(`android=new UiSelector().text("${locators.selectWalletButton}")`);
      return matches.length > 0 && await matches[0].isDisplayed().catch(() => false) && await matches[0].isEnabled();
    } catch (e) {
      return false;
    }
  }

  /** Waits (bounded) for the previous toast to disappear so it is not mistaken for the next product's. */
  static async _waitToastGone(driver, timeoutMs = 5000) {
    await driver.waitUntil(async () => (await this._toastTexts(driver)).length === 0,
      { timeout: timeoutMs, interval: 150 }).catch(() => {});
  }

  /**
   * After a restricted child is skipped we are on the product page, which has no Name button
   * and no child list. Return to the child list WITHOUT paying so selectChild can pick the next
   * child. Uses a single Android Back press (bounded, condition-driven wait). If the child list
   * does not appear, throw so the existing cycle recovery (setupAndEnterPOS) takes over.
   */
  static async returnToChildSelection(driver) {
    const closeSel = `android=new UiSelector().text("${locators.closeButton}")`;
    const nameSel  = `android=new UiSelector().text("${locators.nameButton}")`;
    const onChildList = async () => {
      for (const sel of [closeSel, nameSel]) {
        const els = await driver.$$(sel);
        if (els.length > 0 && await els[0].isDisplayed().catch(() => false)) return true;
      }
      return false;
    };

    if (await onChildList()) {
      log("CHILD", "Already on child selection screen");
      return;
    }

    log("CHILD", "Returning to child selection (Back from product page)...");
    try { await BasePage.checkForAlertsAndDismiss(driver); } catch (e) {}
    await driver.back();

    const reached = await driver.waitUntil(onChildList, { timeout: 5000, interval: 100 }).then(() => true).catch(() => false);
    if (!reached) {
      try { await BasePage.checkForAlertsAndDismiss(driver); } catch (e) {}
      if (await onChildList()) {
        log("CHILD", "Child selection screen reached after dismissing popup");
        return;
      }
      await BasePage.saveFailureScreenshot(driver, 'child_nav_after_restriction_failed');
      throw new Error('Could not return to child selection after skipping restricted child (Back did not reach child list)');
    }
    log("CHILD", "Child selection screen reached");
  }

  /**
   * Non-clicking probe. Returns 'SELECTABLE' | 'RESTRICTED' | 'UNKNOWN'.
   * UNKNOWN = tile not visible yet; normal search/scroll path decides later.
   */
  static async probeProduct(driver, name) {
    try {
      let matches = await driver.$$(`android=new UiSelector().text("${name}")`);
      if (matches.length === 0 || !(await matches[0].isDisplayed().catch(() => false))) {
        matches = await driver.$$(`android=new UiSelector().textContains("${name}")`);
      }
      if (matches.length > 0 && await matches[0].isDisplayed().catch(() => false)) {
        return (await matches[0].isEnabled()) ? 'SELECTABLE' : 'RESTRICTED';
      }
    } catch (e) {
      if (this._isFatalDriverError(e)) throw e;
    }
    return 'UNKNOWN';
  }

  /**
   * Tries candidate carts for the current child, each product at most once.
   * Returns { cart, restricted } when a cart was actually built (Select Wallet is ready),
   * or null when every candidate is restricted. Other errors propagate unchanged.
   */
  static async selectCompatibleCart(driver, childName, candidates) {
    const restricted = new Set();
    let toastConfirmed = 0;
    let firstTry = true;

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const candidate = candidates[candidateIndex];
      const cart = [];
      for (const item of candidate) {
        if (restricted.has(item.name)) {
          log("PRODUCT", `"${item.name}" already restricted for child "${childName}", not retrying`);
          continue;
        }
        log("PRODUCT", firstTry ? `Trying "${item.name}"` : `Trying next candidate "${item.name}"`);
        firstTry = false;
        // isEnabled() is unreliable on this app (greyed tiles report enabled), so a disabled tile is
        // only a hint to skip the click. Restriction is confirmed by the toast after clicking.
        const state = await this.probeProduct(driver, item.name);
        if (state === 'RESTRICTED') {
          restricted.add(item.name);
          log("PRODUCT", `"${item.name}" tile is disabled, skipping click`);
          continue;
        }
        log("PRODUCT", state === 'SELECTABLE'
          ? `"${item.name}" found and selectable`
          : `"${item.name}" not visible yet, using normal search`);
        cart.push(item);
      }

      if (cart.length === 0) continue;

      try {
        await this.addProductsToCart(driver, cart);
        log("PRODUCT", "Click successful");
        POSPage.lastSelection = { child: childName, restricted: [...restricted], selected: cart.map(i => i.name) };
        return { cart, restricted: [...restricted] };
      } catch (err) {
        if (err && err.code === 'ALLERGEN_RESTRICTED') {
          restricted.add(err.product);
          toastConfirmed++;
          log("ALLERGEN", `"${err.product}" restricted for current child "${childName}"`);
          // Only wait for the toast to clear if another candidate will actually be clicked.
          const moreCandidates = candidates.slice(candidateIndex + 1)
            .some(c => c.some(i => !restricted.has(i.name)));
          if (moreCandidates) await this._waitToastGone(driver);
          continue;
        }
        throw err;
      }
    }

    if (toastConfirmed > 0) {
      log("ALLERGEN", `No compatible products for child "${childName}"`);
    } else {
      log("PRODUCT", `No selectable products for child "${childName}" (tiles disabled or not found)`);
    }
    POSPage.lastSelection = { child: childName, restricted: [...restricted], selected: [] };
    return null;
  }

  /**
   * Adds one or more products to the cart with configurable quantities.
   * Accepts normalized format: [{ name: string, qty: number }]
   *
   * Config options supported (resolved by buildCartItems in test.js):
   *   - Legacy:       "productName": "Meal 1,Meal 2"  → single random product, qty 1
   *   - Option B:     "products": [{ name, qty }]      → single random product, with qty
   *   - Option C:     "cartProducts": [{ name, qty }]  → all products, in order
   */
  static async addProductsToCart(driver, cartItems) {
    const executionMode = process.env.EXECUTION_MODE || config.executionMode || 'standard';
    const isRapid = executionMode === 'rapid';

    if (isRapid) {
      // Clear product cache at the beginning of each cycle's cart build to avoid stale element references from previous cycles
      POSPage._productCache.clear();
    }

    const baseDelayBetweenQty = isRapid
      ? (config.rapidDelayBetweenQuantityClicksMs !== undefined ? config.rapidDelayBetweenQuantityClicksMs : 200)
      : (config.delayBetweenQuantityClicksMs !== undefined ? config.delayBetweenQuantityClicksMs : 1000);
    const hasQtyGreaterThanOne = Array.isArray(cartItems) && cartItems.some((item) => Number(item.qty) > 1);
    let delayBetweenQty = baseDelayBetweenQty;

    if (!isRapid && hasQtyGreaterThanOne) {
      const profile = Array.isArray(config.quantityDelayProfileMs)
        ? config.quantityDelayProfileMs.filter((v) => Number.isFinite(Number(v)) && Number(v) >= 0).map((v) => Number(v))
        : [];
      if (profile.length > 0) {
        const requestedStep = Number(config.quantityDelayProfileStep || 0);
        const boundedStep = Number.isFinite(requestedStep)
          ? Math.max(0, Math.min(profile.length - 1, Math.floor(requestedStep)))
          : 0;
        delayBetweenQty = profile[boundedStep];
      }
    }

    // Cart-build sub-phase instrumentation (timing only; no behavior changes)
    let _productLocateMs = 0;
    let _productClickMs = 0;
    let _cartRefreshMs = 0;

    // Log full cart before starting execution
    log("CART", `Executing cart (${cartItems.length} product${cartItems.length !== 1 ? 's' : ''}):`);
    log("CART", `Quantity click delay profile: ${hasQtyGreaterThanOne ? `qty>1 tuned (${delayBetweenQty}ms)` : `default (${delayBetweenQty}ms)`}`);
    for (const item of cartItems) {
      log("CART", `  ${item.name} x${item.qty}`);
    }

    for (let itemIdx = 0; itemIdx < cartItems.length; itemIdx++) {
      const { name, qty } = cartItems[itemIdx];
      const isLastItem = itemIdx === cartItems.length - 1;
      log("PRODUCT", `Adding "${name}" qty ${qty}`);

      for (let click = 1; click <= qty; click++) {
        log("PRODUCT", `"${name}" click ${click}/${qty}`);

        let productEl = null;
        const exactSelector    = `android=new UiSelector().text("${name}")`;
        const containsSelector = `android=new UiSelector().textContains("${name}")`;
        const isFirstClick     = click === 1;
        const _locateStart = Date.now();

        // ── CACHE PROBE (RAPID MODE) ──────────────────────────────────────────
        let fastHit = false;
        if (isRapid) {
          const cachedEl = POSPage._productCache.get(name);
          if (cachedEl) {
            // Since the cache is cleared at the start of addProductsToCart, any hit here
            // is guaranteed to be from the current transaction context. We bypass isDisplayed()
            // to save a costly Appium round-trip (retries/healing handled in catch block below).
            productEl = cachedEl;
            fastHit = true;
            if (isFirstClick) {
              perf.recordFastpath('product', true);
            }
          }
        }

        if (!productEl) {
          // ── FAST PATH ──────────────────────────────────────────────────────────
          // Single immediate probe — no retries, no scroll.
          // Attempted on every click (product button stays in same position for qty > 1).
          try {
            const exactMatches = await driver.$$(exactSelector);
            if (exactMatches.length > 0 && await exactMatches[0].isDisplayed().catch(() => false)) {
              productEl = exactMatches[0];
              fastHit = true;
            } else {
              // Try contains match as secondary single probe
              const containsMatches = await driver.$$(containsSelector);
              if (containsMatches.length > 0 && await containsMatches[0].isDisplayed().catch(() => false)) {
                productEl = containsMatches[0];
                fastHit = true;
              }
            }
          } catch (e) {}

          if (isFirstClick) {
            if (fastHit) {
              log("FASTPATH", `Product visible, skipping search`);
              perf.recordFastpath('product', true);
            } else {
              log("SEARCH", `Product not visible, using search`);
              perf.recordFastpath('product', false);
            }
          }

          // ── SEARCH FALLBACK ────────────────────────────────────────────────────
          // Only invoked when the direct probe missed. Polls with brief waits, then
          // falls back to scroll-based robust search — identical to original logic.
          if (!productEl) {
            for (let i = 0; i < 7; i++) {  // 7 more iterations (was 8 total, 1 already tried above)
              try {
                const exactMatches = await driver.$$(exactSelector);
                if (exactMatches.length > 0 && await exactMatches[0].isDisplayed()) {
                  productEl = exactMatches[0];
                  break;
                }
              } catch (e) {}

              try {
                const containsMatches = await driver.$$(containsSelector);
                if (containsMatches.length > 0 && await containsMatches[0].isDisplayed()) {
                  productEl = containsMatches[0];
                  break;
                }
              } catch (e) {}

              await driver.pause(40);
            }

            // Full scroll-based search if still not found
            if (!productEl) {
              productEl = await BasePage.findElementContainsFast(driver, name);
            }
          }

          // Cache the found element in rapid mode
          if (isRapid && productEl) {
            POSPage._productCache.set(name, productEl);
          }
        }

        _productLocateMs += (Date.now() - _locateStart);

        try {
          const _clickStart = Date.now();
          await BasePage.safeClick(driver, productEl);
          _productClickMs += (Date.now() - _clickStart);
        } catch (clickErr) {
          log("PRODUCT_WARNING", `Click ${click}/${qty} on "${name}" failed: ${clickErr.message}. Re-locating and retrying...`);
          if (isRapid) {
            POSPage._productCache.delete(name);
          }
          productEl = await BasePage.findElementContainsFast(driver, name);
          try {
            const _retryClickStart = Date.now();
            await BasePage.safeClick(driver, productEl);
            _productClickMs += (Date.now() - _retryClickStart);
            if (isRapid) {
              POSPage._productCache.set(name, productEl);
            }
          } catch (retryErr) {
            await BasePage.saveFailureScreenshot(driver, `product_click_fail_${name.replace(/\s+/g, '_')}_${click}`);
            throw new Error(`Failed to click product "${name}" (click ${click}/${qty}): ${retryErr.message}`);
          }
        }

        // Allergen toast after the first click = expected restriction (primary signal), not a failure.
        // Thrown before the Select Wallet wait, so no generic failure/recovery is triggered.
        if (click === 1) {
          const toastText = await POSPage._waitForAllergenToast(driver, name, itemIdx === 0);
          if (toastText) {
            const restrictedErr = new Error(`Allergen restriction for "${name}"`);
            restrictedErr.code = 'ALLERGEN_RESTRICTED';
            restrictedErr.product = name;
            throw restrictedErr;
          }
        }

        // Stabilization pause after every click EXCEPT the very last click of the very last product.
        // This ensures MAUI processes qty increments AND cart sync between different products.
        const isLastClickOfLastItem = isLastItem && click === qty;
        if (!isLastClickOfLastItem) {
          const _refreshStart = Date.now();
          await driver.pause(delayBetweenQty);
          _cartRefreshMs += (Date.now() - _refreshStart);
        }
      }
    }

    // After all products added: wait for wallet button to become enabled.
    // Fail fast if UiAutomator2 instrumentation/session crashes.
    const _walletReadyStart = Date.now();
    await this._waitWalletEnabled(driver, 15000, 30);
    const _walletReadyMs = Date.now() - _walletReadyStart;

    log("TIMING", `Product Locate = ${_productLocateMs}ms`);
    log("TIMING", `Product Click = ${_productClickMs}ms`);
    log("TIMING", `Cart Refresh = ${_cartRefreshMs}ms`);
    log("TIMING", `Wallet Ready = ${_walletReadyMs}ms`);

    perf.record(perf.PHASES.PRODUCT_LOCATE, _productLocateMs);
    perf.record(perf.PHASES.PRODUCT_CLICK, _productClickMs);
    perf.record(perf.PHASES.CART_REFRESH, _cartRefreshMs);
    perf.record(perf.PHASES.WALLET_READY, _walletReadyMs);

    _state.menuLoaded = true;
  }

  static async clickSelectWallet(driver) {
    log("POS", "Clicking 'Select Wallet'...");
    // Use $$ for the initial probe so a crash here is caught as INSTRUMENTATION_CRASH_DETECTED
    // rather than a raw WebDriverError (driver.$() throws on dead sessions).
    const selector = `android=new UiSelector().text("${locators.selectWalletButton}")`;
    let selectWalletButton;
    try {
      const matches = await driver.$$(selector);
      if (matches.length > 0) {
        const enabled = await matches[0].isEnabled();
        if (enabled) {
          selectWalletButton = matches[0];
        }
      }
    } catch (err) {
      if (POSPage._isFatalDriverError(err)) {
        throw new Error(`INSTRUMENTATION_CRASH_DETECTED: ${err.message}`);
      }
      throw err;
    }

    if (selectWalletButton) {
      await BasePage.safeClick(driver, selectWalletButton, 1);
    } else {
      // Guarded wait for laggy recalculation cases.
      // Uses fail-fast crash detection to avoid repeated isEnabled spam when UiAutomator2 dies.
      selectWalletButton = await this._waitWalletEnabled(driver, 3500, 30);
      await BasePage.safeClick(driver, selectWalletButton, 1);
    }

    // Fast-path wait for Pay button — poll via findElements to avoid stale-element risk.
    const paySelector = `android=new UiSelector().text("${locators.payButton}")`;
    const executionMode = process.env.EXECUTION_MODE || config.executionMode || 'standard';
    const isRapid = executionMode === 'rapid';
    await driver.waitUntil(
      async () => {
        const payMatches = await driver.$$(paySelector);
        return payMatches.length > 0 && await payMatches[0].isDisplayed().catch(() => false);
      },
      {
        timeout: 30000,
        interval: isRapid ? 100 : 50,
        timeoutMsg: 'Pay button did not appear within 30s after wallet selection'
      }
    );
  }
}

module.exports = POSPage;
