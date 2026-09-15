# Markus workflow examples

These examples are small, runnable workflows built on Markus packages. Run the
commands from the repository root after installing and building the workspace:

```bash
pnpm install
pnpm build
```

## Release notes from git history

`release-notes-workflow.ts` reads commits from the current repository, assigns
drafting and review tasks to two specialized local agents, and writes the file
only after the review passes. The local executor makes the example deterministic
and usable without an LLM API key; a production `WorkflowExecutor` can route the
same steps to managed Markus agents.

Generate notes since the latest reachable tag:

```bash
pnpm example:release-notes
```

Choose an explicit range and output file:

```bash
pnpm example:release-notes -- --from v0.9.0 --to HEAD --output release-notes.md
```

The start ref is exclusive and the end ref is inclusive. The command refuses to
overwrite an existing file unless `--force` is supplied. Use
`pnpm example:release-notes -- --help` for all options.

## GUI automation

`gui-automation-workflow.ts` demonstrates screen inspection and desktop input.
It requires the GUI automation environment described in the source file.

```bash
pnpm example:gui
```
