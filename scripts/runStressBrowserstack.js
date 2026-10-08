'use strict';

// Runs the existing test.js stress engine against BrowserStack.
// Cross-platform replacement for "set EXECUTION_ENV=browserstack && node test.js".
// Credentials come from BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY only.

process.env.EXECUTION_ENV = 'browserstack';

const { hasCredentials, printConfigSummary } = require('../utils/browserstackDriver');

if (!hasCredentials()) {
  console.error('BrowserStack credentials are missing.');
  console.error('Set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY in this shell, then re-run:');
  console.error('  $env:BROWSERSTACK_USERNAME = "<username>"');
  console.error('  $env:BROWSERSTACK_ACCESS_KEY = "<access-key>"');
  console.error('  npm run stress:browserstack');
  process.exit(1);
}

printConfigSummary();
require('../test.js');
