'use strict';

const fs = require('fs');
const filePath =
  '/usr/local/lib/node_modules/@squoosh/cli/node_modules/@squoosh/lib/build/index.js';

if (!fs.existsSync(filePath)) {
  console.warn(
    '[patch-squoosh] Squoosh build index.js not found, skipping patch.',
  );
  process.exit(0);
}

let code = fs.readFileSync(filePath, 'utf8');

const start = code.indexOf('function instantiateEmscriptenWasm');
const end = code.indexOf('const threads=');

if (start === -1 || end === -1) {
  console.warn(
    '[patch-squoosh] Failed to locate instantiateEmscriptenWasm, skipping patch.',
  );
  process.exit(0);
}

const replacement = `const _wasmCache = new Map();
function instantiateEmscriptenWasm(factory, path, workerJS = "") {
  const key = path + "::" + workerJS;
  if (_wasmCache.has(key)) return _wasmCache.get(key);
  const p = factory({
    locateFile(requestPath) {
      if (requestPath.endsWith(".wasm")) return pathify(path);
      if (requestPath.endsWith(".worker.js")) return new url.URL(workerJS).pathname;
      return requestPath;
    }
  });
  _wasmCache.set(key, p);
  return p;
}
`;

code = code.slice(0, start) + replacement + code.slice(end);
fs.writeFileSync(filePath, code);
console.log(
  '[patch-squoosh] Successfully patched instantiateEmscriptenWasm to reuse WASM instances.',
);
