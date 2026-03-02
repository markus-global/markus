// Debug regex matching step by step
const testString = `## Heartbeat
- Check tasks: Check tasks
- Report status: Report current status

## Policies
- Code Safety: Never commit secrets`;

console.log('Test string with visible newlines:');
console.log(testString.replace(/\n/g, '\\n\n'));

// Test different regexes
const regexes = [
  { name: 'Original: $(?!\\S)', regex: /^## Heartbeat\s*$\n([\s\S]*?)(?=^##\s|^#\s|$(?!\S))/m },
  { name: 'End of string: \\z (doesnt work)', regex: /^## Heartbeat\s*$\n([\s\S]*?)(?=^##\s|^#\s|\z)/m },
  { name: '$(?![^\\r\\n])', regex: /^## Heartbeat\s*$\n([\s\S]*?)(?=^##\s|^#\s|$(?![^\r\n]))/m },
  { name: '$(?!.)', regex: /^## Heartbeat\s*$\n([\s\S]*?)(?=^##\s|^#\s|$(?!.))/m },
  { name: 'Lookahead for nothing after $', regex: /^## Heartbeat\s*$\n([\s\S]*?)(?=^##\s|^#\s|$(?=\s*$))/m },
];

for (const { name, regex } of regexes) {
  console.log(`\n=== ${name} ===`);
  console.log('Regex:', regex);
  
  try {
    const match = testString.match(regex);
    if (match) {
      console.log('Match[0]:', JSON.stringify(match[0]));
      console.log('Match[1]:', JSON.stringify(match[1]));
    } else {
      console.log('No match');
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
}

// Actually, maybe we should use a different approach: match until next heading or end of string
console.log('\n\n=== Alternative approach ===');
const altRegex = /^## Heartbeat\s*$\n([\s\S]*?)(?=\n##\s|\n#\s|$)/m;
console.log('Regex:', altRegex);
const altMatch = testString.match(altRegex);
if (altMatch) {
  console.log('Match[0]:', JSON.stringify(altMatch[0]));
  console.log('Match[1]:', JSON.stringify(altMatch[1]));
}

// Even better: match until blank line then heading
console.log('\n\n=== Better approach ===');
const betterRegex = /^## Heartbeat\s*$\n([\s\S]*?)(?=\n\s*\n##|\n\s*\n#|$)/m;
console.log('Regex:', betterRegex);
const betterMatch = testString.match(betterRegex);
if (betterMatch) {
  console.log('Match[0]:', JSON.stringify(betterMatch[0]));
  console.log('Match[1]:', JSON.stringify(betterMatch[1]));
}