import sys
filepath = sys.argv[1]
with open(filepath, 'r') as f:
    lines = f.readlines()
# Line 593 is index 592 - use backtick template literals
line = "      expect(escapeFtsQuery(`it's " + '"quoted"' + " term`)).toBe(`" + '"it\'s ""quoted"" term"' + "`);\n"
lines[592] = line
with open(filepath, 'w') as f:
    f.writelines(lines)
print('Line 593 fixed')
