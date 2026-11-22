/**
 * Unit tests check the product's own defaults. The CI job sets the end-to-end environment for every one of its
 * steps, the unit step included, and that environment switches rules off (private hosts allowed, no pause, test
 * knobs on, PMOS AI off). Left in place it turns a rule under test off and the test goes red on CI only
 * (development was red for it on 2026-11-15 and again on 2026-11-22). So it is removed here, once, for every unit
 * test file; a test that needs one of these sets it itself.
 */
for (const name of ["COMPETITORS_ALLOW_PRIVATE_HOSTS", "COMPETITORS_PAUSE_MS", "COMPETITORS_CEILING_MS", "COMPETITORS_CONFIG", "COMPETITORS_TEST_KNOBS", "COMPETITORS_AI"]) delete process.env[name];
