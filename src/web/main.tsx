import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HubList } from "./shell/hub-list.tsx";
import { HubPage } from "./shell/hub-page.tsx";
import "./styles.css";

const HUB_ROUTE = /^\/h\/([a-z0-9][a-z0-9-]*)\/?$/;

function App() {
  const hubMatch = HUB_ROUTE.exec(window.location.pathname);
  if (hubMatch) return <HubPage hubId={hubMatch[1]!} />;
  return <HubList />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
