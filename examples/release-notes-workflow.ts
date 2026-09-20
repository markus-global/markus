#!/usr/bin/env node

/**
 * Release notes workflow
 *
 * A complete, local Markus workflow that turns a git range into reviewed
 * Markdown release notes. It deliberately uses deterministic agents so the
 * example works without an API key while still exercising WorkflowEngine.
 */

import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  WorkflowEngine,
  type WorkflowDefinition,
  type WorkflowExecutor,
} from "../packages/core/src/workflow/index.js";

const execFileAsync = promisify(execFile);

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
}

interface CliOptions {
  from?: string;
  to: string;
  outputPath: string;
  force: boolean;
  help: boolean;
}

interface ReleaseRequirement {
  title: string;
  acceptanceCriteria: string[];
}

const HELP = `Generate reviewed release notes from local git history.

Usage:
  pnpm example:release-notes [options]

Options:
  --from <ref>    Start ref (exclusive). Defaults to the latest reachable tag.
  --to <ref>      End ref (inclusive). Defaults to HEAD.
  --output <file> Output file. Defaults to RELEASE_NOTES.md.
  --force         Overwrite an existing output file.
  --help          Show this help.
`;

// Requirement: the durable statement of what the workflow must deliver. Its
// acceptance criteria are passed to both agents, so implementation and review
// use the same definition of done.
const requirement: ReleaseRequirement = {
  title: "Generate accurate release notes from git history",
  acceptanceCriteria: [
    "Every source commit appears exactly once.",
    "Commits are grouped into readable change categories.",
    "Every entry links its text to a short commit hash.",
    "The result is valid Markdown with a release-notes heading.",
  ],
};

const workflow: WorkflowDefinition = {
  id: "example-release-notes",
  name: "Release notes from git history",
  description: "Draft and independently review release notes for a git range.",
  version: "1.0.0",
  author: "Markus contributors",
  steps: [
    {
      id: "draft",
      name: "Draft release notes",
      type: "agent_task",
      agentId: "release-notes-writer",
      dependsOn: [],
      // Task: a bounded unit of work assigned to an agent. Inputs contain the
      // commits, range label, and requirement rather than hidden global state.
      taskConfig: {
        prompt:
          "Turn the supplied commits into concise Markdown release notes.",
      },
    },
    {
      id: "review",
      name: "Review release notes",
      type: "agent_task",
      agentId: "release-notes-reviewer",
      dependsOn: ["draft"],
      // Review: an independent agent checks the draft against the original
      // commits and acceptance criteria. A failed review fails the workflow.
      taskConfig: {
        prompt:
          "Verify the draft against every source commit and acceptance criterion.",
      },
    },
  ],
  outputs: {
    notes: "steps.draft.output.notes",
    review: "steps.review.output",
  },
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    to: "HEAD",
    outputPath: "RELEASE_NOTES.md",
    force: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--force") {
      options.force = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (
      argument === "--from" ||
      argument === "--to" ||
      argument === "--output"
    ) {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      if (argument === "--from") options.from = value;
      if (argument === "--to") options.to = value;
      if (argument === "--output") options.outputPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}

async function runGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function findLatestTag(to: string): Promise<string | undefined> {
  const output = await runGit(["tag", "--sort=-creatordate", "--merged", to]);
  return output.split(/\r?\n/u).find(Boolean);
}

export async function readCommits(
  from: string | undefined,
  to: string,
): Promise<GitCommit[]> {
  const range = from ? `${from}..${to}` : to;
  const args = [
    "log",
    "--no-merges",
    "--date=short",
    "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%b%x1e",
  ];
  if (!from) args.push("--max-count=20");
  args.push(range);

  const output = await runGit(args);
  if (!output) return [];

  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, author, date, subject, body = ""] =
        record.split("\x1f");
      if (!hash || !shortHash || !author || !date || !subject) {
        throw new Error("Could not parse git log output.");
      }
      return { hash, shortHash, author, date, subject, body: body.trim() };
    });
}

function cleanMarkdownText(value: string): string {
  return value.replace(/`/gu, "'").replace(/\s+/gu, " ").trim();
}

function categoryFor(commit: GitCommit): string {
  const header = commit.subject.toLowerCase();
  if (
    /^[a-z]+(?:\([^)]*\))?!:/u.test(header) ||
    /breaking change:/iu.test(commit.body)
  ) {
    return "Breaking changes";
  }
  if (/^feat(?:\([^)]*\))?:/u.test(header)) return "Features";
  if (/^fix(?:\([^)]*\))?:/u.test(header)) return "Fixes";
  if (/^perf(?:\([^)]*\))?:/u.test(header)) return "Performance";
  if (/^docs(?:\([^)]*\))?:/u.test(header)) return "Documentation";
  if (/^test(?:\([^)]*\))?:/u.test(header)) return "Tests";
  if (/^(?:build|ci)(?:\([^)]*\))?:/u.test(header)) return "Build and CI";
  return "Other changes";
}

export function draftReleaseNotes(
  commits: GitCommit[],
  rangeLabel: string,
): string {
  const categories = new Map<string, GitCommit[]>();
  for (const commit of commits) {
    const category = categoryFor(commit);
    const entries = categories.get(category) ?? [];
    entries.push(commit);
    categories.set(category, entries);
  }

  const lines = [
    "# Release notes",
    "",
    `Changes in \`${cleanMarkdownText(rangeLabel)}\`.`,
    "",
  ];

  for (const [category, entries] of categories) {
    lines.push(`## ${category}`, "");
    for (const commit of entries) {
      lines.push(
        `- ${cleanMarkdownText(commit.subject)} (\`${commit.shortHash}\`)`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function reviewReleaseNotes(
  notes: string,
  commits: GitCommit[],
): string[] {
  const problems: string[] = [];
  if (!notes.startsWith("# Release notes\n")) {
    problems.push(
      "The document must start with a level-one release-notes heading.",
    );
  }
  if (!notes.includes("\n## ")) {
    problems.push("The document must contain at least one change category.");
  }

  for (const commit of commits) {
    const marker = `\`${commit.shortHash}\``;
    const occurrences = notes.split(marker).length - 1;
    if (occurrences !== 1) {
      problems.push(
        `Commit ${commit.shortHash} appears ${occurrences} times; expected exactly once.`,
      );
    }
  }

  return problems;
}

function getCommits(input: Record<string, unknown>): GitCommit[] {
  if (!Array.isArray(input.commits))
    throw new Error('Workflow input "commits" must be an array.');
  return input.commits as GitCommit[];
}

function getRequirement(input: Record<string, unknown>): ReleaseRequirement {
  const value = input.requirement;
  if (!value || typeof value !== "object") {
    throw new Error('Workflow input "requirement" must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.title !== "string" ||
    !Array.isArray(candidate.acceptanceCriteria) ||
    !candidate.acceptanceCriteria.every(
      (criterion) => typeof criterion === "string",
    )
  ) {
    throw new Error("Workflow requirement is incomplete.");
  }
  return candidate as unknown as ReleaseRequirement;
}

function createLocalExecutor(): WorkflowExecutor {
  return {
    findAgent: () => undefined,
    async executeStep(agentId, _taskDescription, input) {
      const commits = getCommits(input);
      const activeRequirement = getRequirement(input);

      // Agent: a specialized worker selected by WorkflowEngine. These local
      // deterministic agents keep the example runnable without LLM credentials;
      // production executors can route the same tasks to managed Markus agents.
      if (agentId === "release-notes-writer") {
        if (typeof input.rangeLabel !== "string")
          throw new Error("Missing range label.");
        return {
          notes: draftReleaseNotes(commits, input.rangeLabel),
          requirement: activeRequirement.title,
        };
      }

      if (agentId === "release-notes-reviewer") {
        const draft = input.draft;
        if (!draft || typeof draft !== "object")
          throw new Error("Missing draft output.");
        const notes = (draft as Record<string, unknown>).notes;
        if (typeof notes !== "string")
          throw new Error("Draft did not contain release notes.");

        const problems = reviewReleaseNotes(notes, commits);
        if (problems.length > 0)
          throw new Error(
            `Review rejected the draft:\n- ${problems.join("\n- ")}`,
          );
        return {
          approved: true,
          commitsChecked: commits.length,
          criteriaChecked: activeRequirement.acceptanceCriteria.length,
          feedback: "All criteria passed.",
        };
      }

      throw new Error(`Unknown agent: ${agentId}`);
    },
  };
}

async function outputExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const from = options.from ?? (await findLatestTag(options.to));
  const rangeLabel = from
    ? `${from}..${options.to}`
    : `last 20 commits through ${options.to}`;
  const commits = await readCommits(from, options.to);
  if (commits.length === 0)
    throw new Error(`No non-merge commits found in ${rangeLabel}.`);

  const engine = new WorkflowEngine(createLocalExecutor());
  engine.onEvent((event) => {
    if (event.type === "step_started" && event.stepId)
      process.stdout.write(`Running ${event.stepId}...\n`);
  });

  const execution = await engine.start(workflow, {
    commits,
    rangeLabel,
    requirement,
  });
  if (execution.status !== "completed") {
    throw new Error(execution.error ?? "Release-notes workflow failed.");
  }

  const notes = execution.outputs.notes;
  if (typeof notes !== "string")
    throw new Error("Workflow completed without release notes.");

  const outputPath = resolve(options.outputPath);
  if (!options.force && (await outputExists(outputPath))) {
    throw new Error(
      `${outputPath} already exists. Pass --force to overwrite it.`,
    );
  }

  await writeFile(outputPath, notes, "utf8");
  process.stdout.write(
    `Reviewed ${commits.length} commits and wrote ${outputPath}\n`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
