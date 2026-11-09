/**
 * Restricted expression evaluator for workflow definitions.
 *
 * Workflow `transform` / `condition` expressions used to be compiled with
 * `new Function(...)`, which meant anyone able to define a workflow could run
 * arbitrary JavaScript inside the server process. This module evaluates a small,
 * deliberately boring subset of JavaScript instead — no calls, no assignment, no
 * `eval`/`Function`, no access to `process`/`require`/`globalThis`.
 *
 * Supported: literals (number, string, template without ${}, true/false/null/
 * undefined), identifiers from the provided scope, member access (`a.b`, `a['b']`,
 * `a[0]`), array literals, object literals, grouping, unary `! - +`, arithmetic
 * `** * / % + -`, comparison `< > <= >= == != === !==`, logical `&& || ??`, and
 * the conditional operator `? :`.
 *
 * Everything else throws. Failing closed is the point: a workflow that used to
 * depend on arbitrary JS now fails loudly instead of silently executing it.
 */

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

type Token =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'punct'; value: string };

/** Member names that would hand an expression the prototype chain. */
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'caller', 'callee']);

const PUNCT = [
  '===', '!==', '**', '??', '||', '&&', '==', '!=', '<=', '>=',
  '{', '}', '[', ']', '(', ')', ',', ':', '?', '.', '+', '-', '*', '/', '%', '<', '>', '!',
];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // string literal
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let out = '';
      i++;
      let closed = false;
      while (i < src.length) {
        const c = src[i]!;
        if (c === '\\') {
          const next = src[i + 1];
          if (next === undefined) throw new ExpressionError('Unterminated escape in string');
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        if (quote === '`' && c === '$' && src[i + 1] === '{') {
          throw new ExpressionError('Template interpolation is not supported');
        }
        out += c;
        i++;
      }
      if (!closed) throw new ExpressionError('Unterminated string literal');
      tokens.push({ type: 'str', value: out });
      continue;
    }

    // number literal
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!match) throw new ExpressionError(`Bad number at ${i}`);
      tokens.push({ type: 'num', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }

    // identifier / keyword
    if (/[A-Za-z_$]/.test(ch)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      tokens.push({ type: 'ident', value: match[0] });
      i += match[0].length;
      continue;
    }

    const punct = PUNCT.find(p => src.startsWith(p, i));
    if (!punct) throw new ExpressionError(`Unexpected character "${ch}"`);
    tokens.push({ type: 'punct', value: punct });
    i += punct.length;
  }

  return tokens;
}

/** A parsed node is a small tagged object evaluated later. */
type Node =
  | { k: 'lit'; v: unknown }
  | { k: 'id'; name: string }
  | { k: 'member'; obj: Node; prop: Node; computed: boolean }
  | { k: 'array'; items: Node[] }
  | { k: 'object'; entries: Array<{ key: string; value: Node }> }
  | { k: 'unary'; op: string; arg: Node }
  | { k: 'binary'; op: string; left: Node; right: Node }
  | { k: 'cond'; test: Node; yes: Node; no: Node };

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private eat(punct?: string): Token {
    const token = this.peek();
    if (!token) throw new ExpressionError('Unexpected end of expression');
    if (punct && !(token.type === 'punct' && token.value === punct)) {
      throw new ExpressionError(`Expected "${punct}"`);
    }
    this.pos++;
    return token;
  }

  private isPunct(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return !!token && token.type === 'punct' && token.value === value;
  }

  parse(): Node {
    const node = this.parseConditional();
    if (this.pos !== this.tokens.length) throw new ExpressionError('Unexpected trailing input');
    return node;
  }

  private parseConditional(): Node {
    const test = this.parseBinary(0);
    if (!this.isPunct('?')) return test;
    this.eat('?');
    const yes = this.parseConditional();
    this.eat(':');
    const no = this.parseConditional();
    return { k: 'cond', test, yes, no };
  }

  // lowest-precedence first
  private static readonly LEVELS: string[][] = [
    ['??'],
    ['||'],
    ['&&'],
    ['===', '!==', '==', '!='],
    ['<=', '>=', '<', '>'],
    ['+', '-'],
    ['*', '/', '%'],
    ['**'],
  ];

  private parseBinary(level: number): Node {
    if (level >= Parser.LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const token = this.peek();
      if (!token || token.type !== 'punct' || !Parser.LEVELS[level]!.includes(token.value)) break;
      this.pos++;
      const right = this.parseBinary(level + 1);
      left = { k: 'binary', op: token.value, left, right };
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.isPunct('!') || this.isPunct('-') || this.isPunct('+')) {
      const op = (this.peek() as { value: string }).value;
      this.pos++;
      return { k: 'unary', op, arg: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      if (this.isPunct('.')) {
        this.pos++;
        const token = this.eat();
        if (token.type !== 'ident') throw new ExpressionError('Expected property name after "."');
        node = { k: 'member', obj: node, prop: { k: 'lit', v: token.value }, computed: false };
        continue;
      }
      if (this.isPunct('[')) {
        this.pos++;
        const prop = this.parseConditional();
        this.eat(']');
        node = { k: 'member', obj: node, prop, computed: true };
        continue;
      }
      if (this.isPunct('(')) {
        throw new ExpressionError('Function calls are not allowed in workflow expressions');
      }
      break;
    }
    return node;
  }

  private parsePrimary(): Node {
    const token = this.peek();
    if (!token) throw new ExpressionError('Unexpected end of expression');

    if (token.type === 'num' || token.type === 'str') {
      this.pos++;
      return { k: 'lit', v: token.value };
    }

    if (token.type === 'ident') {
      this.pos++;
      switch (token.value) {
        case 'true':
          return { k: 'lit', v: true };
        case 'false':
          return { k: 'lit', v: false };
        case 'null':
          return { k: 'lit', v: null };
        case 'undefined':
          return { k: 'lit', v: undefined };
        default:
          if (this.isPunct('(')) {
            throw new ExpressionError(`Function calls are not allowed ("${token.value}")`);
          }
          return { k: 'id', name: token.value };
      }
    }

    if (token.type === 'punct' && token.value === '(') {
      this.pos++;
      const inner = this.parseConditional();
      this.eat(')');
      return inner;
    }

    if (token.type === 'punct' && token.value === '[') {
      this.pos++;
      const items: Node[] = [];
      if (!this.isPunct(']')) {
        for (;;) {
          items.push(this.parseConditional());
          if (this.isPunct(',')) {
            this.pos++;
            if (this.isPunct(']')) break;
            continue;
          }
          break;
        }
      }
      this.eat(']');
      return { k: 'array', items };
    }

    if (token.type === 'punct' && token.value === '{') {
      this.pos++;
      const entries: Array<{ key: string; value: Node }> = [];
      if (!this.isPunct('}')) {
        for (;;) {
          const keyToken = this.eat();
          let key: string;
          if (keyToken.type === 'ident') key = keyToken.value;
          else if (keyToken.type === 'str') key = keyToken.value;
          else if (keyToken.type === 'num') key = String(keyToken.value);
          else throw new ExpressionError('Invalid object key');
          this.eat(':');
          entries.push({ key, value: this.parseConditional() });
          if (this.isPunct(',')) {
            this.pos++;
            if (this.isPunct('}')) break;
            continue;
          }
          break;
        }
      }
      this.eat('}');
      return { k: 'object', entries };
    }

    throw new ExpressionError(`Unexpected token "${token.value}"`);
  }
}

function readMember(target: unknown, key: unknown): unknown {
  if (target === null || target === undefined) return undefined;
  const name = typeof key === 'number' ? String(key) : String(key);
  if (BLOCKED_KEYS.has(name)) {
    throw new ExpressionError(`Access to "${name}" is not allowed`);
  }
  if (typeof target === 'function') {
    throw new ExpressionError('Access to function values is not allowed');
  }
  const value = (target as Record<string, unknown>)[name];
  if (typeof value === 'function') {
    throw new ExpressionError(`Access to method "${name}" is not allowed`);
  }
  return value;
}

function evaluateNode(node: Node, scope: Record<string, unknown>): unknown {
  switch (node.k) {
    case 'lit':
      return node.v;

    case 'id': {
      if (!Object.prototype.hasOwnProperty.call(scope, node.name)) {
        throw new ExpressionError(`Unknown identifier "${node.name}"`);
      }
      return scope[node.name];
    }

    case 'member': {
      const obj = evaluateNode(node.obj, scope);
      const key = node.computed ? evaluateNode(node.prop, scope) : (node.prop as { v: unknown }).v;
      return readMember(obj, key);
    }

    case 'array':
      return node.items.map(item => evaluateNode(item, scope));

    case 'object': {
      const out: Record<string, unknown> = {};
      for (const entry of node.entries) {
        if (BLOCKED_KEYS.has(entry.key)) {
          throw new ExpressionError(`Access to "${entry.key}" is not allowed`);
        }
        out[entry.key] = evaluateNode(entry.value, scope);
      }
      return out;
    }

    case 'unary': {
      const arg = evaluateNode(node.arg, scope);
      if (node.op === '!') return !arg;
      if (node.op === '-') return -(arg as number);
      return +(arg as number);
    }

    case 'binary': {
      // short-circuit forms first
      if (node.op === '&&') {
        const left = evaluateNode(node.left, scope);
        return left ? evaluateNode(node.right, scope) : left;
      }
      if (node.op === '||') {
        const left = evaluateNode(node.left, scope);
        return left ? left : evaluateNode(node.right, scope);
      }
      if (node.op === '??') {
        const left = evaluateNode(node.left, scope);
        return left === null || left === undefined ? evaluateNode(node.right, scope) : left;
      }
      const left = evaluateNode(node.left, scope) as never;
      const right = evaluateNode(node.right, scope) as never;
      switch (node.op) {
        case '+': return (left as number) + (right as number);
        case '-': return (left as number) - (right as number);
        case '*': return (left as number) * (right as number);
        case '/': return (left as number) / (right as number);
        case '%': return (left as number) % (right as number);
        case '**': return (left as number) ** (right as number);
        case '<': return left < right;
        case '>': return left > right;
        case '<=': return left <= right;
        case '>=': return left >= right;
        case '==': return left == right; // eslint-disable-line eqeqeq
        case '!=': return left != right; // eslint-disable-line eqeqeq
        case '===': return left === right;
        case '!==': return left !== right;
        default:
          throw new ExpressionError(`Unsupported operator "${node.op}"`);
      }
    }

    case 'cond':
      return evaluateNode(node.test, scope) ? evaluateNode(node.yes, scope) : evaluateNode(node.no, scope);
  }
}

/**
 * Evaluate a workflow expression against `scope`. Throws {@link ExpressionError}
 * on anything outside the supported subset.
 */
export function evaluateExpression(expression: string, scope: Record<string, unknown>): unknown {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new ExpressionError('Empty expression');
  }
  const ast = new Parser(tokenize(expression)).parse();
  return evaluateNode(ast, scope);
}
