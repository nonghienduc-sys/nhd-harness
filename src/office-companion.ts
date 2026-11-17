import express from "express";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { WordLiveSessionPool, type WordSessionOptions } from "./word-live-sessions.js";

const config = loadConfig();
const app = express();
app.use(express.json({ limit: "4mb" }));
app.use((request, response, next) => {
  const supplied = String(request.header("x-workstation-companion-secret") ?? "");
  if (!config.companionSecret || supplied !== config.companionSecret) return response.status(401).json({ error: "Unauthorized Office Companion request." });
  next();
});

const supportedActions = new Set([
  "word_export_pdf", "excel_export_pdf", "powerpoint_export_pdf", "word_document_status",
  "word_selection_read", "word_selection_replace", "excel_selection_read", "powerpoint_selection_read",
  "word_inspect", "word_apply", "word_close", "word_sessions", "excel_inspect", "excel_apply", "powerpoint_inspect", "powerpoint_apply",
  "outlook_search", "outlook_read",
]);

type Pending = { resolve:(value:Record<string,unknown>)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout>; started:number };
class OfficeBridgeWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private starting: Promise<void> | null = null;
  private buffer = "";
  private stderr = "";
  private pending = new Map<string, Pending>();
  private requests = 0;
  private failures = 0;
  private lastRttMs: number | null = null;
  private startupMs: number | null = null;
  private pid: number | null = null;
  private readonly bridgePath = process.env.WORKSTATION_OFFICE_BRIDGE_PATH ? resolve(process.env.WORKSTATION_OFFICE_BRIDGE_PATH) : resolve(process.cwd(), "office", "office-bridge.ps1");
  private readonly workerPath = resolve(process.cwd(), "office", "office-bridge-worker.ps1");

  status() { return { persistent:true, online:Boolean(this.child && this.ready && this.child.exitCode == null), pid:this.pid, requests:this.requests, failures:this.failures, pending:this.pending.size, startupMs:this.startupMs, lastRttMs:this.lastRttMs, stderrTail:this.stderr.slice(-500) }; }
  async start(timeoutMs=8000) {
    if (this.child && this.ready && this.child.exitCode == null) return;
    if (this.starting) return this.starting;
    this.starting=this.startInner(timeoutMs).finally(()=>{this.starting=null});
    return this.starting;
  }
  private async startInner(timeoutMs:number) {
    this.stop(new Error("Office worker replaced before a new request was delivered."));
    const t0=Date.now(); this.ready=false; this.buffer=""; this.stderr="";
    const child=spawn("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","RemoteSigned","-File",this.workerPath,"-BridgePath",this.bridgePath],{cwd:process.cwd(),windowsHide:true,stdio:["pipe","pipe","pipe"]});
    this.child=child; this.pid=child.pid??null; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data",(chunk:string)=>this.consume(chunk)); child.stderr.on("data",(chunk:string)=>{this.stderr=(this.stderr+chunk).slice(-10000)});
    child.once("exit",(code,signal)=>{if(this.child!==child)return;this.child=null;this.ready=false;this.pid=null;const e=new Error(`Office persistent worker exited (code=${code??"null"}, signal=${signal??"null"}). Pending actions are not replayed.`);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e)}this.pending.clear()});
    while(Date.now()-t0<timeoutMs){if(this.ready&&this.child===child){this.startupMs=Date.now()-t0;return}if(child.exitCode!=null)throw new Error(`Office worker exited before ready: ${this.stderr.slice(-2000)}`);await new Promise(r=>setTimeout(r,15))}
    this.stop(new Error("Office worker readiness timeout.")); throw new Error(`Office worker did not become ready within ${timeoutMs} ms.`);
  }
  private consume(chunk:string){this.buffer+=chunk;while(true){const i=this.buffer.indexOf("\n");if(i<0)break;const line=this.buffer.slice(0,i).trim();this.buffer=this.buffer.slice(i+1);if(!line)continue;let msg:any;try{msg=JSON.parse(line)}catch{this.stderr=(this.stderr+`\n[stdout] ${line}`).slice(-10000);continue}if(msg.kind==="ready"){this.ready=true;this.pid=Number(msg.pid||this.pid)||this.pid;continue}if(msg.kind!=="response")continue;const id=String(msg.id||"");const p=this.pending.get(id);if(!p)continue;this.pending.delete(id);clearTimeout(p.timer);this.lastRttMs=Date.now()-p.started;if(msg.ok)p.resolve(msg.result as Record<string,unknown>);else{this.failures++;p.reject(new Error(String(msg.error||"Office worker request failed.")))}}}
  async request(action:string,input:Record<string,unknown>,timeoutMs=120000){await this.start();const child=this.child;if(!child||!this.ready)throw new Error("Office persistent worker is unavailable.");const id=`office-${randomBytes(10).toString("hex")}`;this.requests++;return new Promise<Record<string,unknown>>((resolvePromise,reject)=>{const timer=setTimeout(()=>{if(!this.pending.delete(id))return;this.failures++;reject(new Error(`Office worker command timed out: ${action}. The command is not replayed automatically.`))},Math.max(1000,Math.min(timeoutMs,120000)));this.pending.set(id,{resolve:resolvePromise,reject,timer,started:Date.now()});child.stdin.write(JSON.stringify({id,action,payloadJson:JSON.stringify(input)})+"\n","utf8",error=>{if(!error)return;const p=this.pending.get(id);if(!p)return;this.pending.delete(id);clearTimeout(p.timer);this.failures++;reject(new Error(`Office worker transport write failed; delivery may be ambiguous and is not replayed: ${error.message}`))})})}
  stop(reason=new Error("Office worker stopped.")){const child=this.child;this.child=null;this.ready=false;this.pid=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(reason)}this.pending.clear();if(child&&child.exitCode==null){try{child.kill()}catch{}}}
}

const bridgeWorker = new OfficeBridgeWorker();
const wordPool = new WordLiveSessionPool({
  externalWordDocuments: async () => {
    // Only reads Document.FullName via the existing legacy bridge. Never touches or closes user Word.
    try {
      const state = await bridgeWorker.request("word_documents_list", {});
      return Array.isArray(state.paths) ? state.paths.filter((p): p is string => typeof p === "string") : [];
    } catch { return []; } // FileShare.None still guards a document held by another process.
  },
});
void wordPool.cleanupOrphans().catch(error => console.error("Word Live orphan cleanup failed:", error));
const closeWordPool = () => { void wordPool.closeAll(); };
process.once("beforeExit", closeWordPool);
process.once("SIGTERM", () => { void wordPool.closeAll().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void wordPool.closeAll().finally(() => process.exit(0)); });
bridgeWorker.start().catch((error)=>console.error("Office worker prewarm failed:",error));

app.get("/status", async (_request, response) => {
  try {
    const status = await bridgeWorker.request("status", {}, 10000);
    response.json({
      word: status.winword, excel: status.excel, powerpoint: status.powerpnt, outlook: status.outlook,
      liveV2: true, protocolVersion: 3, persistentBridge: bridgeWorker.status(),
      capabilities: {
        word: ["inspect", "replace_selection", "insert_at_cursor", "append", "format_selection", "format_paragraph", "format_paragraph_range", "replace_paragraph", "format_document", "page_setup", "save", "transaction"],
        excel: ["inspect", "set_range", "set_formula", "format_range", "save", "transaction"],
        powerpoint: ["inspect", "replace_selected_text", "format_selected_text", "set_selected_shape_geometry", "save", "transaction"],
        outlook: ["search", "read"],
      },
    });
  } catch (error) { response.status(500).json({ error: error instanceof Error ? error.message : String(error), persistentBridge: bridgeWorker.status() }); }
});

app.post("/action", async (request, response) => {
  const action = String(request.body?.action ?? "");
  if (!supportedActions.has(action)) return response.status(400).json({ error: "Unsupported action." });
  try {
    const input = (request.body?.input ?? {}) as Record<string, unknown>;
    if (action === "word_sessions") { response.json({ sessions: wordPool.list(), maxInstances: wordPool.maxInstances }); return; }
    if (action === "word_close") {
      response.json(await wordPool.close(String(input.path ?? ""))); return;
    }
    if ((action === "word_inspect" || action === "word_apply") && typeof input.path === "string" && input.path) {
      const options: WordSessionOptions = {
        path: input.path, read_only: input.read_only === true,
        remove_stale_lock: input.remove_stale_lock === true,
      };
      response.json(await wordPool.request(action, options, input)); return;
    }
    response.json(await bridgeWorker.request(action, input));
  }
  catch (error) { response.status(500).json({ error: error instanceof Error ? error.message : String(error), persistentBridge: bridgeWorker.status() }); }
});

app.listen(config.officePort, "127.0.0.1", () => console.log(`Office Companion listening on ${config.officePort} with persistent bridge worker`));
