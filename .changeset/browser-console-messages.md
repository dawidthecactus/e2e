---
"@e2e-dev/web": patch
---

Add `browser.consoleMessages()` and `browser.pageErrors()`. They return what the active tab logged to the console (`{ type, text }`) and the errors it threw or the promise rejections it left unhandled (`{ message, stack }`) since it opened, up to the latest 200 of each. A navigation keeps the lists and `app.restart()` empties them. A test no longer needs an init script that wraps `console.error` and listens for `error` and `unhandledrejection` to check for them.
