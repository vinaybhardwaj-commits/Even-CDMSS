# Tech debt — Even-CDMSS

Things that are wrong, known, and deliberately not being fixed by whoever wrote them down.
An entry here is a decision, not a TODO: it names the defect, the blast radius, why it was
left, and what fixing it would take. Add to it when you find something outside your slice.

---

## 1 · `/care/*` pages return HTTP 200 with a not-found BODY

**Found:** 27 Aug 2026, during the Pre-op Risk Slice-1 go-live check.
**Status:** pre-existing, app-wide, deliberately NOT fixed by B8 — it is outside that module.

When a `/care/*` page is gated off (its flag unset, or the path does not resolve), the server
returns **HTTP 200** with the Next.js not-found page as the body, rather than a 404 status.
`redirect('/care/login')` behaves the same way: 200, with the redirect carried in the RSC
payload rather than as a 3xx.

Measured on production (`cat.evenos.app`), all four returning 200 + not-found body:

| Route | |
|---|---|
| `/care/preop` | with `PREOP_SURFACE_ENABLED` unset |
| `/care/patterns` | |
| `/care/concepts` | |
| `/care/triage` | |

`/care/readmissions` behaves identically with its flag ON and no cookie, which is how the
pre-op page was confirmed to be behaving like its siblings rather than uniquely broken.

**Blast radius.** Small but real, and it is a *verification* hazard rather than a user-facing
one: a human sees the correct page either way, but any gate written as "the route still 404s"
passes or fails on the wrong signal. It also means an uptime checker or a crawler reads a
gated clinical surface as healthy and indexable. The **API** routes under `/api/care/*` are
unaffected — they return real 404s and 401s, verified.

**Why it was left.** It is a property of the app's routing/rendering configuration, shared by
every `/care` surface and by surfaces owned by three different slices. Changing it inside a
module kickoff would be a cross-cutting behaviour change shipped without an owner or a test
plan for the surfaces it touches.

**What fixing it takes.** Find why `notFound()` is not propagating its status — most likely a
`not-found` boundary or a `force-dynamic` interaction — reproduce it locally on one route,
then fix it once for all of `/care` with an assertion per surface. Half a day, and it needs
somebody who owns `/care` rather than one module inside it.

**Until then:** verify a gated PAGE by its BODY, and a gated ROUTE by its status.

---

## 2 · The `/care` surfaces have no per-user identity

**Found:** 27 Aug 2026, building B8b's confirm/dismiss rail.
**Status:** flagged for V; blocks nothing today, weakens something tomorrow.

`/care` is unlocked by a shared cookie (`cat_care` matching `CARE_TOKEN`), not by a per-user
login. So when a clinician confirms a model suggestion on the pre-op case page, the best
`decided_by` the module can honestly record is the ROLE — `care-manager` or `admin` — and it
records exactly that rather than inventing a name.

**Why it matters, specifically.** B8d promotes a field class to auto-scoring on the precision
of the decisions in `preop_suggestion_decisions`. With role-level attribution, that precision
is a property of "whoever was at the desk", and a disagreement between two clinicians is
invisible in it. The gate still works; it is measuring something blurrier than it should.

**What fixing it takes.** Real per-user auth on `/care`. That is a product decision, not a
module one.
