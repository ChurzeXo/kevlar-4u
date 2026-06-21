---
description: Build, test, stage all Free changes, commit, and push to main.
agent: build
---

Commit and push Free-tier changes (src/, scripts/, docs/, config/ — NOT src/pro/).

1. Build and test:
   ```bash
   rm -rf dist && npm run build && npm test
   ```

2. Stage everything:
   ```bash
   git add -A
   ```

3. Review staged changes:
   ```bash
   git status --short
   ```

4. Commit with a conventional-commit message:
   ```bash
   git commit -m "type: description"
   ```
   Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`.

5. Push:
   ```bash
   git push churzexo main
   ```

If `src/pro` changed (submodule pointer), use `/commit-pro` instead.
