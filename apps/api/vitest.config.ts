import { defineConfig } from "vitest/config";
import path from "path";

// Integration tests (opt-in via RUN_INTEGRATION=1) need the REAL @kason/db client
// so they can race against Postgres. Unit tests use the mock to avoid Prisma init.
const RUN_INTEGRATION = process.env.RUN_INTEGRATION === "1";

const alias: Record<string, string> = {
  "@kason/shared/owner-remittance": path.resolve(__dirname, "../../packages/shared/src/finance/owner-remittance.ts"),
  "@kason/shared": path.resolve(__dirname, "../../packages/shared/src"),
};
if (!RUN_INTEGRATION) {
  alias["@kason/db"] = path.resolve(__dirname, "src/__mocks__/@kason/db.ts");
}

// Integration suites must NOT run against the dev database. Nine bills-grid suites adopt
// whatever `organization.findFirstOrThrow()` returns and then tear down against it — on
// 2026-07-28 that deleted a real unit's grid entry, its 4 expenses, its bearer config and
// the org's seeded categories/series, and billed the unit for real. Teardown is scoped now,
// but the durable fix is that the tests never point at the dev DB in the first place.
//
// TEST_DATABASE_URL (see .env) redirects DATABASE_URL for integration runs only. Unset it
// and you get the old behaviour with a loud warning rather than a silent one — some
// environments (CI containers) legitimately point DATABASE_URL at a throwaway DB already.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (RUN_INTEGRATION && !TEST_DATABASE_URL) {
  console.warn(
    "\n⚠  RUN_INTEGRATION=1 without TEST_DATABASE_URL — integration tests will use DATABASE_URL\n" +
    `   (${process.env.DATABASE_URL ?? "unset"}).\n` +
    "   If that is your dev database, suites that adopt a real org can destroy data in it.\n" +
    "   Set TEST_DATABASE_URL in .env and seed it: npx tsx scripts/seed-test-db.ts\n",
  );
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      SESSION_SECRET: "test-session-secret-vitest-only",
      NODE_ENV: "test",
      // Only for integration runs — unit tests use the @kason/db mock and never connect.
      ...(RUN_INTEGRATION && TEST_DATABASE_URL ? { DATABASE_URL: TEST_DATABASE_URL } : {}),
    },
    // Integration suites all hit ONE shared Postgres and many reuse the same
    // fixed-UUID fixtures (e.g. several owner-ledger files share the same ORG /
    // ACTOR_USER). Running test FILES in parallel lets one file's afterAll/
    // beforeEach teardown delete rows another file is mid-flight using → FK
    // violations / count drift. Force serial file execution for integration
    // runs only; unit-test parallelism (the default) is left untouched.
    ...(RUN_INTEGRATION ? { fileParallelism: false } : {}),
  },
  resolve: {
    alias,
  },
});
