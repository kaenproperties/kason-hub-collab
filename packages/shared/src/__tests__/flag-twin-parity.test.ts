// Flag twin-parity guard (2026-08-06). Every Phase-2 flag lives twice per
// environment: the API value (deploy-workflow env block, read via process.env)
// and the web VITE_ twin (apps/web/.env.*, baked into the bundle at build).
// Nothing else keeps the halves in agreement, and the failure mode of a
// web-ON/API-OFF split is the worst kind: the UI behaves as if the feature
// works while the server silently skips it. That exact split (introduced by the
// 2026-08-04 "mirror LOCAL" UAT commit) made bills-grid expenses silently never
// reach the invoice AND suppressed the drawer's warning banner built to
// announce that state.
//
// Rules enforced on the UAT pair (cd-uat-deploy.yml ⇄ apps/web/.env.uat):
//   1. every registry flag is listed EXPLICITLY in the workflow env block
//      (absent-means-off is how the drift went unnoticed);
//   2. every registry flag has an explicit VITE_ twin in .env.uat;
//   3. a VITE twin may be "true" only when the API value is "true".
//      (API-ON/web-OFF stays legal — cron/backend flags have no web surface.)
//
// The PROD pair (cd-prod-deploy.yml ⇄ apps/web/.env.production) gets rule 3
// only, and only once the prod workflow actually defines an ENABLE_ block —
// the prod flag rollout is a client decision that hasn't been made yet.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE2_FLAGS } from "../constants/phase2-flags";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const hasUatDeploymentConfig = existsSync(resolve(repoRoot, ".github/workflows/cd-uat-deploy.yml"));

/** `ENABLE_X: "true"|"false"` lines from a deploy-workflow container env block. */
function workflowFlags(relPath: string): Map<string, boolean> | null {
  const p = resolve(repoRoot, relPath);
  if (!existsSync(p)) return null;
  const map = new Map<string, boolean>();
  for (const m of readFileSync(p, "utf8").matchAll(/^\s*(ENABLE_[A-Z0-9_]+):\s*"(true|false)"/gm)) {
    map.set(m[1]!, m[2] === "true");
  }
  return map;
}

/** `VITE_ENABLE_X=true|false` lines from a web env file (comments ignored). */
function viteFlags(relPath: string): Map<string, boolean> | null {
  const p = resolve(repoRoot, relPath);
  if (!existsSync(p)) return null;
  const map = new Map<string, boolean>();
  for (const m of readFileSync(p, "utf8").matchAll(/^VITE_(ENABLE_[A-Z0-9_]+)=(true|false)\s*$/gm)) {
    map.set(m[1]!, m[2] === "true");
  }
  return map;
}

(hasUatDeploymentConfig ? describe : describe.skip)("UAT flag twins (cd-uat-deploy.yml ⇄ apps/web/.env.uat)", () => {
  const api = workflowFlags(".github/workflows/cd-uat-deploy.yml");
  const web = viteFlags("apps/web/.env.uat");

  it("both halves exist and define flags", () => {
    expect(api, "cd-uat-deploy.yml missing or has no ENABLE_ env block").not.toBeNull();
    expect(api!.size).toBeGreaterThan(0);
    expect(web, "apps/web/.env.uat missing or has no VITE_ENABLE_ lines").not.toBeNull();
    expect(web!.size).toBeGreaterThan(0);
  });

  it("every registry flag is explicit in the API workflow block (no silent absent-off)", () => {
    const missing = PHASE2_FLAGS.filter((f) => !api!.has(f));
    expect(missing, `add these to the cd-uat-deploy.yml env block, "true" or "false"`).toEqual([]);
  });

  it("every registry flag has an explicit VITE_ twin in .env.uat", () => {
    const missing = PHASE2_FLAGS.filter((f) => !web!.has(f));
    expect(missing, `add VITE_<flag>=true|false lines to apps/web/.env.uat`).toEqual([]);
  });

  it("no web-ON/API-OFF split-brain (UI would fake a feature the server skips)", () => {
    const split = PHASE2_FLAGS.filter((f) => web!.get(f) === true && api!.get(f) !== true);
    expect(
      split,
      `these VITE twins are ON while the API flag is OFF — set the workflow value to "true" or turn the twin off`,
    ).toEqual([]);
  });
});

describe("PROD flag twins (cd-prod-deploy.yml ⇄ apps/web/.env.production)", () => {
  const api = workflowFlags(".github/workflows/cd-prod-deploy.yml");
  const web = viteFlags("apps/web/.env.production");

  it("no web-ON/API-OFF split-brain once prod defines its flag block", () => {
    // Prod's flag rollout is undecided: its workflow carries no ENABLE_ block yet, and
    // asserting against an empty block would fail on a decision nobody has made. The
    // moment prod flags are added, this rule arms itself.
    if (!api || api.size === 0 || !web) return;
    const split = PHASE2_FLAGS.filter((f) => web.get(f) === true && api.get(f) !== true);
    expect(
      split,
      `these prod VITE twins are ON while the prod API flag is OFF — align them before deploying`,
    ).toEqual([]);
  });
});
