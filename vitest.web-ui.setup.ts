/**
 * Setup for the `web-ui` vitest project (environment: happy-dom).
 *
 * Reuses the base isolation (temp HOME + stripped `MARKUS_*` credentials) so
 * the two projects cannot drift, then adds the DOM-specific bits.
 *
 * Why a separate project instead of a global `environment: 'happy-dom'`:
 * the node packages (core / org-manager / storage / cli …) assert on Node
 * primitives — real SQLite handles, real worker threads, `process.exit` spies.
 * Giving them a DOM would mask genuine environment misuse and slow the suite
 * down (happy-dom boots a `window` per file).  Keeping `node` as the default
 * and opting web-ui in explicitly is the conservative direction: a DOM test
 * that forgets its pragma fails loudly, whereas a node test silently handed a
 * `window` can pass for the wrong reason.
 */
import './vitest.setup.ts';

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(() => {
  cleanup();
});
