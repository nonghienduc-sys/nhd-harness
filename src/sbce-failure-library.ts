/** Failure signatures are bounded metadata, never raw prompts or secrets. */
import { createHash } from "node:crypto";
export type FailureSignature={taskClass:string;code:string;fingerprint:string};
export function canonicalFailureCode(code:string):string{
 const normalized=String(code).toUpperCase().replace(/[^A-Z0-9_]/g,"_").replace(/_+/g,"_").slice(0,80);
 return normalized||"UNKNOWN";
}
export function makeFailureSignature(taskClass:string,code:string,diagnostic:string):FailureSignature{
 if(!/^[a-z_]{3,32}$/.test(taskClass))throw Error("SBCE_FAILURE_TASK_CLASS_INVALID");
 const clean=canonicalFailureCode(code);
 const minimal=String(diagnostic).replace(/[a-zA-Z]:[\\\/][^\s]+/g,"PATH")
  .replace(/[0-9a-f]{20,}/gi,"HASH").replace(/\d+/g,"N").slice(0,300);
 const fingerprint=createHash("sha256").update(taskClass+"\n"+clean+"\n"+minimal).digest("hex");
 return{taskClass,code:clean,fingerprint};
}
