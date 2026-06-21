---
description: Commit and push the Pro submodule, then update the parent repo pointer.
agent: build
---

Sync the private Pro submodule (src/pro/) to GitHub and update the parent repo pointer.

```bash
npm run commit:pro
```

This one-liner does:
1. `cd src/pro && git add . && git commit && git push` — push Pro code to ChurzeXo/kevlar-pro-runtime (private)
2. `cd ../.. && git add src/pro && git commit && git push` — update submodule pointer in ChurzeXo/kevlar-4u (public)

For the full Pro publish to GitHub Packages:
```bash
cd src/pro
npm install --legacy-peer-deps
npx tsc
npm test                                    # 35 pass
npm publish --registry=https://npm.pkg.github.com
```
