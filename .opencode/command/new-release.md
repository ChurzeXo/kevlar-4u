---
description: Create a new npm release: bump version, tag, push (CI auto-publishes).
agent: build
---

Create a new kevlar-4u release by bumping the version, creating a git tag, and pushing.

Full release flow:
1. Build and test:
   ```bash
   rm -rf dist && npm run build && npm test
   ```

2. Leak check:
   ```bash
   ls dist/pro 2>/dev/null && echo "❌ LEAK: Pro code in dist/!" || echo "✅ Clean"
   npm pack --dry-run | grep "total files"
   # Must NOT include: bundle-cache, rules_pro, rules_sensitive, rules_lowbrow, skills/tmp/
   ```

3. If `src/pro/` submodule changed, sync it first:
   ```bash
   npm run commit:pro
   ```

4. Bump version (patch/minor/major as appropriate):
   ```bash
   npm version patch -m "chore: release %s"
   ```

5. Push:
   ```bash
   git push churzexo main --tags
   ```

CI at `.github/workflows/release.yml` auto-runs on tag push:
- Checks out without private submodule
- Builds, tests (315), leak-checks
- Creates GitHub Release with changelog
- Publishes to npm

Note: `npm run prepublishOnly` blocks direct `npm publish` — only CI can publish.
