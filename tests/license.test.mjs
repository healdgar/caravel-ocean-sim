import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
test('source and standalone distributions retain MIT copyright and upstream notices',async()=>{
  const license=await readFile(new URL('../LICENSE',import.meta.url),'utf8');
  assert.ok(license.includes('Copyright (c) 2026 Alex Wall / Six Cailloux, LLC'));
  assert.ok(license.includes('Original web-ocean water simulation: Copyright (c) 2026 Maksymilian Dendura'));
  assert.ok(license.includes('Permission is hereby granted, free of charge'));
  for(const file of ['ocean.html','ocean.min.html','docs/index.html']){
    const page=await readFile(new URL('../'+file,import.meta.url),'utf8');
    assert.ok(page.includes(license),file+' retains the full MIT notice');
    assert.ok(page.includes('Copyright (c) 2025 Joshua Brewster'),file+' retains adapted cloud attribution');
  }
});
