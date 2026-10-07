/**
 * Re-export shim for the literal-replacement helpers.
 *
 * The single implementation lives in `@markus/shared`
 * (`packages/shared/src/utils/literal-replace.ts`) because workflow templates —
 * which are rendered inside the shared package — need the same "never interpret
 * `$`-sequences" guarantee, and the dependency direction is core → shared, so
 * shared cannot import core.
 *
 * This file is kept so tool code (`file.ts`, `patch.ts`) and existing tests keep
 * a stable `./literal-replace.js` import path. See the shared module header for
 * the full rationale and the hard rule.
 */
export { replaceLiteral, replaceAllLiteral } from '@markus/shared';
