---
'@e2e-dev/acp': patch
---

On Windows, a Codex `env` variable spelled in any case (such as `openai_api_key`) now overrides the inherited value, including an explicit blank.
