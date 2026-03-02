// Test the regex
const testString = '- Check tasks: Check tasks';
const trimmed = testString.trim();

console.log('Original:', testString);
console.log('Trimmed:', trimmed);

// Current regex
const inlineDesc = trimmed.match(/:?\s*(.+)$/);
console.log('\nCurrent regex match:');
console.log('Full match:', inlineDesc?.[0]);
console.log('Group 1:', inlineDesc?.[1]);

// What we want: everything after the first colon
const colonIndex = trimmed.indexOf(':');
if (colonIndex !== -1) {
  const afterColon = trimmed.substring(colonIndex + 1).trim();
  console.log('\nAfter first colon:', afterColon);
}

// Test with bullet point removed
const withoutBullet = trimmed.replace(/^[-*]\s*/, '');
console.log('\nWithout bullet:', withoutBullet);

// Task name (before colon)
const taskName = withoutBullet.replace(/:.*$/, '').trim();
console.log('Task name:', taskName);

// Description (after colon)
const descMatch = withoutBullet.match(/:\s*(.+)$/);
console.log('Description match:', descMatch?.[1]);