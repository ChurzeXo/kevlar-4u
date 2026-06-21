---
description: Commit Pro submodule changes and update the parent repo pointer.
agent: build
---

Commit Pro changes inside src/pro/ AND update the parent repo submodule pointer.

Equivalent to `npm run commit:pro`, which:
1. `cd src/pro && git add . && git commit && git push` — push to private repo
2. `cd ../.. && git add src/pro && git commit && git push` — update pointer in public repo

Generate commit messages for BOTH repos based on the actual changes.
