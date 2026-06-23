---

description: Deploy both Free (npm) and Pro (submodule) in sequence.
agent: build
---

Deploy everything: first sync the Pro submodule, then release Free to npm, then update the backend version record.

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
git push origin main --tags
```

Do NOT run `npm publish` — CI handles it.

Step 4 — Sync version to kevlar4u.xyz backend:
```bash
VERSION=$(node -e "console.log(require('./package.json').version)")
curl -s -X POST https://kevlar4u.xyz/api/v1/admin/version \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer kevlar-admin-api-dev" \
  -d "{\"version\":\"$VERSION\",\"changelog\":\"<在此填写更新摘要>\",\"breaking\":false}"
```

Verify:
```bash
curl -s https://kevlar4u.xyz/api/v1/version
```