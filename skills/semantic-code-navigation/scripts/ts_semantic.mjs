import ts from 'typescript';
import {readFileSync, existsSync} from 'node:fs';
import {resolve, relative, dirname} from 'node:path';

function arg(name, def=null){ const i=process.argv.indexOf(name); return i>=0 ? process.argv[i+1] : def; }
const action=process.argv[2];
const root=resolve(arg('--project',process.cwd()));
const limit=Math.max(1,Math.min(Number(arg('--limit','100'))||100,500));

function loadProject(projectRoot){
  const configPath=ts.findConfigFile(projectRoot,ts.sys.fileExists,'tsconfig.json');
  if(!configPath) throw new Error(`tsconfig.json not found under ${projectRoot}`);
  const raw=ts.readConfigFile(configPath,ts.sys.readFile);
  if(raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText,'\n'));
  const parsed=ts.parseJsonConfigFileContent(raw.config,ts.sys,dirname(configPath));
  const versions=new Map();
  const host={
    getScriptFileNames:()=>parsed.fileNames,
    getScriptVersion:(file)=>String(versions.get(file)||0),
    getScriptSnapshot:(file)=>{ if(!existsSync(file)) return undefined; return ts.ScriptSnapshot.fromString(readFileSync(file,'utf8')); },
    getCurrentDirectory:()=>projectRoot,
    getCompilationSettings:()=>parsed.options,
    getDefaultLibFileName:(opts)=>ts.getDefaultLibFilePath(opts),
    fileExists:ts.sys.fileExists,
    readFile:ts.sys.readFile,
    readDirectory:ts.sys.readDirectory,
    directoryExists:ts.sys.directoryExists,
    getDirectories:ts.sys.getDirectories,
    useCaseSensitiveFileNames:()=>ts.sys.useCaseSensitiveFileNames,
    getNewLine:()=>ts.sys.newLine,
  };
  return {service:ts.createLanguageService(host,ts.createDocumentRegistry()),parsed,configPath};
}

function loc(sf,pos){ const p=sf.getLineAndCharacterOfPosition(pos); return {line:p.line+1,column:p.character+1}; }
function rel(file){ return relative(root,file).replaceAll('\\','/'); }
function textSpan(sf,span){ const start=span?.start??0; const len=span?.length??0; return sf.text.slice(start,start+len).replace(/\s+/g,' ').trim().slice(0,260); }
function isDeclarationIdentifier(node){
  const p=node.parent;
  return !!p && (
    (ts.isFunctionDeclaration(p)&&p.name===node) ||
    (ts.isClassDeclaration(p)&&p.name===node) ||
    (ts.isInterfaceDeclaration(p)&&p.name===node) ||
    (ts.isTypeAliasDeclaration(p)&&p.name===node) ||
    (ts.isEnumDeclaration(p)&&p.name===node) ||
    (ts.isVariableDeclaration(p)&&p.name===node) ||
    (ts.isMethodDeclaration(p)&&p.name===node) ||
    (ts.isPropertyDeclaration(p)&&p.name===node) ||
    (ts.isGetAccessorDeclaration(p)&&p.name===node) ||
    (ts.isSetAccessorDeclaration(p)&&p.name===node)
  );
}
function kindOf(node){
  const p=node.parent;
  if(ts.isFunctionDeclaration(p)) return 'function';
  if(ts.isClassDeclaration(p)) return 'class';
  if(ts.isInterfaceDeclaration(p)) return 'interface';
  if(ts.isTypeAliasDeclaration(p)) return 'type';
  if(ts.isEnumDeclaration(p)) return 'enum';
  if(ts.isVariableDeclaration(p)) return 'variable';
  if(ts.isMethodDeclaration(p)) return 'method';
  if(ts.isPropertyDeclaration(p)) return 'property';
  if(ts.isGetAccessorDeclaration(p)||ts.isSetAccessorDeclaration(p)) return 'accessor';
  return 'symbol';
}
function declarations(parsed,name=null,fileFilter=null){
  const out=[];
  for(const file of parsed.fileNames){
    if(fileFilter && resolve(file)!==resolve(fileFilter)) continue;
    const text=readFileSync(file,'utf8');
    const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
    function visit(node){
      if(ts.isIdentifier(node)&&isDeclarationIdentifier(node)&&(!name||node.text===name)){
        const at=loc(sf,node.getStart(sf));
        out.push({name:node.text,kind:kindOf(node),file:rel(file),line:at.line,column:at.column,preview:node.parent.getText(sf).replace(/\s+/g,' ').slice(0,320)});
      }
      ts.forEachChild(node,visit);
    }
    visit(sf);
  }
  return out;
}
function source(service,file){ const p=service.getProgram()?.getSourceFile(file); if(!p) throw new Error(`Source not in program: ${file}`); return p; }
function firstDeclarationPosition(service,parsed,name){
  for(const d of declarations(parsed,name)){
    const file=resolve(root,d.file); const sf=source(service,file);
    const pos=ts.getPositionOfLineAndCharacter(sf,d.line-1,d.column-1);
    return {file,pos,declaration:d};
  }
  return null;
}
function refRow(service,entry){
  const sf=source(service,entry.fileName); const at=loc(sf,entry.textSpan.start);
  return {file:rel(entry.fileName),line:at.line,column:at.column,isDefinition:!!entry.isDefinition,isWriteAccess:!!entry.isWriteAccess,preview:textSpan(sf,entry.textSpan)};
}

const {service,parsed,configPath}=loadProject(root);
let result;
if(action==='find'){
  const name=arg('--name'); if(!name) throw new Error('--name is required');
  result={action,project:root,config:rel(configPath),name,results:declarations(parsed,name).slice(0,limit)};
}else if(action==='references'){
  const name=arg('--name'); if(!name) throw new Error('--name is required');
  const first=firstDeclarationPosition(service,parsed,name);
  if(!first) result={action,project:root,name,definitions:[],references:[]};
  else{
    const groups=service.findReferences(first.file,first.pos)||[];
    const defs=[]; const refs=[];
    for(const g of groups){
      const sf=source(service,g.definition.fileName); const at=loc(sf,g.definition.textSpan.start);
      defs.push({file:rel(g.definition.fileName),line:at.line,column:at.column,name:g.definition.name,kind:g.definition.kind,preview:textSpan(sf,g.definition.textSpan)});
      for(const r of g.references) refs.push(refRow(service,r));
    }
    const unique=[]; const seen=new Set();
    for(const r of refs){const k=`${r.file}:${r.line}:${r.column}`;if(!seen.has(k)){seen.add(k);unique.push(r);}}
    result={action,project:root,name,definitions:defs.slice(0,limit),references:unique.slice(0,limit),totalReferences:unique.length};
  }
}else if(action==='outline'){
  const fileArg=arg('--file'); if(!fileArg) throw new Error('--file is required');
  const file=resolve(root,fileArg); result={action,project:root,file:rel(file),symbols:declarations(parsed,null,file).slice(0,limit)};
}else if(action==='quickinfo'){
  const fileArg=arg('--file'); const line=Number(arg('--line')); const column=Number(arg('--column'));
  if(!fileArg||!line||!column) throw new Error('--file --line --column are required');
  const file=resolve(root,fileArg); const sf=source(service,file); const pos=ts.getPositionOfLineAndCharacter(sf,line-1,column-1);
  const q=service.getQuickInfoAtPosition(file,pos);
  result={action,project:root,file:rel(file),line,column,kind:q?.kind??null,display:q?ts.displayPartsToString(q.displayParts):null,documentation:q?ts.displayPartsToString(q.documentation):null};
}else if(action==='definition'){
  const fileArg=arg('--file'); const line=Number(arg('--line')); const column=Number(arg('--column'));
  if(!fileArg||!line||!column) throw new Error('--file --line --column are required');
  const file=resolve(root,fileArg); const sf=source(service,file); const pos=ts.getPositionOfLineAndCharacter(sf,line-1,column-1);
  const defs=service.getDefinitionAtPosition(file,pos)||[];
  result={action,project:root,file:rel(file),line,column,definitions:defs.slice(0,limit).map(d=>{const dsf=source(service,d.fileName);const at=loc(dsf,d.textSpan.start);return{file:rel(d.fileName),line:at.line,column:at.column,name:d.name,kind:d.kind,preview:textSpan(dsf,d.textSpan)}})};
}else{
  throw new Error('Usage: ts_semantic.mjs <find|references|outline|quickinfo|definition> [options]');
}
console.log(JSON.stringify(result,null,2));
