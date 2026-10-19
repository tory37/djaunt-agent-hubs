export async function runLaunchdCommand(commandName: "install" | "uninstall"): Promise<number> {
  console.error(JSON.stringify({ error: `${commandName} is not available yet` }));
  return 1;
}
