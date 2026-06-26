import { createKevlarServer } from "./src/server.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

async function main() {
  const server = await createKevlarServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "kevlar-e2e-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    // Step 1
    const s1 = await client.callTool({ name: "review_content_wizard", arguments: { userMessage: "请评测这篇内容：这是一个用于 E2E 测试的文本" } });
    const t1 = (s1.content as any)[0].text;
    const m1 = t1.match(/currentStep:\s*(\w+)/);
    console.log(`STEP1 currentStep=${m1?.[1] || "N/A"} tier=${t1.match(/tier:\s*(\w+)/)?.[1] || "N/A"} len=${t1.length}`);
    const sid = t1.match(/sessionId:\s*([a-z0-9-]+)/)![1];

    // Step 2
    const s2 = await client.callTool({ name: "review_content_wizard", arguments: { sessionId: sid, userMessage: "全球" } });
    const t2 = (s2.content as any)[0].text;
    const m2 = t2.match(/currentStep:\s*(\w+)/);
    console.log(`STEP2 currentStep=${m2?.[1] || "N/A"} tier=${t2.match(/tier:\s*(\w+)/)?.[1] || "N/A"} len=${t2.length}`);
    console.log("STEP2 first 200 chars:", t2.substring(0, 200));

    // Step 3
    const s3 = await client.callTool({ name: "review_content_wizard", arguments: { sessionId: sid, userMessage: "开始舆论仿真推演" } });
    const t3 = (s3.content as any)[0].text;
    const m3 = t3.match(/currentStep:\s*(\w+)/);
    console.log(`STEP3 currentStep=${m3?.[1] || "N/A"} tier=${t3.match(/tier:\s*(\w+)/)?.[1] || "N/A"} len=${t3.length}`);

    // Step 4
    const s4 = await client.callTool({ name: "review_content_wizard", arguments: { sessionId: sid, userMessage: "开始舆论仿真推演" } });
    const t4 = (s4.content as any)[0].text;
    const m4 = t4.match(/currentStep:\s*(\w+)/);
    console.log(`STEP4 currentStep=${m4?.[1] || "N/A"} tier=${t4.match(/tier:\s*(\w+)/)?.[1] || "N/A"} len=${t4.length}`);
    console.log("STEP4 has E2E Tester?", t4.includes("E2E Tester"));
    console.log("STEP4 has waitingForInventoryCheck?", t4.includes("waitingForInventoryCheck"));
  } finally {
    await client.close();
    await server.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
