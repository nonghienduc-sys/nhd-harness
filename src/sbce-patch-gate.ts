/**
 * SBCE static L0 integrity guard for UNTRUSTED model code patches.
 * This is not a worktree build/test, and must never be counted as one.
 */
import { posix as path } from "node:path";
export type PatchCheck={ok:boolean;files:string[];violations:string[];staticOnly:true};
const protectedPrefixes=["test/","tests/","__tests__/","runtime/","releases/","deploy-backups/","skills/","electron/","node_modules/",".git/",".github/","scripts/","config/"];
const protectedFiles=new Set(["package.json","package-lock.json","tsconfig.json","CLAUDE.md","README.md",".env",".npmrc","src/terminal.ts","src/files.ts","src/task-authorization.ts","src/security.ts","src/config.ts","src/server.ts","src/mcp.ts","src/sbce-core.ts","src/sbce-provider.ts","src/sbce-patch-gate.ts"]);
const allowedExt=/\.(?:ts|tsx|js|mjs|cjs|md|json|css|html)$/i;
function normalize(raw:string):string|null{
 const s=raw.replaceAll("\\","/");
 if(!s||s.startsWith("/")||s.includes("\0")||/^[a-zA-Z]:/.test(s)||s.includes("%")||s.includes(":"))return null;
 const parts=s.split("/");
 if(parts.some(x=>x==="."||x===".."||!x||x.trim()!==x))return null;
 const value=path.normalize(parts.join("/"));
 if(value!==s||value.startsWith("../"))return null;
 return value;
}
function lockMatches(file:string,lock:string):boolean{
 const n=normalize(lock.replace(/\/\*$/, ""));
 return !!n&&(file===n||file.startsWith(n+"/"));
}
export function inspectSbcePatch(patchText:string,kind:"code_change"|"test_write",lockedPaths:string[]=[]):PatchCheck{
 const violations:string[]=[],files:string[]=[];
 if(!patchText||patchText.length>120000)violations.push("SBCE_PATCH_SIZE");
 if(patchText.includes("\0")||patchText.includes("\r"))violations.push("SBCE_PATCH_ENCODING");
 if(/\b(?:GIT binary patch|Binary files |literal \d+|delta \d+)\b/i.test(patchText))violations.push("SBCE_BINARY_PATCH");
 // Standard `git diff` headers are allowed: blob `index` lines and regular new files (mode 100644).
 // Deletes, renames, copies, mode changes and symlinks/executables stay denied.
 if(/^(?:deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to|similarity index|dissimilarity index)/m.test(patchText))violations.push("SBCE_METADATA_CHANGE");
 if(/^new file mode (?!100644$)/m.test(patchText))violations.push("SBCE_METADATA_CHANGE");
 const lines=patchText.split("\n");
 let inFile=false,hasHunk=false,current="",hasOld=false,hasNew=false,isNewFile=false;
 for(const line of lines){
  if(inFile&&!hasHunk&&!hasOld&&/^index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}(?: 100644)?$/.test(line)){/* git blob header */continue;}
  if(inFile&&!hasHunk&&!hasOld&&line==="new file mode 100644"){isNewFile=true;continue;}
  if(line.startsWith("diff --git ")){
   if(inFile&&(!hasHunk||!hasOld||!hasNew))violations.push("SBCE_PATCH_SECTION_INCOMPLETE");
   const m=/^diff --git a\/([^\s]+) b\/([^\s]+)$/.exec(line);
   if(!m||m[1]!==m[2]){violations.push("SBCE_DIFF_HEADER_INVALID");current="";continue;}
   const f=normalize(m[1]);if(!f){violations.push("SBCE_PATH_DENIED");continue;}
   current=f;inFile=true;hasHunk=false;hasOld=false;hasNew=false;isNewFile=false;files.push(f);
   const isTest=f.startsWith("test/")||f.startsWith("tests/")||f.endsWith(".test.ts")||f.endsWith(".test.mjs");
   if(protectedFiles.has(f)||protectedPrefixes.some(p=>f.startsWith(p))||f.toLowerCase().includes("secret")||f.includes(".env")){
    if(!(kind==="test_write"&&isTest))violations.push("SBCE_PROTECTED_PATH:"+f);
   }
   if(kind==="test_write"&&!isTest)violations.push("SBCE_TEST_SCOPE_REQUIRED:"+f);
   if(!allowedExt.test(f))violations.push("SBCE_EXTENSION_DENIED:"+f);
   if(lockedPaths.some(x=>lockMatches(f,x)))violations.push("SBCE_LOCKED_PATH:"+f);
  }else if(line.startsWith("--- ")||line.startsWith("+++ ")){
   if(!inFile||!current||!((line==="\u002d\u002d\u002d a/"+current)||(line==="+++ b/"+current)||(isNewFile&&line==="--- /dev/null")))violations.push("SBCE_PATCH_TARGET_MISMATCH");
   if(line.startsWith("--- "))hasOld=true;
   if(line.startsWith("+++ "))hasNew=true;
  }else if(line.startsWith("@@")){
   if(!inFile||!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line))violations.push("SBCE_PATCH_HUNK_INVALID");
   hasHunk=true;
  }else if(line.startsWith("\\ No newline at end of file")){/* accepted */}
  else if(line===""){/* accepted whitespace */}
  else if(!inFile||!hasHunk||![" ","+","-"].includes(line[0])){
   violations.push("SBCE_PATCH_LINE_INVALID");
  }else if(/^\+.*(?:\.skip\(|\.only\(|test\.skip|describe\.skip|assert\.equal\(true,false\))/.test(line)){
   violations.push("SBCE_TEST_TAMPERING");
  }
 }
 if(inFile&&(!hasHunk||!hasOld||!hasNew))violations.push("SBCE_PATCH_SECTION_INCOMPLETE");
 if(files.length===0)violations.push("SBCE_PATCH_EMPTY");
 if(files.length>20)violations.push("SBCE_PATCH_TOO_MANY_FILES");
 if(new Set(files).size!==files.length)violations.push("SBCE_PATCH_DUPLICATE_FILE");
 return {ok:violations.length===0,files,violations:[...new Set(violations)].slice(0,30),staticOnly:true};
}
