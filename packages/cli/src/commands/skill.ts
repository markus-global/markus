import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { table, success, fail, extractRows } from '../output.js';

export function registerSkillCommands(program: Command): Command {
  const root = program.command('skill').description('Skills registry and local scaffold');

  root.command('list').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>('/skills');
      const rows = extractRows(data);
      table(rows, [
        { key: 'name', header: 'Name', width: 24 },
        { key: 'version', header: 'Ver', width: 8 },
        { key: 'category', header: 'Category', width: 12 },
        { key: 'type', header: 'Type', width: 12 },
        { key: 'description', header: 'Description', width: 40 },
      ], { ...out, title: 'Skills' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('builtin').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>('/skills/builtin');
      const rows = extractRows(data);
      table(rows, [
        { key: 'name', header: 'Name', width: 24 },
        { key: 'category', header: 'Category', width: 14 },
        { key: 'description', header: 'Description', width: 50 },
      ], { ...out, title: 'Builtin skills' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root
    .command('install')
    .requiredOption('--name <n>')
    .option('--source <s>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>('/skills/install', {
          name: opts.name,
          ...(opts.source && { source: opts.source }),
        });
        success('Skill installed', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root.command('uninstall <name>').action(async (name, _opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.delete<unknown>(`/skills/installed/${encodeURIComponent(name)}`);
      success('Skill uninstalled', data, out);
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root
    .command('search')
    .option('--query <q>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<Record<string, unknown>>('/skills/registry/skillhub', { query: opts.query });
        const rows = extractRows(data);
        table(rows, [
          { key: 'name', header: 'Name', width: 24 },
          { key: 'version', header: 'Ver', width: 8 },
          { key: 'category', header: 'Category', width: 12 },
          { key: 'description', header: 'Description', width: 40 },
        ], { ...out, title: 'Registry search' });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('init')
    .option('--dir <d>')
    .option('--name <n>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const out = { json: !!g.json };
      if (!opts.dir && !opts.name) fail('Specify --dir or --name');
      const dir = resolve(process.cwd(), (opts.dir ?? opts.name) as string);
      mkdirSync(dir, { recursive: true });
      const skillName = opts.name ?? (opts.dir ? opts.dir.replace(/.*[/\\]/, '') : 'my-skill');
      const skillJson = {
        name: skillName,
        version: '0.1.0',
        description: `${skillName} skill for Markus agents`,
        category: 'custom',
        tags: [] as string[],
      };
      const skillMd = `# ${skillName}\n\nDescribe what this skill does for agents.\n\n## When to use\n\n## Tools / behavior\n\n`;
      writeFileSync(resolve(dir, 'skill.json'), JSON.stringify(skillJson, null, 2) + '\n');
      writeFileSync(resolve(dir, 'SKILL.md'), skillMd);
      if (out.json) {
        console.log(JSON.stringify({ dir, files: ['skill.json', 'SKILL.md'] }, null, 2));
      } else {
        success(`Scaffolded skill in ${dir}`, undefined, out);
      }
    });

  return root;
}
