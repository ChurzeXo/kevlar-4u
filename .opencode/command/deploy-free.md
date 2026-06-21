---
description: Build, test, leak-check, and deploy the Free tier to npm.
agent: build
---

Deploy the Free (open-source) kevlar-4u package to npm.

Pre-flight checklist:
1. `rm -rf dist && npm run build` — clean build
2. `npm test` — 315 tests must pass
3. `ls dist/pro 2>/dev/null && echo "❌ LEAK!" || true` — no Pro code in dist/
4. `npm pack --dry-run | grep "total files"` — should be ~392, no `bundle-cache`, `rules_pro`, `rules_sensitive`, `rules_lowbrow`, `skills/tmp/`

Then tag and push to trigger CI:
```bash
npm version patch -m "chore: release %s"
git push churzexo main --tags
```

CI (`.github/workflows/release.yml`) will: build → leak-check → test → changelog → GitHub Release → npm publish.

Do NOT run `npm publish` locally — the CI handles it.
