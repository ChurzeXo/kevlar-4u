---
description: Deploy both Free (npm) and Pro (submodule) in sequence.
agent: build
---

Deploy everything: first sync the Pro submodule, then release Free to npm.

Step 1 — Pro submodule:
```bash
npm run commit:pro
```

Step 2 — Free release:
```bash
rm -rf dist && npm run build && npm test
ls dist/pro 2>/dev/null && echo "❌ LEAK!" || echo "✅ Clean"
npm pack --dry-run | grep "total files"
```

Step 3 — Tag & push:
```bash
npm version patch -m "chore: release %s"
git push churzexo main --tags
```

Do NOT run `npm publish` — CI handles it.
