import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer, type Plugin, type ViteDevServer } from "vite";

const WEB_ROOT = fileURLToPath(new URL("../web", import.meta.url));
const SDK_ENTRY = fileURLToPath(new URL("../sdk/index.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const STYLESHEET_PATH = fileURLToPath(new URL("../web/styles.css", import.meta.url));

const HUBS_DIR_PLACEHOLDER = "__DJT_HUBS_DIR__";
const VIEW_EXTENSION = ".tsx";

function injectHubsDir(hubsDir: string): Plugin {
  return {
    name: "djt-hub:hubs-dir",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("styles.css")) return;
      return code.replace(HUBS_DIR_PLACEHOLDER, hubsDir);
    },
  };
}

// Tailwind rescans its @source globs only when the stylesheet rebuilds, and
// Vite's watcher does not match globs, so a view save must force the rebuild.
function rebuildStylesheetOnViewChange(viewHost: ViteDevServer, hubsDir: string): void {
  viewHost.watcher.add(hubsDir);
  viewHost.watcher.on("all", (_event, file) => {
    if (!file.startsWith(hubsDir) || !file.endsWith(VIEW_EXTENSION)) return;
    for (const stylesheet of viewHost.moduleGraph.getModulesByFile(STYLESHEET_PATH) ?? []) {
      void viewHost.reloadModule(stylesheet);
    }
  });
}

// Views live outside the repo, so bare imports like "react" from a view
// would not find node_modules. dedupe resolves them from the repo instead.
// Each server gets its own cacheDir, so two servers never rewrite one dep cache.
export async function startViewHost(httpServer: Server, hubsDir: string, cacheDir: string): Promise<ViteDevServer> {
  const viewHost = await createViteServer({
    root: WEB_ROOT,
    cacheDir,
    configFile: false,
    appType: "spa",
    logLevel: "warn",
    clearScreen: false,
    plugins: [injectHubsDir(hubsDir), react(), tailwindcss()],
    resolve: {
      alias: { "djt-hub": SDK_ENTRY },
      dedupe: ["react", "react-dom", "uplot"],
    },
    server: {
      middlewareMode: true,
      hmr: { server: httpServer, overlay: false },
      fs: { allow: [REPO_ROOT, hubsDir] },
    },
    optimizeDeps: { include: ["react", "react-dom", "react-dom/client", "react/jsx-dev-runtime", "uplot"] },
  });
  rebuildStylesheetOnViewChange(viewHost, hubsDir);
  return viewHost;
}
