// Container launcher entrypoint — the Docker CMD (`apps/api/start.sh`) runs
// this file; `src/index.ts` stays the local/dev entry.
//
// Why this exists: a Heroku container web dyno that does not bind `$PORT`
// within its boot window (~15s) is declared crashed and reaped (observed on
// dosco: "starting" -> "crashed" ~16s later, repeatedly). Importing
// `src/index.ts` first cannot meet that window on a cold start: that module
// evaluates the whole ~2.9k-file route graph AND awaits the live model-pricing
// fetch before Bun's auto-serve binds the port.
//
// So this entry binds a thin listener immediately, then loads the app behind
// it. Requests that arrive before the app finishes evaluating wait on the same
// import; WebSocket events are delegated to the app's handlers, which own all
// dispatch via `ws.data.type`.

type IndexModule = typeof import('./index');

let indexPromise: Promise<IndexModule> | null = null;
let indexModule: IndexModule | null = null;

function loadIndex(): Promise<IndexModule> {
  if (!indexPromise) {
    indexPromise = import('./index').then(
      (mod) => {
        // Same boot sequence index.ts runs as an entry module: schema check ->
        // services -> signal handlers. Fire-and-forget (as before): a failed
        // schema check still starts services.
        mod.startBootServices();
        indexModule = mod;
        return mod;
      },
      (err) => {
        console.error('[startup] app module failed to evaluate:', err);
        throw err;
      },
    );
  }
  return indexPromise;
}

const port = Number(process.env.PORT ?? 8008);

Bun.serve({
  port,
  // Mirror the app server's socket settings (index.ts default export): 0
  // disables Bun's idle ceilings so long provisioning calls, SSE streams, and
  // tunnels are not cut.
  idleTimeout: 0,
  async fetch(req, srv) {
    let mod: IndexModule;
    try {
      mod = await loadIndex();
    } catch {
      return new Response('Service starting', {
        status: 503,
        headers: { 'retry-after': '5' },
      });
    }
    // The app's fetch wrapper owns captureServer/beginWork/finishRequest and
    // returns undefined for an accepted WebSocket upgrade.
    return await mod.default.fetch(req, srv);
  },
  websocket: {
    idleTimeout: 0,
    // A socket can only exist after the app's fetch ran (it is the only place
    // that upgrades), so indexModule is set by the time these fire.
    open(ws) {
      indexModule?.default.websocket.open(ws as any);
    },
    message(ws, msg) {
      indexModule?.default.websocket.message(ws as any, msg);
    },
    close(ws) {
      indexModule?.default.websocket.close(ws as any);
    },
  },
});

console.log(`[startup] launcher bound port ${port}; loading app behind the listener...`);

// Load now instead of on first request: boot (schema + workers) must not wait
// for traffic. Errors are reported by loadIndex's rejection logger.
void loadIndex().catch(() => {});
