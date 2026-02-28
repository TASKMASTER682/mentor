// Simple syntax test script
import fs from 'fs';

const filesToTest = [
  './models/MockTest.js',
  './models/TestAttempt.js',
  './services/pdfService.js',
  './routes/mockTest.js'
];

console.log('Testing syntax of modified files...\n');

for (const file of filesToTest) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    // Basic syntax check by trying to parse as ES module
    const testCode = `
      ${content}
      console.log('✓ ${file} syntax OK');
    `;
    
    // Create a temporary file to test
    const tempFile = `./temp-test-${Date.now()}.js`;
    fs.writeFileSync(tempFile, testCode);
    
    // Try to import it
    try {
      await import(`./${tempFile}`);
      console.log(`✓ ${file} - Syntax OK`);
    } catch (err) {
      console.log(`✗ ${file} - Syntax Error: ${err.message}`);
    } finally {
      // Clean up
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
    
  } catch (err) {
    console.log(`✗ ${file} - File Error: ${err.message}`);
  }
}

console.log('\nSyntax test completed.');