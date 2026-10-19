// The view a new hub starts with. It doubles as a working demo of the kit:
// replace it with whatever the job needs.
export const DEFAULT_VIEW_SOURCE = `import { Grid, Panel, Steps, Stats, Actions, Log, useHub } from "djt-hub";

export default function View() {
  const { state } = useHub();
  return (
    <Grid>
      <Panel eyebrow="Runbook" title="Steps" width="two-thirds">
        <Steps id="run" bind="steps" />
      </Panel>
      <Panel eyebrow="Health" title="Now" width="third">
        <Stats bind="health" />
      </Panel>
      <Panel eyebrow="Controls" title="Actions" width="third">
        <Actions id="controls" items={[{ id: "pause", label: "Pause" }, { id: "abort", label: "Abort", tone: "danger", confirm: true }]} />
      </Panel>
      <Panel eyebrow="Events" title="Activity" width="two-thirds">
        <Log events="*" />
      </Panel>
      {Object.keys(state).length === 0 && (
        <Panel eyebrow="Empty" title="Waiting for state" width="full">
          <p className="text-sm text-muted">Patch "steps" and "health", or rewrite this view.</p>
        </Panel>
      )}
    </Grid>
  );
}
`;
