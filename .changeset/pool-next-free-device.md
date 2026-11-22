---
'@e2e-dev/mobile': patch
---

Without a `device` option, a booted device another agent-device session claims while the engine's warm-up boots it, starts the iOS runner, or opens the app is swapped for the next free booted device, so two `launch()` hosts opened at the same moment no longer fail when a second device is free. A local target with `appPath` opens nothing during warm-up, so its hosts can still collide later. When another session refuses the runner start or the open and no other device is free, `prepare` now fails with agent-device's refusal, where a worker used to fail at its start. A refusal by a short-lived agent-device command (an install on the same simulator) at the runner start or the open is left to the worker's start, as before.
