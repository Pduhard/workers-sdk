---
"wrangler": minor
---

Allow beta Preview onboarding to update commented TOML files

Wrangler can now add suggested Preview configuration to `wrangler.toml` files that contain comments. It distinguishes actual comments from `#` characters inside quoted values so onboarding does not unnecessarily fall back to manual instructions.
