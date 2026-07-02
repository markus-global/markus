---
sidebar_position: 5
---

# Pull Requests

## PR Title Format

Use the Conventional Commits format: `<type>(<scope>): <short summary>`

- **Types**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, `perf`
- **Scope** (optional): the affected module, e.g. `cli`, `core`, `sdk/python`
- **Summary**: imperative, lowercase, no trailing period

**Examples**: `feat(cli): add dry-run flag`, `fix(sdk): handle null metadata gracefully`

---

## PR Body Template

```markdown
## Description
<!-- What does this PR do? Why is it needed? -->

## Related Issue
<!-- Link to the issue this resolves, e.g. Fixes #123 -->

## Type of Change
<!-- Mark with an x: [x] -->
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update
- [ ] Refactor / Chore

## Testing
<!-- How was this tested? What tests did you run? -->

## Screenshots / Logs
<!-- If applicable, add screenshots or relevant log output -->
```

---

## Review Process

1. **Self-review** first — check your diff before requesting review.
2. **Automated checks** must pass (CI, lint, tests).
3. At least **one maintainer approval** is required before merging.
4. Address all review comments; re-request review once resolved.
5. Squash-merge is preferred to keep history clean.

---

## Branch Naming

Use a consistent prefix pattern:

```
<type>/<short-description>
```

Examples: `feat/dry-run-flag`, `fix/null-metadata-handling`, `docs/api-overview`, `chore/upgrade-deps`

Avoid long or generic branch names like `fix-bug` or `my-changes`.

---

## Pre-Submit Checklist

Before merging, ensure:

- [ ] Code compiles and lint passes (`pnpm lint`)
- [ ] All existing tests pass (`pnpm test`)
- [ ] New tests are added for new functionality
- [ ] Documentation is updated (if applicable)
- [ ] Changes are backward-compatible (or a breaking change is documented)
- [ ] PR title and body follow the templates above
