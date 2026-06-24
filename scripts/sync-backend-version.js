#!/usr/bin/env node
/**
 * Sync version to kevlar4u.xyz backend after npm publish.
 *
 * Reads version from package.json, ADMIN_API_TOKEN from env.
 * Usage: npm run sync:backend [changelog]
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const TOKEN = process.env.ADMIN_API_TOKEN;
const VERSION = pkg.version;
const CHANGELOG = process.argv[2] || "更新摘要";

if (!TOKEN) {
  console.error("❌ 请设置环境变量 ADMIN_API_TOKEN");
  console.error("   开发环境：export ADMIN_API_TOKEN=kevlar-admin-api-dev");
  process.exit(1);
}

try {
  const resp = await fetch("https://kevlar4u.xyz/api/v1/admin/version", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ version: VERSION, changelog: CHANGELOG, breaking: false }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`❌ 后端返回 HTTP ${resp.status}: ${text}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`✅ 版本已同步: v${data.version} (${data.releasedAt})`);
} catch (err) {
  console.error("❌ 请求失败:", err.message);
  process.exit(1);
}
