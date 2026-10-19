export const DEFAULT_VIEW_SOURCE = `import { useHub } from "djt-hub";

export default function View() {
  const { state } = useHub();
  return <pre>{JSON.stringify(state, null, 2)}</pre>;
}
`;
