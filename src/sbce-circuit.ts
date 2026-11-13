/** HH Tech request circuit. Three transient failures open for five minutes. */
export class SbceCircuit{
 private failures=0;
 private openUntil=0;
 constructor(private readonly clock:()=>number=Date.now){}
 get state(){const open=this.clock()<this.openUntil;return {open,consecutiveFailures:this.failures,retryAfterMs:open?this.openUntil-this.clock():0};}
 beforeRequest(){if(this.clock()<this.openUntil)throw Error("SBCE_PROVIDER_CIRCUIT_OPEN");}
 success(){this.failures=0;this.openUntil=0;}
 failure(reason:number|"timeout"){if(reason==="timeout"||reason===429||reason>=500){
  this.failures++;
  if(this.failures>=3){this.openUntil=this.clock()+5*60_000;this.failures=0;}
 }}
}
