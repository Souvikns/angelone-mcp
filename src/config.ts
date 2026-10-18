import { join } from "node:path";

// Bun only auto-loads .env from the cwd, and MCP clients usually launch the
// server from elsewhere, so also read the .env next to the project root.
async function loadProjectEnv() {
  const file = Bun.file(join(import.meta.dir, "..", ".env"));
  if (!(await file.exists())) return;
  for (const line of (await file.text()).split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
}

await loadProjectEnv();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (set it in .env)`);
  return v;
}

export const config = {
  apiKey: required("ANGEL_API_KEY"),
  clientCode: required("ANGEL_CLIENT_CODE"),
  pin: required("ANGEL_PIN"),
  totpSecret: required("ANGEL_TOTP_SECRET"),
  enableTrading: process.env.ANGEL_ENABLE_TRADING === "true",
  localIp: process.env.ANGEL_LOCAL_IP ?? "127.0.0.1",
  publicIp: process.env.ANGEL_PUBLIC_IP ?? "127.0.0.1",
  macAddress: process.env.ANGEL_MAC_ADDRESS ?? "00:00:00:00:00:00",
};
