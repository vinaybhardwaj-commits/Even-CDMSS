/**
 * lib/lab-v2/adapters/appropriateness.ts — the `appropriateness` engine behind the fence (§17.3, decision 37).
 *
 * The route file is UNTOUCHED. `POST` is imported and called in process with a synthetic
 * NextRequest inside `withLabExecution`; see lib/lab-v2/adapters/types.ts for the request
 * construction, the edges, and why this is never a network self-fetch.
 *
 * Stages (decision 35/35a): lvc_value, lvc_value_critique, clinical_state_normalise (conditional)
 */
import { POST } from '@/app/api/appropriateness/route';
import { assessStream, eventTypes, makeRouteAdapter, type Adapter, type RouteAdapterDeps, type RouteRead } from './types';

export function makeAppropriatenessAdapter(deps: RouteAdapterDeps = {}): Adapter {
  return makeRouteAdapter({
    engine: 'appropriateness',
    path: '/api/appropriateness',
    post: POST,
    summarise: (read: RouteRead) => ({ event_types: eventTypes(read), events: read.events.length }),
    assess: assessStream,
  }, deps);
}
