// Step through regex matching
const testString = `## Heartbeat
- Check tasks: Check tasks
- Report status: Report current status

## Policies
- Code Safety: Never commit secrets`;

const regex = /^## Heartbeat\s*$\n([\s\S]*?)(?=^##\s|^#\s|$)/gm;

console.log('Test string:');
console.log(JSON.stringify(testString));
console.log('\nRegex:', regex);

let match;
while ((match = regex.exec(testString)) !== null) {
  console.log('\nMatch found at index', match.index);
  console.log('Match[0]:', JSON.stringify(match[0]));
  console.log('Match[1]:', JSON.stringify(match[1]));
  
  // Show what comes after the match
  const after = testString.substring(match.index + match[0].length);
  console.log('After match:', JSON.stringify(after.substring(0, 50)));
  
  // Check if lookahead would match at various positions
  console.log('\nChecking lookahead at different positions:');
  
  // Position 0: at start of string
  const testAtPos0 = testString.substring(0);
  const lookaheadAt0 = /^##\s|^#\s|$/.test(testAtPos0);
  console.log(`At position 0 (${JSON.stringify(testAtPos0.substring(0, 20))}...): ${lookaheadAt0}`);
  
  // Position after "## Heartbeat\n"
  const posAfterHeader = testString.indexOf('\n') + 1;
  const testAtPos1 = testString.substring(posAfterHeader);
  const lookaheadAt1 = /^##\s|^#\s|$/.test(testAtPos1);
  console.log(`At position after header (${JSON.stringify(testAtPos1.substring(0, 20))}...): ${lookaheadAt1}`);
  
  // Position after first task
  const posAfterFirstTask = testString.indexOf('\n', posAfterHeader) + 1;
  const testAtPos2 = testString.substring(posAfterFirstTask);
  const lookaheadAt2 = /^##\s|^#\s|$/.test(testAtPos2);
  console.log(`At position after first task (${JSON.stringify(testAtPos2.substring(0, 20))}...): ${lookaheadAt2}`);
  
  // Position after second task  
  const posAfterSecondTask = testString.indexOf('\n', posAfterFirstTask) + 1;
  const testAtPos3 = testString.substring(posAfterSecondTask);
  const lookaheadAt3 = /^##\s|^#\s|$/.test(testAtPos3);
  console.log(`At position after second task (${JSON.stringify(testAtPos3.substring(0, 20))}...): ${lookaheadAt3}`);
  
  // Position after blank line
  const posAfterBlank = testString.indexOf('\n', posAfterSecondTask) + 1;
  const testAtPos4 = testString.substring(posAfterBlank);
  const lookaheadAt4 = /^##\s|^#\s|$/.test(testAtPos4);
  console.log(`At position after blank line (${JSON.stringify(testAtPos4.substring(0, 20))}...): ${lookaheadAt4}`);
}