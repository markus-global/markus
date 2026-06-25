/**
 * Global test setup — isolates ALL tests from the real ~/.markus directory.
 *
 * Runs before each test file is loaded.  Sets process.env.HOME to a per-worker
 * temp directory so that os.homedir() never returns the real home, even for
 * code that captures homedir() at module scope.
 *
 * Tests that manage their own HOME (via mkdtempSync + process.env.HOME) are
 * unaffected — they overwrite and restore HOME themselves.  The important
 * thing is that if a test does NOT manage HOME, it still won't touch the real
 * ~/.markus directory.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const realHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), 'markus-test-home-'));
mkdirSync(join(testHome, '.markus', 'logs'), { recursive: true });

process.env.HOME = testHome;

process.on('exit', () => {
  process.env.HOME = realHome;
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});
