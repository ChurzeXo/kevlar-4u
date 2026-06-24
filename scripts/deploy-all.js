#!/usr/bin/env node
/**
 * One-command release: bump version → push → sync backend.
 *
 * Usage:
 *   ADMIN_API_TOKEN=xxx npm run deploy:all -- "更新摘要"
 *   ADMIN_API_TOKEN=xxx npm run deploy:all -- "更新摘要" minor
 */
import { execSync } from "child_process";

const CHANGELOG = process.argv[2];
const BUMP = process.argv[3] || "patch";

if (!CHANGELOG) {
  console.error("用法: npm run deploy:all -- \"更新摘要\" [patch|minor|major]");
  process.exit(1);
}

if (!process.env.ADMIN_API_TOKEN) {
  console.error("❌ 请设置环境变量 ADMIN_API_TOKEN");
  process.exit(1);
}

try {
  // 1. Bump version + tag
  console.log(`📦 npm version ${BUMP}...`);
  execSync(`npm version ${BUMP} -m "chore: release %s"`, { stdio: "inherit" });

  // 2. Push
  console.log("🚀 git push origin main --tags...");
  execSync("git push origin main --tags", { stdio: "inherit" });

  // 3. Sync backend
  console.log("☁️  同步后端版本...");
  execSync(
    `node ./scripts/sync-backend-version.js "${CHANGELOG}"`,
    { stdio: "inherit" },
  );

  console.log("✅ 发布完成！");
} catch (err) {
  console.error("❌ 发布失败:", err.message);
  process.exit(1);
}
