// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//  TEST-ONLY CONFIGURATION. These values exist so the test suites can sign and verify tokens. They are
//  NOT secrets, they are NOT a template for production configuration, and nothing under src/ may import
//  this file or contain these values (tests/testConfig.test.ts enforces both).
//
//  Production secrets come from the environment (see .env.example — JWT_SECRET is intentionally blank
//  there). Never copy a value from this file into a real .env, and never use one to sign real tokens.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Signs and verifies the JWTs minted inside the tests. Deliberately unmistakable as a placeholder. */
export const TEST_JWT_SECRET = 'TEST-ONLY-jwt-secret-not-a-real-secret-never-use-in-production';
