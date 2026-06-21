import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

try {
  console.log("🚀 开始自动化同步 Pro 子模块...");

  const proDir = join(__dirname, "..", "src", "pro");

  // 1. Enter submodule, commit and push Pro code
  console.log("📦 正在提交并推送 Pro 私有仓代码...");
  execSync("git add . && git commit -m 'chore: auto sync pro runtime' && git push", {
    cwd: proDir,
    stdio: "inherit",
  });

  // 2. Back to parent repo, commit submodule pointer change
  console.log("🔗 正在更新主仓的子模块指针...");
  execSync("git add src/pro && git commit -m 'push: update pro submodule pointer' && git push", {
    cwd: join(__dirname, ".."),
    stdio: "inherit",
  });

  console.log("✅ Pro 代码与主仓指针全部同步成功！");
} catch (error) {
  console.error(
    "❌ 同步失败，请检查各仓库是否有未提交冲突或无推送权限。",
    error.message,
  );
  process.exit(1);
}
