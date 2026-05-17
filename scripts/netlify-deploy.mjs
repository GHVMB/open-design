// Deploy script: build Next.js, copy Netlify functions into the output dir, deploy.
// Usage: node scripts/netlify-deploy.mjs

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'apps', 'web', 'out');
const SITE_ID = '48176bbd-84a8-4d19-a8d9-d3c9aefaa0e4';

const run = (cmd, cwd = ROOT) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', shell: true });
};

// 1. Build
run('pnpm --filter @open-design/web build');

// 2. Copy functions into build output
const functionsOut = resolve(OUT, 'netlify', 'functions');
const edgeFunctionsOut = resolve(OUT, 'netlify', 'edge-functions');

if (existsSync(functionsOut)) rmSync(functionsOut, { recursive: true });
if (existsSync(edgeFunctionsOut)) rmSync(edgeFunctionsOut, { recursive: true });

mkdirSync(functionsOut, { recursive: true });
mkdirSync(edgeFunctionsOut, { recursive: true });

cpSync(resolve(ROOT, 'netlify', 'functions'), functionsOut, { recursive: true });
cpSync(resolve(ROOT, 'netlify', 'edge-functions'), edgeFunctionsOut, { recursive: true });

// 3. Write netlify.toml for the output directory
writeFileSync(resolve(OUT, 'netlify.toml'), `[build]
  publish = "."
  functions = "netlify/functions"
  edge_functions = "netlify/edge-functions"

[[edge_functions]]
  path = "/api/proxy/anthropic/stream"
  function = "proxy-anthropic"

[[edge_functions]]
  path = "/api/proxy/openai/stream"
  function = "proxy-openai"

[[edge_functions]]
  path = "/api/proxy/azure/stream"
  function = "proxy-azure"

[[edge_functions]]
  path = "/api/proxy/google/stream"
  function = "proxy-google"

[[edge_functions]]
  path = "/api/proxy/ollama/stream"
  function = "proxy-ollama"
`);

// 4. Deploy (NETLIFY_SITE_ID bypasses the monorepo interactive prompt)
const env = { ...process.env, NETLIFY_SITE_ID: SITE_ID };
console.log('\n> netlify deploy --prod --dir . --no-build');
execSync('netlify deploy --prod --dir . --no-build', { cwd: OUT, stdio: 'inherit', shell: true, env });

console.log('\nDone! https://open-design-app.netlify.app');
