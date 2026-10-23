// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// WGSL has no function pointers. Drop only unreachable, unannotated helpers;
// retain every entry point and all globals/types/constants/overrides verbatim.
export function pruneWGSLFunctions(code){
  let masked='',copied=0;
  for(let i=0;i<code.length;i++){
    if(code[i]==='"')return code; // Unknown syntax: leave it to the compiler.
    if(code[i]!=='/'||!['/','*'].includes(code[i+1]))continue;
    const start=i;masked+=code.slice(copied,start);
    if(code[i+1]==='/'){i=code.indexOf('\n',i+2);if(i<0)i=code.length;}
    else{
      let depth=1;i+=2;
      while(i<code.length&&depth){
        if(code[i]==='/'&&code[i+1]==='*'){depth++;i+=2;}
        else if(code[i]==='*'&&code[i+1]==='/'){depth--;i+=2;}else i++;
      }
      if(depth)return code;
    }
    masked+=code.slice(start,i).replace(/[^\r\n]/g,' ');copied=i;i--;
  }
  masked+=code.slice(copied);
  const functions=[],names=new Map();let previous=0;
  for(const match of masked.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*\(/g)){
    const start=match.index,open=masked.indexOf('{',start);if(open<0||start<previous||names.has(match[1]))return code;
    let parentheses=0;for(const char of masked.slice(start,open)){if(char==='(')parentheses++;else if(char===')'&&--parentheses<0)return code;}
    if(parentheses)return code;
    let end=open+1,depth=1;while(end<masked.length&&depth){if(masked[end]==='{')depth++;else if(masked[end]==='}')depth--;end++;}
    if(depth)return code;
    const prefix=masked.slice(previous,start),boundary=Math.max(prefix.lastIndexOf(';'),prefix.lastIndexOf('}'));
    const annotated=prefix.slice(boundary+1).includes('@')||masked.slice(start,open).includes('@');
    const item={name:match[1],start,end,annotated,body:masked.slice(start,end)};functions.push(item);names.set(item.name,item);previous=end;
  }
  if(!functions.length||[...masked.matchAll(/\bfn\b/g)].length!==functions.length)return code;
  // References in global declarations/initializers are roots too. Keeping any
  // matching identifier, not just calls, errs toward retaining extra helpers.
  let outside='',cursor=0;for(const item of functions){outside+=masked.slice(cursor,item.start);cursor=item.end;}outside+=masked.slice(cursor);
  const live=new Set(),pending=[];
  const visit=text=>{for(const token of text.matchAll(/\b[A-Za-z_]\w*\b/g))if(names.has(token[0])&&!live.has(token[0])){live.add(token[0]);pending.push(names.get(token[0]));}};
  for(const item of functions)if(item.annotated){live.add(item.name);pending.push(item);}
  visit(outside);if(!pending.length)return code;
  while(pending.length)visit(pending.pop().body);
  let result='';cursor=0;
  for(const item of functions)if(!live.has(item.name)){result+=code.slice(cursor,item.start);cursor=item.end;}
  return result+code.slice(cursor);
}
