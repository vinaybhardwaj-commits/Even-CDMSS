/**
 * lib/lab-v2/adapters/doc-audit.ts — the `doc_audit` engine behind the fence (§17.3, decision 37).
 *
 * The route file is UNTOUCHED. `POST` is imported and called in process with a synthetic
 * NextRequest inside `withLabExecution`; see lib/lab-v2/adapters/types.ts for the request
 * construction, the edges, and why this is never a network self-fetch.
 *
 * Stages (decision 35/35a): doc_audit_analyze, doc_audit_cite_gate, doc_audit_prognosis, doc_audit_prognosis_critique, doc_audit_prognosis_revise
 */
import { POST } from '@/app/api/doc-audit/analyze/route';
import { assessStream, eventTypes, makeRouteAdapter, type Adapter, type RouteAdapterDeps, type RouteRead } from './types';

export function makeDocAuditAdapter(deps: RouteAdapterDeps = {}): Adapter {
  return makeRouteAdapter({
    engine: 'doc_audit',
    path: '/api/doc-audit/analyze',
    post: POST,
    summarise: (read: RouteRead) => ({ event_types: eventTypes(read), events: read.events.length }),
    assess: assessStream,
  }, deps);
}
