/**
 * Characterization: the HTTP refusals of the App fleet edge, pinned before its
 * typed-route refactor (KRTX-4617). The service layer is stubbed; the routes'
 * own answers are what must survive the refactor unchanged: the 404 for an App
 * the caller cannot see, the 409 mapping of a refused volume destroy, the
 * confirmation gate, and the 200 body shape of the machine listing.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';

const app = makeOpenApiApp<AppEnv>();

mock.module('../projects/surface', () => ({ projectsApp: app }));
/** What the gate's `visibleApp` answers: null = an App the caller cannot see. */
const gate = { visible: null as Record<string, unknown> | null };
mock.module('./route-access', () => ({
  authorizedProject: async () => ({ userId: 'user-1' }),
  visibleApp: async () => gate.visible,
}));

/** The same shapes the real classes carry (status, code, message). */
class AppFleetError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AppFleetError';
  }
}
class AppVolumeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AppVolumeError';
  }
}

const machines: unknown[] = [];
const volumes = { destroyThrows: null as AppVolumeError | null };
/** The same shapes the real wake classes carry (KRTX-4730: the timeout is a class). */
class AppWakeInProgressError extends Error {
  constructor() {
    super('App cold start did not finish in time');
    this.name = 'AppWakeInProgressError';
  }
}
const fleet = { startThrows: null as Error | Response | null };
mock.module('./public-proxy-runtime', () => ({ AppWakeInProgressError }));
mock.module('./fleet', () => ({
  AppFleetError,
  MAX_GROUP_SCALE: 8,
  listAppMachines: async () => machines,
  startMachine: async () => {
    if (fleet.startThrows) throw fleet.startThrows;
  },
  stopMachine: async () => {},
  restartMachine: async () => {
    if (fleet.startThrows) throw fleet.startThrows;
  },
  destroyMachine: async () => {},
  setAppScale: async () => ({}),
  execInMachine: async () => ({}),
  restoreAppVolume: async () => {},
}));
mock.module('./volumes', () => ({
  AppVolumeError,
  createAppVolume: async () => ({}),
  createVolumeSnapshot: async () => ({}),
  destroyVolume: async () => {
    if (volumes.destroyThrows) throw volumes.destroyThrows;
  },
  forkVolume: async () => ({}),
  getAppVolume: async () => ({ appId: 'app-1', name: 'data' }),
  listAppVolumes: async () => [],
  listVolumeSnapshots: async () => [],
  updateAppVolume: async () => ({}),
  volumeInfo: async () => null,
}));

const { registerAppFleetRoutes } = await import('./fleet-routes');
registerAppFleetRoutes();

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const APP_ID = '00000000-0000-4000-8000-000000000002';
const VOLUME_ID = '00000000-0000-4000-8000-000000000003';
const APP_ROW = { appId: APP_ID, accountId: '00000000-0000-4000-8000-000000000004' };

describe('App fleet routes: HTTP refusals', () => {
  afterEach(() => {
    fleet.startThrows = null;
  });

  test('a machine route 404s for an App the caller cannot see', async () => {
    gate.visible = null;
    const res = await app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/machines`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('a machine route answers the fleet listing it gets', async () => {
    gate.visible = APP_ROW;
    machines.length = 0;
    machines.push({ machine_id: 'm1' });
    const res = await app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/machines`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ machines: [{ machine_id: 'm1' }] });
  });

  test('a volume destroy refused by the store maps to its documented answer', async () => {
    gate.visible = APP_ROW;
    volumes.destroyThrows = new AppVolumeError(409, 'volume_attached', 'The volume is mounted on a machine; stop the machine first.');
    const res = await app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/volumes/${VOLUME_ID}?confirm=data`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The volume is mounted on a machine; stop the machine first.', code: 'volume_attached' });
  });

  test('a machine start still in progress answers the starting contract, not a 500', async () => {
    gate.visible = APP_ROW;
    fleet.startThrows = new AppWakeInProgressError();
    const res = await app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/machines/00000000-0000-4000-8000-000000000005/start`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'The machine is still starting: another start was already running. Check the machines list again.', code: 'machine_start_in_progress' });
  });

  test('a wake superseded mid-flight passes its 409 through', async () => {
    gate.visible = APP_ROW;
    fleet.startThrows = Response.json({ error: 'App start was superseded by a newer lifecycle request', code: 'app_start_superseded' }, { status: 409 });
    const res = await app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/machines/00000000-0000-4000-8000-000000000005/restart`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'App start was superseded by a newer lifecycle request', code: 'app_start_superseded' });
  });

  test('a volume destroy without the exact name asks for confirmation', async () => {
    gate.visible = APP_ROW;
    volumes.destroyThrows = null;
    const res = await app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/volumes/${VOLUME_ID}?confirm=wrong`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Destroying a volume deletes its data: pass confirm=data.', code: 'confirmation_required' });
  });
});
