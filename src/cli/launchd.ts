import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonAddress, dataDir } from "../config.ts";

const LAUNCH_AGENT_LABEL = "com.djaunt.djt-hub";
const BOOTSTRAP_ATTEMPTS = 10;
const BOOTSTRAP_RETRY_MS = 300;
const STATUS_ATTEMPTS = 40;
const STATUS_RETRY_MS = 250;
const CLI_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderPlist(options: { bunPath: string; cliEntry: string; address: string; dataDir: string; path: string; logFile: string }): string {
  const value = (text: string) => `<string>${escapeXml(text)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	${value(LAUNCH_AGENT_LABEL)}
	<key>ProgramArguments</key>
	<array>
		${value(options.bunPath)}
		${value(options.cliEntry)}
		${value("serve")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		${value(options.path)}
		<key>DJT_HUB_ADDR</key>
		${value(options.address)}
		<key>DJT_HUB_DATA</key>
		${value(options.dataDir)}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	${value("Background")}
	<key>StandardOutPath</key>
	${value(options.logFile)}
	<key>StandardErrorPath</key>
	${value(options.logFile)}
</dict>
</plist>
`;
}

function launchctl(...args: string[]): { exitCode: number; output: string } {
  const result = Bun.spawnSync(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}`.trim() };
}

// launchd refuses a bootstrap while the previous instance is still exiting.
async function bootstrap(plistPath: string): Promise<void> {
  let lastOutput = "";
  for (let attempt = 0; attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
    const result = launchctl("bootstrap", launchdDomain(), plistPath);
    if (result.exitCode === 0) return;
    lastOutput = result.output;
    await Bun.sleep(BOOTSTRAP_RETRY_MS);
  }
  throw new Error(`launchctl bootstrap failed: ${lastOutput}`);
}

async function waitForDaemon(address: string): Promise<boolean> {
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`http://${address}/api/status`);
      if (response.ok) return true;
    } catch {}
    await Bun.sleep(STATUS_RETRY_MS);
  }
  return false;
}

async function install(): Promise<number> {
  const plistPath = launchAgentPath();
  const hubDataDir = dataDir();
  const address = daemonAddress();
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(hubDataDir, { recursive: true });
  writeFileSync(
    plistPath,
    renderPlist({
      bunPath: process.execPath,
      cliEntry: CLI_ENTRY,
      address,
      dataDir: hubDataDir,
      path: process.env.PATH ?? "/usr/bin:/bin",
      logFile: join(hubDataDir, "daemon.log"),
    }),
  );
  launchctl("bootout", `${launchdDomain()}/${LAUNCH_AGENT_LABEL}`);
  await bootstrap(plistPath);
  if (!(await waitForDaemon(address))) {
    console.error(JSON.stringify({ error: `daemon did not answer at ${address}; see ${join(hubDataDir, "daemon.log")}` }));
    return 1;
  }
  console.log(JSON.stringify({ installed: plistPath, url: `http://${address}` }, null, 2));
  return 0;
}

function uninstall(): number {
  launchctl("bootout", `${launchdDomain()}/${LAUNCH_AGENT_LABEL}`);
  rmSync(launchAgentPath(), { force: true });
  console.log(JSON.stringify({ uninstalled: LAUNCH_AGENT_LABEL, kept: dataDir() }, null, 2));
  return 0;
}

export async function runLaunchdCommand(commandName: "install" | "uninstall"): Promise<number> {
  if (process.platform !== "darwin") {
    console.error(JSON.stringify({ error: "launchd is macOS only; run `djt-hub serve` under your own supervisor" }));
    return 1;
  }
  return commandName === "install" ? install() : uninstall();
}
