/** Disposable Synapse interoperability check. Requires Docker or CONTAINER_RUNTIME=podman. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const runtime = process.env.CONTAINER_RUNTIME ?? "docker";
const image = process.env.SYNAPSE_IMAGE ?? "ghcr.io/element-hq/synapse:v1.160.0";
const name = `grungus-e2e-${randomUUID().slice(0, 8)}`;
const volume = `${name}-data`;
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(command, args, { stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit", env: options.env ?? process.env });
    if (options.capture) child.stdout.on("data", chunk => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} exited ${code}`)));
  });
}
let succeeded = false;
try {
  await run(runtime, ["run", "--rm", "-v", `${volume}:/data`, "-e", "SYNAPSE_SERVER_NAME=grungus.test", "-e", "SYNAPSE_REPORT_STATS=no", image, "generate"]);
  const configure = `
import yaml
p = '/data/homeserver.yaml'
with open(p) as f: config = yaml.safe_load(f)
config.update({
  'enable_registration': True,
  'enable_registration_without_verification': True,
  'trusted_key_servers': [],
  'suppress_key_server_warning': True,
  'federation_domain_whitelist': [],
  'rc_registration': {'per_second': 100, 'burst_count': 1000},
  'rc_message': {'per_second': 100, 'burst_count': 1000},
  'rc_joins': {'local': {'per_second': 100, 'burst_count': 1000}},
  'rc_login': {k: {'per_second': 100, 'burst_count': 1000} for k in ['address', 'account', 'failed_attempts']}
})
with open(p, 'w') as f: yaml.safe_dump(config, f)
`;
  await run(runtime, ["run", "--rm", "-v", `${volume}:/data`, "--entrypoint", "python", image, "-c", configure]);
  await run(runtime, ["run", "-d", "--name", name, "-p", "127.0.0.1::8008", "-v", `${volume}:/data`, image]);
  const address = await run(runtime, ["port", name, "8008/tcp"], { capture: true });
  const homeserver = `http://${address.split("\n")[0]}`;
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    try { ready = (await fetch(`${homeserver}/_matrix/client/versions`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* startup */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("Synapse did not become ready within 60 seconds");
  await run(process.execPath, ["tests/e2e-real-homeserver.ts"], { env: {
    ...process.env, GRUNGUS_E2E_HOMESERVER: homeserver, GRUNGUS_E2E_SERVER_NAME: "grungus.test",
    GRUNGUS_E2E_REGISTER: "1", GRUNGUS_E2E_USER1: "grungus_a", GRUNGUS_E2E_USER2: "grungus_b",
    GRUNGUS_E2E_PASS1: randomUUID(), GRUNGUS_E2E_PASS2: randomUUID(), GRUNGUS_E2E_WAIT_MS: "30000",
  } });
  succeeded = true;
} finally {
  if (!succeeded) await run(runtime, ["logs", "--tail", "80", name]).catch(() => {});
  await run(runtime, ["rm", "-f", name]).catch(() => {});
  await run(runtime, ["volume", "rm", volume]).catch(() => {});
}
