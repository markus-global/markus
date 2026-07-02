import sys

filepath = sys.argv[1]

with open(filepath, 'r') as f:
    lines = f.readlines()

# Correct line: use backtick template literals
# test value: it's "quoted" term
# expected: "it's ""quoted"" term"
want = "      expect(escapeFtsQuery(`it's \u0022quoted\u0022 term`)).toBe(`\u0022it's \u0022\u0022quoted\u0022\u0022 term\u0022`);\n"

assert len(lines) > 592, f"File only has {len(lines)} lines"
lines[592] = want

with open(filepath, 'w') as f:
    f.writelines(lines)

# Verify
with open(filepath, 'r') as f:
    l = f.readlines()[592]
print(f"Line 593 now: {repr(l)}")
assert '\\' not in l.rstrip('\n').split('(')[1], "No backslashes should be in the string!"
print("OK - no backslashes")
