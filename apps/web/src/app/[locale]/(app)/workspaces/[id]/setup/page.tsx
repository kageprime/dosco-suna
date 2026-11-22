import ProjectIndexPage from '../page';
import { SetupModalRoute } from './setup-modal-route';

/**
 * `/workspaces/<id>/setup` on a direct load (`kortix onboard` opens it): the
 * workspace home with the setup modal over it. A link inside the workspace
 * never reaches this file: `@modal/(.)setup` intercepts it.
 */
export default function WorkspaceSetupRoute() {
  return (
    <>
      <ProjectIndexPage />
      <SetupModalRoute mode="page" />
    </>
  );
}
