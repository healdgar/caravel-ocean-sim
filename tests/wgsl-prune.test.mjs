// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pruneWGSLFunctions} from '../js/wgsl-prune.js';

test('keeps all stage entry points and transitive calls, removing only unreachable helpers',()=>{
  const live=['fn a()->f32{return b();}','fn b()->f32{if(true){return 2.;}return 1.;}',
    '@vertex fn vs()->@builtin(position)vec4f{return vec4f(a());}',
    '@fragment fn fs()->@location(0)vec4f{return vec4f(1);}',
    '@compute @workgroup_size(1) fn main(){}'];
  const dead='fn unused()->f32{return alsoUnused();}\nfn alsoUnused()->f32{return 0.;}',prefix='override quality:bool=true;\nstruct Frame{x:f32}\n@group(0) @binding(0) var<uniform> f:Frame;\n';
  const result=pruneWGSLFunctions(prefix+dead+'\n'+live.join('\n'));
  assert.ok(result.startsWith(prefix));for(const source of live)assert.ok(result.includes(source));assert.doesNotMatch(result,/fn (?:unused|alsoUnused)/);
  assert.equal(pruneWGSLFunctions(result),result,'pruning is idempotent');
});
test('global references and annotated helpers remain conservative roots',()=>{
  const code='fn globalFn()->f32{return 1.;}\nconst retained=globalFn();\n@must_use fn diagnosticHelper()->f32{return 2.;}\nfn unused(){}\n@compute @workgroup_size(1) fn main(){}';
  const result=pruneWGSLFunctions(code);assert.match(result,/fn globalFn/);assert.match(result,/@must_use fn diagnosticHelper/);assert.match(result,/const retained=globalFn\(\)/);assert.doesNotMatch(result,/fn unused/);
});
test('comments, nested braces and helper-like names cannot invent dependencies or corrupt ranges',()=>{
  const comment='/* fn fake(){ /* nested } */ } */\n// fn fakeAgain() {\n',source=comment+'fn unused(){}\nfn helper()->f32{return 2.;}\n@compute @workgroup_size(1) fn main(){/* unused(); } */ let value=helper();}';
  const result=pruneWGSLFunctions(source);assert.ok(result.startsWith(comment));assert.doesNotMatch(result,/fn unused/);assert.match(result,/fn helper/);assert.match(result,/\/\* unused\(\); } \*\//);
  const identifier='fn keep(){}\n@compute @workgroup_size(1) fn main(){let keep=2;}';assert.equal(pruneWGSLFunctions(identifier),identifier);
});
test('unrecognized, incomplete and library-only source passes unchanged to compiler diagnostics',()=>{
  for(const source of ['fn a(){','fn unused(a:u32 {} @compute @workgroup_size(1) fn main(){}','/* incomplete','fn a(){}\nfn a(){}','fn library(){}','@compute fn main(){let x="unknown";}'])assert.equal(pruneWGSLFunctions(source),source);
});
