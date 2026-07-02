---
sidebar_position: 3
---

# Coding Standards

## TypeScript Strict Mode

All source code **must** be written in TypeScript with `strict: true` enabled in `tsconfig.json`. This enables `strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`, and other strict family checks. Avoid using `any` — prefer `unknown` when the type is genuinely not known, and use type guards or assertions to narrow it.

## Naming Conventions

| Category | Convention | Example |
|---|---|---|
| Variables & functions | `camelCase` | `getUserById`, `isVisible` |
| Classes & types | `PascalCase` | `UserService`, `AuthPayload` |
| Interfaces | `PascalCase` (no `I` prefix) | `UserOptions`, `ApiResponse` |
| Enums | `PascalCase` (values in `PascalCase`) | `Color.Red`, `Status.Active` |
| Constants | `camelCase` or `UPPER_SNAKE_CASE` for magic values | `MAX_RETRY_COUNT`, `defaultTimeout` |
| Source files | `kebab-case` | `user-service.ts`, `auth-middleware.ts` |
| Test files | `kebab-case` with `.test` suffix | `user-service.test.ts` |

## No Default Exports

Always use named exports. Default exports make renaming inconsistent and hinder tree-shaking. Use `export function`, `export const`, or `export class` directly.

```ts
// ✅ Good
export function formatDate(date: Date): string { ... }

// ❌ Bad
export default function formatDate(date: Date): string { ... }
```

## Import Rules

All imports must use **ESM** syntax with explicit `.js` file extensions (even though the source files are `.ts` — the compiler resolves these to `.js` at build time).

```ts
// ✅ Good
import { UserService } from './user-service.js';
import { type AuthPayload } from './types.js';

// ❌ Bad
import { UserService } from './user-service';
import { UserService } from './user-service.ts';
```

Avoid wildcard imports (`import * as`) and deep relative imports that traverse many directories. Prefer project-relative imports via path aliases (e.g., `@/utils/...`).

## Error Handling

Use a `Result`-like pattern or throw explicitly typed errors. Never catch an error and ignore it silently. When throwing, prefer `Error` subclasses or typed error objects.

```ts
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
```

Always handle promise rejections — use `.catch()` or `try/catch` with `await`. No floating promises.

## Testing with Vitest

All business logic must be tested using **Vitest**. Test files live alongside source files with a `.test.ts` extension. Use `describe`/`it` blocks and prefer `expect` matchers from Vitest's built-in assertions. Mock external dependencies with `vi.mock()` and avoid mocking internals of the module under test.

```bash
npx vitest run          # Run all tests
npx vitest --watch      # Watch mode during development
```

## Linting with ESLint

Use ESLint with the TypeScript plugin and the strict type-checked ruleset. Run linting before every commit:

```bash
npx eslint src/ --ext .ts
```

All lint warnings must be resolved — do not disable rules inline without a documented justification comment (`// eslint-disable-next-line <rule> -- <reason>`).
