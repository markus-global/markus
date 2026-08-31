import { describe, it, expect } from 'vitest';
import {
  transformOutsideCode,
  normalizeMathDelimiters,
  preprocessMentions,
  preprocessEntityLinksInCode,
  preprocessEntityIds,
  autolinkBareUrls,
  looksLikePlantUML,
  looksLikeMermaid,
  languageDisplayName,
  extractLanguageFromClass,
} from '../src/components/markdown-utils.ts';

// ─── transformOutsideCode ────────────────────────────────────────────────────

describe('transformOutsideCode', () => {
  const upper = (s: string) => s.toUpperCase();

  it('transforms plain text', () => {
    expect(transformOutsideCode('hello world', upper)).toBe('HELLO WORLD');
  });

  it('preserves fenced code blocks', () => {
    const input = 'before\n```\ncode here\n```\nafter';
    const result = transformOutsideCode(input, upper);
    expect(result).toBe('BEFORE\n```\ncode here\n```\nAFTER');
  });

  it('preserves fenced code blocks with language tag', () => {
    const input = 'text ```typescript\nconst x = 1;\n``` more';
    const result = transformOutsideCode(input, upper);
    expect(result).toBe('TEXT ```typescript\nconst x = 1;\n``` MORE');
  });

  it('preserves inline code', () => {
    const input = 'run `npm install` now';
    const result = transformOutsideCode(input, upper);
    expect(result).toBe('RUN `npm install` NOW');
  });

  it('handles multiple code segments', () => {
    const input = 'a `x` b `y` c';
    const result = transformOutsideCode(input, upper);
    expect(result).toBe('A `x` B `y` C');
  });

  it('handles text with no code segments', () => {
    const input = 'just plain text';
    expect(transformOutsideCode(input, upper)).toBe('JUST PLAIN TEXT');
  });

  it('handles text that is entirely a code block', () => {
    const input = '```\nall code\n```';
    expect(transformOutsideCode(input, upper)).toBe('```\nall code\n```');
  });

  it('protects @startuml inside fenced code blocks', () => {
    const input = 'see diagram:\n```plantuml\n@startuml\nAlice -> Bob\n@enduml\n```\nend';
    const replace = (s: string) => s.replace(/@(\w+)/g, '[@$1](#mention:$1)');
    const result = transformOutsideCode(input, replace);
    expect(result).toContain('@startuml');
    expect(result).toContain('@enduml');
    expect(result).not.toContain('#mention:startuml');
  });
});

// ─── normalizeMathDelimiters ─────────────────────────────────────────────────

describe('normalizeMathDelimiters', () => {
  it('converts inline \\(...\\) to $...$', () => {
    expect(normalizeMathDelimiters('The value \\(x + 1\\) is.')).toBe('The value $x + 1$ is.');
  });

  it('converts block \\[...\\] to $$...$$', () => {
    expect(normalizeMathDelimiters('Formula:\n\\[E = mc^2\\]\ndone'))
      .toBe('Formula:\n$$E = mc^2$$\ndone');
  });

  it('handles multiline block math', () => {
    const input = '\\[\na + b\n= c\n\\]';
    const result = normalizeMathDelimiters(input);
    expect(result).toBe('$$\na + b\n= c\n$$');
  });

  it('leaves already-correct delimiters unchanged', () => {
    expect(normalizeMathDelimiters('$x$ and $$y$$')).toBe('$x$ and $$y$$');
  });

  it('handles mixed inline and block', () => {
    const input = 'inline \\(a\\) and block \\[b\\]';
    expect(normalizeMathDelimiters(input)).toBe('inline $a$ and block $$b$$');
  });
});

// ─── preprocessMentions ──────────────────────────────────────────────────────

describe('preprocessMentions', () => {
  it('converts simple @mention', () => {
    const result = preprocessMentions('hello @Alice');
    expect(result).toBe('hello [@Alice](#mention:Alice)');
  });

  it('converts bracketed @[Name]', () => {
    const result = preprocessMentions('cc @[Bob Smith]');
    expect(result).toBe('cc [@Bob Smith](#mention:Bob%20Smith)');
  });

  it('converts multiple mentions', () => {
    const result = preprocessMentions('@foo and @bar');
    expect(result).toBe('[@foo](#mention:foo) and [@bar](#mention:bar)');
  });

  it('leaves bare @ alone', () => {
    const result = preprocessMentions('email@ stuff');
    expect(result).toBe('email@ stuff');
  });

  it('uses knownNames for multi-word matching', () => {
    const result = preprocessMentions('ask @Markus Dev about it', ['Markus Dev']);
    expect(result).toBe('ask [@Markus Dev](#mention:Markus%20Dev) about it');
  });

  it('prioritizes longer knownNames', () => {
    const result = preprocessMentions('@Markus Platform Dev Manager', ['Markus', 'Markus Platform Dev Manager']);
    expect(result).toBe('[@Markus Platform Dev Manager](#mention:Markus%20Platform%20Dev%20Manager)');
  });

  it('handles Unicode names', () => {
    const result = preprocessMentions('@李强');
    expect(result).toBe('[@李强](#mention:%E6%9D%8E%E5%BC%BA)');
  });
});

// ─── preprocessEntityLinksInCode / preprocessEntityIds ───────────────────────

describe('preprocessEntityLinksInCode', () => {
  it('unwraps entity links from backticks', () => {
    const input = 'see `[tsk_abc123ff](#entity:tsk_abc123ff)` here';
    expect(preprocessEntityLinksInCode(input)).toBe('see [tsk_abc123ff](#entity:tsk_abc123ff) here');
  });

  it('leaves non-entity backtick content alone', () => {
    const input = 'run `npm install`';
    expect(preprocessEntityLinksInCode(input)).toBe('run `npm install`');
  });
});

describe('preprocessEntityIds', () => {
  it('converts bare task ID to link', () => {
    expect(preprocessEntityIds('see tsk_abc123ff')).toBe('see [tsk_abc123ff](#entity:tsk_abc123ff)');
  });

  it('converts multiple entity types', () => {
    const result = preprocessEntityIds('task tsk_aaaaaa and agent agt_bbbbbb');
    expect(result).toContain('[tsk_aaaaaa](#entity:tsk_aaaaaa)');
    expect(result).toContain('[agt_bbbbbb](#entity:agt_bbbbbb)');
  });

  it('does not double-link already linked entities', () => {
    const input = '[tsk_abc123ff](#entity:tsk_abc123ff)';
    expect(preprocessEntityIds(input)).toBe(input);
  });

  it('ignores IDs that are too short', () => {
    expect(preprocessEntityIds('tsk_abc')).toBe('tsk_abc');
  });

  it('handles all entity prefixes', () => {
    for (const prefix of ['tsk', 'req', 'proj', 'dlv', 'agt']) {
      const id = `${prefix}_aabbccdd`;
      const result = preprocessEntityIds(id);
      expect(result).toBe(`[${id}](#entity:${id})`);
    }
  });

  it('does not rewrite agent IDs inside local image / file paths', () => {
    const md = '![CEO猫猫](/Users/liuqian/.markus/agents/agt_b56cd6208342f8502d7bdd4d/tool-outputs/ceo_cat.png)';
    expect(preprocessEntityIds(md)).toBe(md);
  });

  it('does not rewrite entity IDs inside markdown link destinations', () => {
    const md = '[open](https://example.com/x/dlv_abcdef12/view)';
    expect(preprocessEntityIds(md)).toBe(md);
  });

  it('still links bare agent IDs in surrounding prose', () => {
    const md = 'Agent agt_b56cd6208342f8502d7bdd4d made this image:\n\n![x](/tmp/agents/agt_b56cd6208342f8502d7bdd4d/out.png)';
    const result = preprocessEntityIds(md);
    expect(result).toContain('[agt_b56cd6208342f8502d7bdd4d](#entity:agt_b56cd6208342f8502d7bdd4d) made this image');
    expect(result).toContain('![x](/tmp/agents/agt_b56cd6208342f8502d7bdd4d/out.png)');
    expect(result).not.toContain('/agents/[agt_');
  });
});

// ─── autolinkBareUrls ────────────────────────────────────────────────────────

describe('autolinkBareUrls', () => {
  it('wraps a bare URL followed by CJK so the CJK is NOT swallowed into the link', () => {
    const input = '带着 Markus（https://markus.global/）去接企业';
    const result = autolinkBareUrls(input);
    expect(result).toContain('[https://markus.global/](https://markus.global/)');
    expect(result).toContain('）去接企业');
    expect(result).not.toContain('global/）'); // CJK must not be inside the URL
  });

  it('does not swallow trailing full-width punctuation or ideographs', () => {
    const input = '请访问 https://example.com/abc，谢谢';
    const result = autolinkBareUrls(input);
    expect(result).toContain('[https://example.com/abc](https://example.com/abc)');
    expect(result).toContain('，谢谢');
  });

  it('keeps trailing ASCII sentence punctuation outside the link', () => {
    const input = 'See https://example.com/page. Next sentence.';
    const result = autolinkBareUrls(input);
    expect(result).toContain('[https://example.com/page](https://example.com/page). Next sentence.');
  });

  it('preserves a URL that already has a trailing ASCII period stripped', () => {
    const input = 'Visit https://example.com/ now';
    const result = autolinkBareUrls(input);
    expect(result).toBe('Visit [https://example.com/](https://example.com/) now');
  });

  it('does not double-wrap an already-explicit markdown link', () => {
    const input = '[Label](https://example.com) stays';
    const result = autolinkBareUrls(input);
    // The URL is inside a destination `](…)` → must be left untouched.
    expect(result).toBe(input);
  });

  it('leaves plain prose without URLs unchanged', () => {
    const input = '没有链接的普通文本';
    expect(autolinkBareUrls(input)).toBe(input);
  });

  it('handles multiple URLs in one string', () => {
    const input = 'a https://a.com/x 和 https://b.com/y 结尾';
    const result = autolinkBareUrls(input);
    expect(result).toContain('[https://a.com/x](https://a.com/x)');
    expect(result).toContain('[https://b.com/y](https://b.com/y)');
  });
});

// ─── looksLikePlantUML ──────────────────────────────────────────────────────

describe('looksLikePlantUML', () => {
  it('detects valid PlantUML content', () => {
    expect(looksLikePlantUML('@startuml\nAlice -> Bob\n@enduml')).toBe(true);
  });

  it('handles leading/trailing whitespace', () => {
    expect(looksLikePlantUML('  @startuml\nA -> B\n@enduml  ')).toBe(true);
  });

  it('rejects content without @startuml', () => {
    expect(looksLikePlantUML('Alice -> Bob\n@enduml')).toBe(false);
  });

  it('rejects content without @enduml', () => {
    expect(looksLikePlantUML('@startuml\nAlice -> Bob')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(looksLikePlantUML('')).toBe(false);
  });
});

// ─── looksLikeMermaid ────────────────────────────────────────────────────────

describe('looksLikeMermaid', () => {
  it('detects graph diagram', () => {
    expect(looksLikeMermaid('graph TD\n  A --> B')).toBe(true);
  });

  it('detects flowchart', () => {
    expect(looksLikeMermaid('flowchart LR\n  A --> B')).toBe(true);
  });

  it('detects sequenceDiagram', () => {
    expect(looksLikeMermaid('sequenceDiagram\n  Alice->>Bob: Hi')).toBe(true);
  });

  it('detects classDiagram', () => {
    expect(looksLikeMermaid('classDiagram\n  Animal <|-- Duck')).toBe(true);
  });

  it('detects gantt', () => {
    expect(looksLikeMermaid('gantt\n  title A Plan')).toBe(true);
  });

  it('detects pie chart', () => {
    expect(looksLikeMermaid('pie\n  "Cats" : 45')).toBe(true);
  });

  it('detects gitGraph', () => {
    expect(looksLikeMermaid('gitGraph\n  commit')).toBe(true);
  });

  it('detects mindmap', () => {
    expect(looksLikeMermaid('mindmap\n  root((Root))')).toBe(true);
  });

  it('does not detect arbitrary text', () => {
    expect(looksLikeMermaid('const x = 1;')).toBe(false);
  });

  it('does not detect partial keyword', () => {
    expect(looksLikeMermaid('graphical user interface')).toBe(false);
  });
});

// ─── languageDisplayName ─────────────────────────────────────────────────────

describe('languageDisplayName', () => {
  it('maps known aliases', () => {
    expect(languageDisplayName('js')).toBe('JavaScript');
    expect(languageDisplayName('ts')).toBe('TypeScript');
    expect(languageDisplayName('py')).toBe('Python');
    expect(languageDisplayName('rs')).toBe('Rust');
    expect(languageDisplayName('cpp')).toBe('C++');
    expect(languageDisplayName('cs')).toBe('C#');
  });

  it('is case-insensitive', () => {
    expect(languageDisplayName('JavaScript')).toBe('JavaScript');
    expect(languageDisplayName('PYTHON')).toBe('Python');
  });

  it('capitalizes unknown languages', () => {
    expect(languageDisplayName('fortran')).toBe('Fortran');
    expect(languageDisplayName('cobol')).toBe('Cobol');
  });
});

// ─── extractLanguageFromClass ────────────────────────────────────────────────

describe('extractLanguageFromClass', () => {
  it('extracts from simple language class', () => {
    expect(extractLanguageFromClass('language-typescript')).toBe('typescript');
  });

  it('extracts from hljs-prefixed class', () => {
    expect(extractLanguageFromClass('hljs language-python')).toBe('python');
  });

  it('returns null when no language class', () => {
    expect(extractLanguageFromClass('some-other-class')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractLanguageFromClass('')).toBeNull();
  });
});

// ─── Integration: transformOutsideCode + preprocessMentions ──────────────────

describe('transformOutsideCode + preprocessMentions integration', () => {
  it('converts mentions in prose but not in code blocks', () => {
    const input = 'Ask @Alice about the code:\n```\n@startuml\nAlice -> Bob\n@enduml\n```\nThen @Bob continues.';
    const result = transformOutsideCode(input, s => preprocessMentions(s));
    expect(result).toContain('[@Alice](#mention:Alice)');
    expect(result).toContain('[@Bob](#mention:Bob)');
    expect(result).toContain('@startuml');
    expect(result).not.toContain('#mention:startuml');
  });

  it('converts mentions in prose but not in inline code', () => {
    const input = 'Use `@Injectable()` decorator and ask @admin';
    const result = transformOutsideCode(input, s => preprocessMentions(s));
    expect(result).toContain('`@Injectable()`');
    expect(result).toContain('[@admin](#mention:admin)');
  });

  it('handles entity IDs in prose but not in code', () => {
    const input = 'Fixed tsk_abcdef12 in this:\n```\nlet id = "tsk_abcdef12";\n```';
    const result = transformOutsideCode(input, s => preprocessEntityIds(s));
    expect(result).toContain('[tsk_abcdef12](#entity:tsk_abcdef12)');
    // The code block should still have the raw ID
    expect(result).toContain('```\nlet id = "tsk_abcdef12";\n```');
  });
});
