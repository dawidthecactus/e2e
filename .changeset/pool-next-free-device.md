---
'@e2e-dev/mobile': patch
---

Without a `device` option, a device another agent-device session claims between the engine's inventory and its warm-up is swapped for the next free booted device, so two `launch()` hosts opened at the same moment no longer fail when a second device is free.
