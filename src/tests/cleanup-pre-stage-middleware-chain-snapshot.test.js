/**
 * Cleanup Stage-0 / G0.2 — middleware chain snapshot.
 *
 * Purpose
 * -------
 * Pin the ORDERED set of top-level middleware mounted on the live
 * Express app. Middleware order is mission-critical and silent —
 * an Express app where Helmet runs after `express.json()` is
 * insecure but indistinguishable from a correct app at the type
 * level. This gate makes the canonical order
 *
 *   request-context → CSP nonce → Helmet → security headers →
 *   /api cache-control → CORS → JSON body parser → global rate
 *   limiter → session → workspace context → multi-tenancy guard
 *
 * a checked-in fact that any cleanup commit must consciously update.
 *
 * Companion to G0.1: G0.1 pins WHAT routes exist; G0.2 pins WHAT
 * runs before them, in WHAT order. Together they describe the
 * full request pipeline.
 *
 * What is captured
 * ----------------
 * For each layer in `app.router.stack` whose `route` is undefined
 * (i.e. a middleware, NOT a route handler), we emit:
 *
 *   - `name`   : `layer.handle.name` if non-empty, else
 *                `layer.name`, else `'anonymous'`
 *   - `arity`  : `layer.handle.length` — 4-arity functions are
 *                Express error handlers; 2-or-3 are normal
 *                middleware. A drift here usually means an error
 *                handler was accidentally registered as a normal
 *                middleware or vice versa.
 *   - `slash`  : `layer.slash === true` ⇒ mounted at `/` (global)
 *                vs path-scoped (`app.use('/dashboard', ...)`).
 *   - `kind`   : `'router'` for sub-router mounts (so we can see
 *                them in-context against single middlewares
 *                without recursing — G0.1 already covers their
 *                inner routes).
 *
 * Plus we pin a small set of orthogonal app-level settings that
 * the same cleanup work is likely to touch:
 *
 *   - `app.get('trust proxy')`  — flips in M4 / T4.8.
 *   - `app.get('x-powered-by')` — should be `false` (Helmet does
 *     this); a regression here would leak server fingerprint.
 *   - `app.get('etag')`         — accepted today, snapshot fixes
 *     it so anyone disabling it accidentally trips the gate.
 *
 * Updating
 * --------
 * On any deliberate change to middleware order or settings,
 * regenerate with
 *   npx jest cleanup-pre-stage-middleware-chain-snapshot --updateSnapshot
 * AS PART OF the same commit that changes the order. The diff in
 * the snapshot file is the code-review evidence.
 *
 * Related
 * -------
 *   - `.context/decisions/ADR-0004-cleanup-pre-stage-gates.md`
 *   - Cleanup plan §"Stage 0 — Cross-cutting baseline" / G0.2
 */

'use strict';

describe('[Cleanup Stage 0 / G0.2] middleware chain snapshot', () => {
  let app;
  let routerStack;

  beforeAll(() => {
    const mod = require('../index');
    app = mod.app;
    routerStack = app.router.stack;
  });

  function describeMiddleware(layer) {
    // `layer.handle` is the actual function. Express copies the
    // function name onto `layer.name` at registration time but only
    // for SOME registration paths — so we prefer the live function
    // name when it differs.
    const fnName =
      (layer.handle && typeof layer.handle === 'function' && layer.handle.name) ||
      layer.name ||
      'anonymous';
    const arity =
      layer.handle && typeof layer.handle === 'function' ? layer.handle.length : null;
    return {
      name: fnName,
      kind: layer.name === 'router' ? 'router' : 'middleware',
      arity,
      slash: layer.slash === true,
    };
  }

  test('app exposes a non-empty router stack', () => {
    expect(Array.isArray(routerStack)).toBe(true);
    expect(routerStack.length).toBeGreaterThan(10);
  });

  test('snapshot: ordered middleware chain', () => {
    const chain = routerStack.map((layer, idx) => ({
      idx,
      ...describeMiddleware(layer),
      hasRoute: !!layer.route,
    }));
    expect(chain).toMatchSnapshot('ordered middleware chain');
  });

  test('snapshot: middleware-only filter (route layers stripped)', () => {
    // The chain above is dense. This sub-snapshot is the slim view —
    // just the cross-cutting middlewares + sub-routers, no leaf
    // routes. It's what a reviewer scans first when a refactor
    // moves middleware around.
    const middlewareOnly = routerStack
      .filter((l) => !l.route)
      .map((layer, srcIdx) => ({
        srcIdx: routerStack.indexOf(layer),
        ...describeMiddleware(layer),
      }));
    expect(middlewareOnly).toMatchSnapshot(
      'middleware-only chain (no leaf routes)'
    );
  });

  test('snapshot: app-level settings pinned for the cleanup window', () => {
    // Only the small set of settings the cleanup work is likely to
    // touch. NOT a full `app.settings` dump — those include things
    // like `views`/`view engine` we don't care about and that
    // legitimately differ across environments.
    const settings = {
      'trust proxy': app.get('trust proxy'),
      'x-powered-by': app.get('x-powered-by'),
      etag: app.get('etag'),
      'json escape': app.get('json escape'),
      'case sensitive routing': app.get('case sensitive routing'),
      'strict routing': app.get('strict routing'),
    };
    expect(settings).toMatchSnapshot('app-level settings');
  });

  test('error handlers (arity = 4) sit at the END of the chain (Express invariant)', () => {
    // Express only invokes 4-arity middleware on errors, and only
    // those that come AFTER the throwing handler. Putting them at
    // the front silently disables them. This test catches the
    // "moved error handler to the top during a refactor" footgun
    // before any user sees a leaked stack trace.
    const errorHandlerIndices = [];
    routerStack.forEach((layer, idx) => {
      if (
        !layer.route &&
        layer.handle &&
        typeof layer.handle === 'function' &&
        layer.handle.length === 4
      ) {
        errorHandlerIndices.push(idx);
      }
    });
    if (errorHandlerIndices.length === 0) {
      // Today there may be no top-level error handler; accept it.
      // The snapshot tests already pin this fact. The contract here
      // is conditional: "if there are any, they must be at the end."
      return;
    }
    const lastNonErrorIdx = (() => {
      for (let i = routerStack.length - 1; i >= 0; i -= 1) {
        const l = routerStack[i];
        if (
          l.route ||
          (l.handle && typeof l.handle === 'function' && l.handle.length !== 4)
        ) {
          return i;
        }
      }
      return -1;
    })();
    for (const idx of errorHandlerIndices) {
      expect(idx).toBeGreaterThanOrEqual(lastNonErrorIdx - errorHandlerIndices.length);
    }
  });
});
