/** Windows CurrentUser DPAPI vault. Secrets travel on child stdin, never command args/env/logs. */
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
const entropy="NHD-SBCE-v1";
function powershell(mode:"protect"|"unprotect",text:string):Promise<string>{
 if(process.platform!=="win32")return Promise.reject(Error("SBCE_DPAPI_WINDOWS_ONLY"));
 if(text.length>4096) return Promise.reject(Error("SBCE_SECRET_LENGTH_EXCEEDED"));
 const code=mode==="protect"
  ? "Add-Type -AssemblyName System.Security;$ErrorActionPreference='Stop';$b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());$e=[Text.Encoding]::UTF8.GetBytes('"+entropy+"');$v=[Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($v));"
  : "Add-Type -AssemblyName System.Security;$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());$e=[Text.Encoding]::UTF8.GetBytes('"+entropy+"');$v=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($v));";
 return new Promise((accept,reject)=>{
  const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",code],{stdio:["pipe","pipe","pipe"],windowsHide:true});
  let output="",size=0;
  const timer=setTimeout(()=>child.kill(),8000);
  child.stdout.setEncoding("utf8");child.stdout.on("data",s=>{size+=s.length;if(size<8192)output+=s;else child.kill();});
  child.stderr.resume(); // Never reveal PowerShell stderr (may include secret snippets).
  child.on("error",()=>{clearTimeout(timer);reject(Error("SBCE_DPAPI_PROCESS_ERROR"));});
  child.on("close",c=>{
   clearTimeout(timer);
   if(c!==0||size>=8192)return reject(Error("SBCE_DPAPI_OPERATION_FAILED"));
   accept(output.trim());
  });
  child.stdin.end(text,"utf8");
 });
}
export class SbceVault{
 readonly path:string;
 constructor(dataDir:string){this.path=resolve(dataDir,"vault","sbce-hhtech.bin");}
 configured(){return existsSync(this.path);}
 async save(secret:string):Promise<void>{
  if(typeof secret!=="string"||secret.length<12||secret.length>300)throw Error("SBCE_INVALID_KEY");
  const encoded=await powershell("protect",secret);
  if(!/^[A-Za-z0-9+/=]{20,}$/.test(encoded))throw Error("SBCE_DPAPI_OPERATION_FAILED");
  mkdirSync(dirname(this.path),{recursive:true});
  const tmp=this.path+"."+randomBytes(5).toString("hex")+".tmp";
  writeFileSync(tmp,encoded,{encoding:"utf8",mode:0o600});
  renameSync(tmp,this.path);
 }
 async load():Promise<string|null>{
  if(!this.configured())return null;
  const encoded=readFileSync(this.path,"utf8").trim();
  if(!/^[A-Za-z0-9+/=]{20,}$/.test(encoded))throw Error("SBCE_VAULT_CORRUPT");
  return powershell("unprotect",encoded);
 }
}
