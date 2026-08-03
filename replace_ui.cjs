const fs = require('fs');
const ui = require('./remote_ui.cjs');
let file = fs.readFileSync('src/frontier/remote.ts', 'utf8');

const regex = /export function renderPage\(tok: string\): string \{\n  const T = JSON\.stringify\(tok\);\n  return `<!doctype html>[\s\S]*?<\/html>`;\n\}/;
if (!regex.test(file)) {
  console.log("Could not find renderPage");
  process.exit(1);
}

const newBody = `export function renderPage(tok: string): string {
  const T = JSON.stringify(tok);
  return \`${ui('${T}')}\`;
}`;

file = file.replace(regex, newBody);
fs.writeFileSync('src/frontier/remote.ts', file);
console.log("Successfully replaced renderPage");
