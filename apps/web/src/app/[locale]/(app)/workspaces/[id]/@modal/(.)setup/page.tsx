import { SetupModalRoute } from '../../setup/setup-modal-route';

/** `/workspaces/<id>/setup` opened by a link inside the workspace: the modal over the current page, same URL. */
export default function InterceptedSetupRoute() {
  return <SetupModalRoute mode="intercepted" />;
}
