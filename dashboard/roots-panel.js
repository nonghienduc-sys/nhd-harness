// Local-only dashboard roots editor. It does not expose MCP capabilities.
(() => {
  const el = (id) => document.getElementById(id);
  const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const state = { drives: [], defaults: [], selected: [] };
  const key = (path) => String(path).toLowerCase();
  function feedback(message, error = false) {
    const target = el("rootsFeedback");
    target.textContent = message;
    target.className = "small mt-2 " + (error ? "text-danger" : "text-success");
  }
  function render() {
    el("rootsDrives").innerHTML = state.drives.map((drive) => {
      const checked = state.selected.some((path) => key(path) === key(drive.path));
      const size = drive.sizeBytes ? " · " + (drive.sizeBytes / 1073741824).toFixed(0) + " GB" : "";
      return '<label class="form-check form-check-inline me-3"><input class="form-check-input roots-drive" type="checkbox" value="' +
        escapeHtml(drive.path) + '"' + (checked ? " checked" : "") + '><span class="form-check-label">' +
        escapeHtml(drive.path + (drive.label ? " — " + drive.label : "") + size) + "</span></label>";
    }).join("") || '<span class="text-secondary">Không phát hiện ổ cố định.</span>';
    const isDrive = (path) => state.drives.some((drive) => key(drive.path) === key(path));
    el("rootsFolders").innerHTML = state.selected.filter((path) => !isDrive(path)).map((path) =>
      '<div class="d-flex align-items-center gap-2 mb-2"><code class="flex-fill text-break">' + escapeHtml(path) +
      '</code><button type="button" class="btn btn-sm btn-outline-danger roots-remove" data-path="' +
      escapeHtml(path) + '">Xóa</button></div>').join("") ||
      '<div class="text-secondary small">Chưa thêm thư mục riêng.</div>';
    const warning = state.drives.some((drive) => drive.isSystem &&
      state.selected.some((path) => key(path) === key(drive.path)));
    el("rootsSystemWarning").classList.toggle("d-none", !warning);
    el("rootsSave").disabled = state.selected.length === 0;
    document.querySelectorAll(".roots-drive").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) state.selected.push(input.value);
        else if (state.selected.length === 1) {
          input.checked = true;
          feedback("Phải giữ ít nhất một ổ hoặc thư mục được phép.", true);
          return;
        } else state.selected = state.selected.filter((path) => key(path) !== key(input.value));
        render();
      });
    });
    document.querySelectorAll(".roots-remove").forEach((button) => {
      button.addEventListener("click", () => {
        if (state.selected.length === 1) return feedback("Phải giữ ít nhất một ổ hoặc thư mục được phép.", true);
        state.selected = state.selected.filter((path) => path !== button.dataset.path);
        render();
      });
    });
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Không thể cập nhật quyền.");
    return payload;
  }
  async function load() {
    try {
      const result = await request("/api/roots");
      state.drives = result.drives || [];
      state.defaults = result.defaults || [];
      state.selected = [...(result.roots || [])];
      render();
    } catch (error) { feedback("Không tải được danh sách ổ: " + error.message, true); }
  }
  window.loadRootsPanel = load;
  el("rootsAdd").addEventListener("click", () => {
    const value = el("rootsFolderInput").value.trim();
    if (!value) return feedback("Hãy nhập đường dẫn thư mục.", true);
    if (!state.selected.some((path) => key(path) === key(value))) state.selected.push(value);
    el("rootsFolderInput").value = "";
    feedback("Đã thêm vào biểu mẫu; bấm Lưu để áp dụng.");
    render();
  });
  el("rootsFolderInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); el("rootsAdd").click(); }
  });
  el("rootsDefault").addEventListener("click", () => {
    state.selected = [...state.defaults];
    render();
    feedback("Đã điền giá trị mặc định. Chưa lưu thay đổi.");
  });
  el("rootsSave").addEventListener("click", async () => {
    if (!state.selected.length) return feedback("Phải chọn ít nhất một ổ hoặc thư mục.", true);
    el("rootsSave").disabled = true;
    try {
      const saved = await request("/api/roots", { method: "PUT", body: JSON.stringify({ roots: state.selected }) });
      state.selected = [...saved.roots];
      render();
      feedback("Đã lưu và áp dụng ngay " + saved.roots.length + " ổ/thư mục.");
    } catch (error) { render(); feedback("Lưu không thành công: " + error.message, true); }
  });
  if (el("rootsCard")) load();
})();
