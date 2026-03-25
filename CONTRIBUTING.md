# Contributing to Markus

Thank you for your interest in contributing to Markus! This guide helps AI coding assistants and human developers contribute effectively to the AI Agent team platform.

## 🤝 How to Contribute

### Ways to Contribute

- 🐛 **Report bugs** — Help us identify issues
- 💡 **Suggest features** — Share your ideas for making Markus better
- 📝 **Improve documentation** — Help others get started
- 💻 **Write code** — Fix bugs or implement new features
- 🎨 **Design** — Improve UI/UX or create visual assets
- 📢 **Spread the word** — Star the repo, write about Markus

## 🚀 Quick Development Setup

```bash
# Clone and install
git clone https://github.com/markus-global/markus.git
cd markus
pnpm install
pnpm build

# Start development servers
pnpm dev
```

**Services:**
- Web UI: http://localhost:8057
- API: http://localhost:8056
- Default admin: `admin@markus.local` / `markus123`

**Databases:** SQLite by default (zero config). PostgreSQL is optional for production.

## 📋 Good First Issues

New to the project? Start with these labels:

| Label | Description |
|-------|-------------|
| [good first issue](https://github.com/markus-global/markus/labels/good%20first%20issue) | Beginner-friendly tasks |
| [help wanted](https://github.com/markus-global/markus/labels/help%20wanted) | Features we need help with |
| [documentation](https://github.com/markus-global/markus/labels/documentation) | Improve docs and guides |
| [bug](https://github.com/markus-global/markus/labels/bug) | Fix reported issues |

## 🏗️ Project Structure

```
packages/
├── shared/       Shared types, constants, utilities
├── core/         Agent runtime engine — autonomous behavior
├── storage/      Database schema + repository layer
├── org-manager/  Organization management + REST API + governance
├── web-ui/       React + Vite + Tailwind management interface
├── cli/          CLI entry point + service assembly
├── a2a/          Agent-to-Agent communication protocol
├── comms/        External integrations (Feishu, Slack, WhatsApp)
├── gui/          GUI automation (VNC + OmniParser)
└── shared/       Shared types and utilities
```

## ⌨️ Development Commands

| Command | Purpose |
|---------|---------|
| `pnpm install` | Install all dependencies |
| `pnpm build` | Build all packages |
| `pnpm dev` | Start API + Web UI |
| `pnpm test` | Run all tests (Vitest) |
| `pnpm test --filter @markus/<pkg>` | Run tests for specific package |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm lint` | ESLint code quality |

## 📐 Code Standards

### TypeScript
- All packages use `strict: true`
- ESM modules only (`import`/`export`)
- No default exports — use named exports
- Use `import type { X }` for type-only imports
- Prefix unused variables with `_` (e.g., `_unused`)

### Commits
We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scope): add user authentication
fix(api): handle null response in /api/agents
docs(readme): update installation instructions
chore(deps): upgrade to Node.js 22
refactor(core): simplify task delegation logic
test(agent): add unit tests for role assignment
```

## 🔧 Adding New Features

### New Agent Role

1. Create directory: `templates/roles/<role-name>/`
2. Add `ROLE.md` with role definition
3. Optionally add `HEARTBEAT.md`, `POLICIES.md`
4. Reference `templates/roles/SHARED.md` for shared content

### New Skill

1. Create directory: `templates/skills/<skill-name>/`
2. Add `manifest.json`:
   ```json
   {
     "name": "my-skill",
     "version": "1.0.0",
     "description": "What this skill does",
     "requiredPermissions": [],
     "requiredEnv": []
   }
   ```
3. Add `SKILL.md` with usage instructions

### New API Endpoint

1. Open `packages/org-manager/src/api-server.ts`
2. Add route in `route()` method:
   ```typescript
   if (path === '/api/your-resource' && req.method === 'GET') {
     // Handle request
   }
   ```
3. Use `this.readBody(req)` for request body
4. Use `this.json(res, statusCode, payload)` for response
5. Add `await this.requireAuth(req, res)` for protected endpoints

## 🧪 Testing

- **Framework**: Vitest
- **Location**: `packages/<pkg>/test/*.test.ts`
- **Run**: `pnpm test` or `pnpm --filter @markus/<pkg> test`
- Write tests for new features
- Keep tests focused and deterministic
- Avoid external dependencies in unit tests

## 🔀 Pull Request Process

1. **Fork** the repository
2. **Create branch**: `git checkout -b feat/your-feature`
3. **Make changes** with tests
4. **Verify**: Run `pnpm typecheck && pnpm lint && pnpm test`
5. **Commit** using Conventional Commits
6. **Open PR** with:
   - Clear description of changes
   - Link to related issues
   - Screenshots for UI changes
7. **Address review** feedback
8. **Merge** after approval

## 🔍 Code Review Expectations

- Changes align with project structure
- New code has tests where appropriate
- No unnecessary dependencies
- TypeScript types are correct (avoid `any`)
- API changes are backward-compatible or documented
- No security vulnerabilities

## 📊 Developer Roadmap

### Beginner Tasks
- [ ] Improve documentation and examples
- [ ] Add unit tests for untested modules
- [ ] Fix typos and grammar issues
- [ ] Add inline comments to complex code

### Intermediate Tasks
- [ ] Implement new API endpoints
- [ ] Create new agent roles
- [ ] Add new communication adapters
- [ ] Improve error handling

### Advanced Tasks
- [ ] Design new system features
- [ ] Optimize performance bottlenecks
- [ ] Implement security features
- [ ] Architecture refactoring

## 📚 Resources

- [Architecture Docs](docs/ARCHITECTURE.md)
- [API Reference](docs/API.md)
- [User Guide](docs/GUIDE.md)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

## 📄 License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE).

---

<p align="center">
  <strong>Questions?</strong> Open an issue or start a discussion.<br>
  We welcome all contributions, big or small! 🎉
</p>
