import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { daemonAddress, dataDir } from "../config.ts";
import { HubStore } from "../store/store.ts";
import { createApp } from "./app.ts";

const [host, port] = daemonAddress().split(":");
const store = new HubStore(dataDir());
const { app } = createApp({ store });

createServer(getRequestListener(app.fetch)).listen(Number(port), host, () => {
  console.log(`djt-hub listening on http://${host}:${port} (hubs in ${store.hubsDir})`);
});
