---
'@e2e-dev/core': patch
'e2e': patch
---

A new `locators` config option, at the top level and on each target, sets the default `visible` option of `getByText`, `getByLabel`, `getByPlaceholder`, and `getByTestId`. With `locators: { visible: true }` those queries skip hidden nodes, such as a native screen kept mounted behind the current one, without `{ visible: true }` on each query. A target's `locators` replaces the config's, and a query's own `visible` wins over both. The default stays `false`. An invalid value is `INVALID_CONFIG`.
