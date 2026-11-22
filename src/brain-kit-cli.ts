import { loadConfig } from "./config.js";
import { brainStart, defaultPublicKnowledgeDir } from "./brain-kit.js";
import { analyzeLessons, listLessons } from "./lesson-loop.js";
import { resolve } from "node:path";
import { PlaybookRunner, terminalGateExecutor, type PlaybookInput } from "./playbook-runner.js";
import { Store } from "./db.js";
import { FileService } from "./files.js";
import { TerminalService } from "./terminal.js";
const argv = process.argv.slice(2);
if (argv[0] === "quy_trinh_chay") {
  void (async () => {
    const op = argv[1] as PlaybookInput["op"];
    if (!["start","next","done_step","status","list","abort"].includes(op)) throw Error("Unknown playbook operation");
    const flag = (key: string) => { const i=argv.indexOf(key); return i < 0 ? undefined : argv[i+1]; };
    const rawVars=flag("--bien");
    const input: PlaybookInput = {
      op, run_id:flag("--run-id"), quy_trinh_id:flag("--quy-trinh-id"),
      muc_tieu:flag("--muc-tieu"), bien:rawVars ? JSON.parse(rawVars) : undefined,
      so:flag("--so") === undefined ? undefined : Number(flag("--so")),
      ghi_chu:flag("--ghi-chu"), ly_do:flag("--ly-do"),
      trang_thai:flag("--trang-thai"),task_run_id:flag("--task-run-id"),
    };
    const config=loadConfig(), store=new Store();
    try {
      const files=new FileService(config,store),terminal=new TerminalService(config,store,files);
      const runner=new PlaybookRunner({
        dataDir:config.dataDir,knowledge:{
          publicDir:defaultPublicKnowledgeDir(),
          localDir:resolve(process.env.NHD_KNOWLEDGE_LOCAL_DIR ?? config.knowledgeLocalDir ?? resolve(config.dataDir,"knowledge-local")),
        },executeGate:terminalGateExecutor(terminal)
      });
      const output=await runner.handle(input);
      process.stdout.write(JSON.stringify(output,null,2)+"\n");
    } finally { store.db.close(); }
  })().catch(err => {
    process.stderr.write((err instanceof Error ? err.message : String(err))+"\n");
    process.exitCode=1;
  });
} else if (argv[0] === "bai_hoc") {
  try {
    if (!["analyze", "list"].includes(argv[1] ?? "")) throw new Error("Usage: bai_hoc analyze|list [--json]");
    const config = loadConfig();
    const localDir = resolve(process.env.NHD_KNOWLEDGE_LOCAL_DIR ?? config.knowledgeLocalDir ?? resolve(config.dataDir, "knowledge-local"));
    const output = argv[1] === "analyze" ? { groups: analyzeLessons(localDir) } : { lessons: listLessons(localDir) };
    process.stdout.write(JSON.stringify(output, null, argv.includes("--json") ? 2 : undefined) + "\n");
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  }
} else if (argv[0] !== "brain_start" || !argv[1]) {
  process.stderr.write('Usage: node dist/brain-kit-cli.js brain_start "<yêu cầu>" [--json] [--project-root path]\n');
  process.exitCode = 2;
} else {
  try {
    const config = loadConfig();
    const rootAt = argv.indexOf("--project-root");
    const project_root = rootAt >= 0 ? argv[rootAt + 1] : undefined;
    const maxAt = argv.indexOf("--max-chars");
    const max_chars = maxAt >= 0 ? Number(argv[maxAt + 1]) : undefined;
    const output = brainStart({ yeu_cau: argv[1], project_root, max_chars }, {
      publicDir: defaultPublicKnowledgeDir(),
      localDir: resolve(process.env.NHD_KNOWLEDGE_LOCAL_DIR ?? config.knowledgeLocalDir ?? resolve(config.dataDir, "knowledge-local")),
    });
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  }
}
