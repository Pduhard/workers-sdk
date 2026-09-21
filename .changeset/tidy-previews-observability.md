---
"wrangler": minor
---

Prevent beta Preview onboarding from writing null observability settings

The Preview Base API can return `null` for unset observability fields, which are not valid Wrangler configuration values. Wrangler now omits those fields while preserving meaningful null values in JSON bindings.
