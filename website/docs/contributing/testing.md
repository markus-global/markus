---
sidebar_position: 4
---

# Testing Guide

Testing is a first-class citizen in Markus. We use **Vitest** as our test runner for its speed, native TypeScript support, and seamless Vite integration.

## Running Tests

| Command | Description |
|---------|-------------|
| `pnpm test` | Run all tests once |
| `pnpm test:watch` | Run tests in watch mode (ideal during development) |
| `pnpm test:coverage` | Run tests with coverage reporting |

By default, tests are executed across all workspace packages. You can scope to a specific package by appending `--filter <package-name>`.

## Test File Conventions

- All test files follow the naming pattern `*.test.ts`.
- Place test files alongside the module they test (co-located) inside a `__tests__/` directory, e.g. `src/utils/__tests__/format.test.ts`.
- Vitest configuration is defined in `vitest.workspace.ts` at the project root.

## Mocking Patterns

- Use `vi.fn()` to create lightweight spies and stubs for individual functions.
- For mocking external modules (e.g. network clients, file system), use `vi.mock()` at the top of your test file. The factory function receives the module and returns a substitute.
- Prefer **dependency injection** over global mocks where feasible — pass mocked dependencies as function arguments or constructor parameters. This keeps tests predictable and avoids brittle mock setups.
- Reset mocks between tests with `vi.clearAllMocks()` or `vi.restoreAllMocks()` in `beforeEach` blocks.

## Coverage Requirements

We aim for **at least 80% statement, branch, function, and line coverage** on all production code. Critical paths (auth, data persistence, external integrations) require 90%+ branch coverage. Coverage reports are generated under the `coverage/` directory and can be viewed in CI pipelines.

When adding new features, always include corresponding tests. Pull requests that significantly reduce coverage will be flagged during review.
