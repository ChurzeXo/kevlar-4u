---
description: Stage all changes, commit with a conventional-commit message, and push to main.
agent: build
---

Commit and push all current changes to the main branch.

1. Build and test first:
   ```bash
   rm -rf dist && npm run build && npm test
   ```

2. Stage everything:
   ```bash
   git add -A
   ```

3. Review what's staged:
   ```bash
   git status --short
   ```

4. Commit with a conventional-commit message describing the changes:
   ```bash
   git commit -m "type: description"
   ```

   Use conventional commit types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`.
   Generate the message based on the actual changes in `git status --short` and `git diff --stat`.

5. Push:
   ```bash
   git push churzexo main
   ```

If the Pro submodule (`src/pro`) has changed, remind to run `/deploy-pro` separately.
