/**
 * lib/lab-v2/adapters/ddx.ts — the `ddx` engine behind the fence (§17.3, decision 37).
 *
 * The route file is UNTOUCHED. `POST` is imported and called in process with a synthetic
 * NextRequest inside `withLabExecution`; see lib/lab-v2/adapters/types.ts for the request
 * construction, the edges, and why this is never a network self-fetch.
 *
 * Stages (decision 35/35a): investigations_parse (conditional), clinical_state_normalise (conditional), ddx_draft, ddx_critique, ddx_revision
 */
import { POST } from '@/app/api/ddx/route';
import { assessStream, eventTypes, makeRouteAdapter, type Adapter, type RouteAdapterDeps, type RouteRead } from './types';

export function makeDdxAdapter(deps: RouteAdapterDeps = {}): Adapter {
  return makeRouteAdapter({
    engine: 'ddx',
    path: '/api/ddx',
    post: POST,
    summarise: (read: RouteRead) => ({ event_types: eventTypes(read), events: read.events.length }),
    assess: assessStream,
  }, deps);
}
