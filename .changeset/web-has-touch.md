---
"@e2e-dev/web": patch
---

Touchscreen emulation is turned on with `web({ hasTouch: true })`, so an app's touch handlers can be tested on a web target. It's off by default.

- A `tap` on a node or at a point is sent as `touchstart` and `touchend`, followed by a click unless the touch is cancelled.
- A swipe along a path (`screen.swipe({ from, to })`) is sent as `touchstart`, `touchmove`, and `touchend` on Chromium. It's `UNSUPPORTED_CAPABILITY` in Firefox and WebKit, since touch moves can't be sent there.
- Other actions are still sent as mouse and keyboard input.

Like `userAgent`, the option is applied only when a context is created. So `hasTouch: true` with `connect.reconnectEndpoint` or a browser provider with `scope: 'attempt'` is `INVALID_CONFIG`.
