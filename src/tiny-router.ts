export type TinyRouteLabel = "rules" | "semantic" | "tiny" | "direct_tool" | "cloud";

export type TinyRoutePrediction = {
  label: TinyRouteLabel;
  confidence: number;
  marginPerGram: number;
  trainingExamples: number;
  featureCount: number;
};

const LABELS: TinyRouteLabel[] = ["rules", "semantic", "tiny", "direct_tool", "cloud"];

const TRAINING: Record<TinyRouteLabel, string[]> = {
  rules: [
    "Mở Word", "Mở Excel", "Mở PowerPoint", "Mở Cốc Cốc", "Kiểm tra kết nối MCP", "MCP status", "check health", "focus Word", "open folder", "activate Excel",
    "Open Word", "Focus Excel", "Mở thư mục", "Mở file", "Kiểm tra trạng thái MCP", "health status", "activate PowerPoint", "open project folder", "check connection", "Mở ứng dụng Word",
  ],
  semantic: [
    "Tìm file mới nhất", "Tìm project Quốc Anh", "Tiếp tục project ERC", "Khôi phục checkpoint", "Tìm memory", "Search latest document", "Find project file", "Tìm lịch sử chat", "resume project", "locate report",
    "Tìm file CMC", "Search project files", "Tìm checkpoint", "Tìm bản Word năm trước", "find latest PDF", "locate document", "search workspace memory", "resume previous project", "tìm tài liệu hôm qua", "tìm báo cáo gần nhất",
  ],
  tiny: [
    "Phân loại intent", "Gắn nhãn yêu cầu", "Nhận diện loại tài liệu", "Classify command", "Tag document", "Nhận diện domain", "classify intent", "label request", "tag request", "nhận diện loại tác vụ",
    "phân loại tool", "classify request type", "identify command class", "route intent", "nhận diện nhóm yêu cầu", "phân loại domain", "gắn nhãn tác vụ", "intent routing", "request classifier", "tool category classification",
  ],
  direct_tool: [
    "Mở file rồi sửa và kiểm tra", "Tìm file rồi đối chiếu rồi cập nhật", "Sửa format phần bôi đen rồi verify", "Đọc file rồi làm bước tiếp theo", "Plan local workflow", "Mở Word rồi chỉnh format", "Tìm tài liệu và điền bảng", "Kiểm tra rồi sửa rồi lưu", "Đọc hai file rồi so sánh", "Thực hiện task nhiều bước",
    "find file then edit and verify", "inspect then transform then verify", "mở project rồi tiếp tục công việc", "đọc file rồi phân tích rồi cập nhật", "tìm báo cáo rồi fill bảng", "plan three local steps", "kiểm tra project rồi sửa", "mở file sau đó chỉnh sửa", "đọc rồi đối chiếu rồi lưu", "continue current workstation task",
  ],
  cloud: [
    "Tóm tắt đoạn này", "Dịch đoạn văn", "Viết lại câu", "Sửa câu cho chuyên nghiệp", "Translate message", "Summarize report", "Rewrite paragraph", "Normalize text", "Rút gọn nội dung", "Chuyển văn phong",
    "tóm tắt email", "dịch sang tiếng Việt", "rewrite caption", "polish paragraph", "normalize formatting", "rút ý chính", "viết lại tin nhắn", "summarize text", "translate paragraph", "chuyển đoạn thành bullet",
    "Tìm trên mạng thông tin mới nhất", "Nghiên cứu paper AI", "Tìm tin hôm nay", "Phân tích pháp lý hiện hành", "Research latest news", "Tra web giá hiện tại", "Nghiên cứu thị trường", "Tìm quy định mới nhất", "Deep financial analysis", "Research current AI models",
    "nghiên cứu chuyên sâu có nguồn", "search web latest", "current political news", "latest scientific research", "tìm benchmark model mới nhất", "research current regulations", "tìm tin tức AI hôm nay", "so sánh model hiện tại", "tra trên mạng", "nghiên cứu paper mới nhất",
  ],
};

function normalizeAscii(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function grams(value: string, n = 3): string[] {
  const text = `__${normalizeAscii(value)}__`;
  const out: string[] = [];
  for (let i = 0; i <= text.length - n; i += 1) out.push(text.slice(i, i + n));
  return out;
}

export class TinyRouteClassifier {
  private readonly labelDocs = new Map<TinyRouteLabel, number>();
  private readonly counts = new Map<TinyRouteLabel, Map<string, number>>();
  private readonly totals = new Map<TinyRouteLabel, number>();
  private readonly vocab = new Set<string>();
  private readonly totalDocs: number;
  readonly trainingExamples: number;

  constructor() {
    let docs = 0;
    for (const label of LABELS) {
      const rows = TRAINING[label];
      this.labelDocs.set(label, rows.length);
      docs += rows.length;
      const counts = new Map<string, number>();
      let total = 0;
      for (const row of rows) {
        for (const gram of grams(row)) {
          counts.set(gram, (counts.get(gram) ?? 0) + 1);
          this.vocab.add(gram);
          total += 1;
        }
      }
      this.counts.set(label, counts);
      this.totals.set(label, total);
    }
    this.totalDocs = docs;
    this.trainingExamples = docs;
  }

  predict(text: string): TinyRoutePrediction {
    const features = grams(text);
    const scored = LABELS.map((label) => {
      const prior = Math.log(((this.labelDocs.get(label) ?? 0) + 1) / (this.totalDocs + LABELS.length));
      const counts = this.counts.get(label) ?? new Map<string, number>();
      const denominator = (this.totals.get(label) ?? 0) + this.vocab.size;
      let score = prior;
      for (const gram of features) score += Math.log(((counts.get(gram) ?? 0) + 1) / denominator);
      return { label, score };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    const second = scored[1];
    const marginPerGram = (best.score - second.score) / Math.max(1, features.length);
    const confidence = Math.max(0.64, Math.min(0.93, 0.68 + marginPerGram * 2.4));
    return {
      label: best.label,
      confidence,
      marginPerGram,
      trainingExamples: this.trainingExamples,
      featureCount: features.length,
    };
  }
}
