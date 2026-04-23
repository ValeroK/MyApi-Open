# Roadmap

> Milestone-level sequence. Task-level detail lives in [`TASKS.md`](TASKS.md).
> Architecture rationale lives in [`plan.md`](plan.md). Ratified decisions live
> in `decisions/ADR-*.md`.
>
> Targets are **working targets**, not commitments. Updates here should be
> reflected in `current_state.md` §6.

## Phases

```
Phase A — Stop the bleeding (M0–M5)            ← critical security + foundations
Phase B — Break up the monolith (M6–M8)        ← structural refactor + TS + cleanup
Phase C — Polish + guardrails (M9–M13)         ← output hygiene, DB integrity,
                                                observability, tests, supply chain
Phase D — Documentation (M14)                  ← runbooks, consolidated docs
```

## Milestones at a glance

| # | Milestone | Phase | Target | Depends on | Plan ref |
|---|-----------|-------|--------|------------|----------|
| M0 | Project foundation | A | Week 1 | — | WS-0 |
| M1 | Delete dangerous endpoints + hardcoded secrets | A | Week 1 | M0 | WS-1 |
| M2 | Consolidate crypto + one-shot vault migration | A | Week 2 | M0, M1 | WS-1, WS-2 |
| M3 | OAuth state + PKCE + callback hardening | A | Week 2 | M0, M2 | WS-3 |
| M4 | Session + rate-limit dual-driver store | A | Week 2 | M0, M2 | WS-3 |
| M5 | SSRF surface unification via SafeHTTPClient | A | Week 3 | M0 | WS-1, WS-2 |
| M6 | Monolith extraction (split `src/index.js`) | B | Week 3–4 | M0, M1, M3, M4 | WS-2 |
| M7 | TypeScript migration for domain + infra | B | Week 4–5 | M0, M2, M4, M5, M6 | WS-2 |
| M8 | Remove MongoDB, legacy modules, dead code | B | Week 5 | M2, M6, M7 | WS-2 |
| M9 | Frontend & output hygiene | C | Week 5 | M6 | WS-4 |
| M10 | Database integrity & audit log | C | Week 6 | M6, M8 | WS-5 |
| M11 | Observability (Pino, metrics, traces) | C | Week 6 | M6 | WS-7 |
| M12 | Testing uplift | C | Weeks 2–6 (rolling) | M1..M6 | WS-6 |
| M13 | CI/CD & supply chain | C | Week 2 onwards | M0 | WS-8 |
| M14 | Documentation & runbooks | D | Week 7 | M2, M6, M10, M11 | WS-9 |

## Critical path

```
M0 ──▶ M1 ──▶ M2 ──▶ M3 ──┐
                ├──▶ M4 ──┤
                          ├──▶ M6 ──▶ M7 ──▶ M8
                M5 ───────┘                  │
                                             ├──▶ M9, M10, M11 ─▶ M14
                                             │
M12 runs rolling alongside M1..M6; M13 starts with M0.
```

## Phase-exit criteria

**Phase A (done when):**
- No Turso endpoints; no hardcoded OAuth fallbacks; no `crypto-js`.
- Vault re-encrypted under AES-256-GCM, single crypto module.
- OAuth state DB-validated + single-use + PKCE random.
- Session + rate-limit store have SQLite and Redis drivers, both tested.
- Zero outbound HTTP outside `SafeHTTPClient`.

**Phase B (done when):**
- `src/index.js` ≤ 600 lines.
- `src/domain/**`, `src/infra/{crypto,http,session}/**` are `.ts`, strict.
- `mongodb` + `crypto-js` removed from `package.json`.

**Phase C (done when):**
- CSP drops `'unsafe-inline'` for styles; central error envelope; CSRF on admin.
- Audit log append-only via SQL triggers; Merkle root published.
- Pino logs with redaction + `/metrics` + OTel traces.
- Tiered coverage thresholds met: 80% domain/crypto/http/session; 70% app; 50% legacy.
- `npm audit` blocks at HIGH+; gitleaks, Trivy, SBOM in CI.

**Phase D (done when):**
- `CLAUDE.md`, `README.md`, `SECURITY.md` accurate.
- `docs/runbooks/` covers incident response, key rotation, DB restore, Stripe
  replay, OAuth provider outage, device revocation, backup verification.

## Not on the roadmap (yet)

- Full Kubernetes deployment (AD-7 says Docker Compose is the default).
- Multi-region / active-active.
- BullMQ workers (comes in automatically when `REDIS_URL` is set; AD-4).
- Cosign signed images + SLSA provenance (queued in M13 with low priority;
  ship with managed cloud launch).
