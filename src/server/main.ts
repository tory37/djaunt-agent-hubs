import { daemonAddress, dataDir } from "../config.ts";
import { startServer } from "./serve.ts";

const running = await startServer({ address: daemonAddress(), dataDir: dataDir() });
console.log(`djt-hub listening on http://${running.address} (hubs in ${running.store.hubsDir})`);
