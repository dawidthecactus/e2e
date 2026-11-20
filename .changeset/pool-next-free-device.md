---
'@e2e-dev/mobile': patch
---

Without a `device` option, a booted device another agent-device session claims while the engine's warm-up starts the iOS runner or opens the app on it is swapped for the next free booted device, so two `launch()` hosts opened at the same moment no longer fail when a second device is free. A local target with `appPath` opens nothing during warm-up, so its hosts can still collide later. A refusal at the runner start or the open with no other device free now fails `prepare` with agent-device's refusal, where a worker used to fail at its start.
