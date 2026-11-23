---
"@e2e-dev/web": patch
---

Add `browser.consoleMessages()` and `browser.pageErrors()`, which return the active tab's console messages (`{ type, text }`) and its uncaught errors and unhandled promise rejections (`{ message, stack }`) since the tab opened. Up to 200 of the latest of each are kept. They aren't cleared on navigation. After `app.restart()`, they only have the new page's. To check for console errors, you no longer need an init script that wraps `console.error` and listens for `error` and `unhandledrejection`.
