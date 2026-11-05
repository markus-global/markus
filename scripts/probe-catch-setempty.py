#!/usr/bin/env python3
"""探针：找出 `catch` 块的**语句体**里把状态置成空集合的位置（审计 P1 的第二形态）。

为什么要单独一个脚本：
  - `probe-catch-swallow.mjs` 只认 `return []` 形态；
  - 在用户眼里 `catch { setX([]) }` 与 `return []` 是同一条谎话（界面渲染空列表）；
  - 单行 grep 会把**注释**里提到的 `setSessions([])` 也算进来（本项目就踩过），
    所以这里按 catch 块的花括号范围取语句体，再在语句体里匹配。

判据：`setXxx([])` / `setXxx({})` / `setXxx(new Set())` / `setXxx(new Map())`。
范围：`packages/<pkg>/src/**`，剔 `*.test.ts(x)`、`*.d.ts`（与 mjs 探针一致）。

用法：
  python3 scripts/probe-catch-setempty.py            # 扫工作树
  python3 scripts/probe-catch-setempty.py --rev <sha>
"""
import re
import subprocess
import sys

REV = None
if '--rev' in sys.argv:
    REV = sys.argv[sys.argv.index('--rev') + 1]

SET_EMPTY = re.compile(
    r'set[A-Za-z0-9_]*\s*\(\s*(\[\s*\]|\{\s*\}|new\s+Set\s*\(\s*\)|new\s+Map\s*\(\s*\))\s*\)'
)


def is_target(path: str) -> bool:
    return (
        re.match(r'^packages/[^/]+/src/', path) is not None
        and (path.endswith('.ts') or path.endswith('.tsx'))
        and not path.endswith('.d.ts')
        and re.search(r'\.test\.tsx?$', path) is None
    )


def list_files():
    out = subprocess.run(
        ['git', 'ls-tree', '-r', '--name-only', REV or 'HEAD'],
        capture_output=True, text=True, check=True,
    ).stdout
    return [p for p in out.split('\n') if p and is_target(p)]


def read_file(path: str) -> str:
    if REV:
        return subprocess.run(
            ['git', 'show', f'{REV}:{path}'],
            capture_output=True, text=True, check=True,
        ).stdout
    with open(path, encoding='utf-8') as fh:
        return fh.read()


def mask_comments(text: str) -> str:
    """把注释替换成等长空白（保留换行，行号不变）—— 注释里的 `catch` 不是代码。"""
    def blank(m):
        return re.sub(r'[^\n]', ' ', m.group(0))
    text = re.sub(r'/\*.*?\*/', blank, text, flags=re.S)
    return re.sub(r'//[^\n]*', blank, text)


def catch_bodies(text: str):
    """返回 [(行号, catch 语句体)]，注释不参与匹配。"""
    text = mask_comments(text)
    out = []
    i = 0
    while True:
        m = re.search(r'\bcatch\b', text[i:])
        if not m:
            break
        j = i + m.end()
        line = text[:j].count('\n') + 1
        while j < len(text) and text[j] in ' \t':
            j += 1
        if j < len(text) and text[j] == '(':
            depth = 0
            while j < len(text):
                if text[j] == '(':
                    depth += 1
                elif text[j] == ')':
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
                j += 1
            while j < len(text) and text[j] in ' \t\n':
                j += 1
        if j < len(text) and text[j] == '{':
            depth = 0
            k = j
            while k < len(text):
                if text[k] == '{':
                    depth += 1
                elif text[k] == '}':
                    depth -= 1
                    if depth == 0:
                        k += 1
                        break
                k += 1
            out.append((line, text[j:k]))
            i = k
        else:
            end = text.find('\n', j)
            out.append((line, text[j:end if end != -1 else len(text)]))
            i = end if end != -1 else len(text)
    return out


def strip_comments(body: str) -> str:
    """去掉 // 与 /* */ 注释 —— 注释里提到旧写法不算命中。"""
    body = re.sub(r'/\*.*?\*/', '', body, flags=re.S)
    return re.sub(r'//[^\n]*', '', body)


def main():
    rows = []
    for path in list_files():
        try:
            text = read_file(path)
        except Exception:
            continue
        for line, body in catch_bodies(text):
            if SET_EMPTY.search(strip_comments(body)):
                # body 归一化后整段保留：raises 校验要在**完整**命中体里 grep，
                # 不能用截断到 140 字的 snippet（升起语句常在 catch 体后半段）。
                norm_body = re.sub(r'\s+', ' ', body).strip()
                rows.append({
                    'file': path, 'line': line,
                    'snippet': norm_body[:140], 'body': norm_body,
                })
    for r in rows:
        print(f"{r['file']}:{r['line']}\t{r['snippet']}")
    print(f'\nTOTAL = {len(rows)}  (scope=packages/*/src, rev={REV or "worktree"})')

    # ── 分类（同 scripts/probe-catch-swallow.mjs 的同一张登记表）────────────────
    if '--classify' not in sys.argv:
        return
    import json
    import os
    ledger_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'read-path-exemptions.json')
    with open(ledger_path, encoding='utf-8') as fh:
        ledger = json.load(fh)['entries']
    norm = lambda s: re.sub(r'\s+', ' ', s).strip()

    # 台账自证（fail-closed）：error-raised 必须带可机检的 raises，并在**同一条命中体**内
    # grep 到 —— 否则「已修」只是 JSON 里的一句话：把升起语句删掉后门禁仍全绿（实测踩过）。
    invalid = [
        e for e in ledger
        if e.get('class') == 'error-raised'
        and not (isinstance(e.get('raises'), str) and e['raises'].strip())
    ]

    def verdict(e, r):
        if e.get('class') != 'error-raised':
            return True, ''
        token = e.get('raises')
        if not (isinstance(token, str) and token.strip()):
            return False, 'error-raised 缺 raises 字段（不可自证）'
        if norm(token) not in norm(r['body']):
            return False, f'error-raised 命中体内找不到 {token!r}（升起语句已消失）'
        return True, ''

    used = set()
    per_file = {}
    fetch_path, exempt = [], []
    for r in rows:
        nth = per_file.get(r['file'], 0) + 1
        per_file[r['file']] = nth
        hit = next((i for i, e in enumerate(ledger)
                    if i not in used and e.get('probe') == 'setempty'
                    and e['file'] == r['file'] and e['nth'] == nth
                    and ('snippet' not in e or norm(e['snippet']) in norm(r['snippet']))), None)
        if hit is None:
            fetch_path.append((r['file'], r['line'], '未登记', r['snippet']))
            continue
        used.add(hit)
        ok, why = verdict(ledger[hit], r)
        if ok:
            exempt.append((r['file'], r['line'], ledger[hit]['class'], ledger[hit]['reason']))
        else:
            fetch_path.append((r['file'], r['line'], why, r['snippet']))
    stale = [e for i, e in enumerate(ledger) if e.get('probe') == 'setempty' and i not in used]
    print(f'\n取数路径（必须为 0）= {len(fetch_path)}')
    for path, line, why, snippet in fetch_path:
        print(f'  ✗ {path}:{line}\t[{why}]\t{snippet}')
    print(f'\n已登记豁免 = {len(exempt)}')
    for path, line, cls, reason in exempt:
        print(f'  · {path}:{line}  [{cls}]  {reason}')
    if stale:
        print(f'\n失效登记项（代码已不再命中，必须删除）= {len(stale)}')
        for e in stale:
            print(f"  ? {e['file']}\tnth={e['nth']}\t{e.get('reason', '')}")
    if invalid:
        print(f'\n台账不可自证（error-raised 缺 raises，必须补字段）= {len(invalid)}')
        for e in invalid:
            print(f"  ! {e['file']}\tnth={e['nth']}")
    if fetch_path or stale or invalid:
        sys.exit(1)


if __name__ == '__main__':
    main()
