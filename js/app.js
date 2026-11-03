"use strict";

const $ = id => document.getElementById(id);

// -----------------------------------------------------------------------------
// Editor, file management, and popups
// -----------------------------------------------------------------------------
const STORAGE_CODE = "cellular.code.v1";
const STORAGE_NAME = "cellular.filename.v1";
const LEGACY_STORAGE_CODE = "gridlang.code.v1";
const LEGACY_STORAGE_NAME = "gridlang.filename.v1";
const ACTIVE_FILE_STORAGE = "cellular.activeFileId.v1";
const FILE_DB_NAME = "cpl-local-files";
const FILE_DB_STORE = "programs";
let fileDbPromise = null;
let activeFileId = "";
let currentFileName = "program.cpl";
let savedSnapshot = null;
let currentIsDirty = false;
let fileNotice = "Ready";
let saveTimer = 0;

function cleanFileName(value) {
  let name = String(value || "").trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "-");
  name = name.replace(/^\.+$/, "");
  if (!name) name = "program.cpl";
  if (/\.grid$/i.test(name)) name = name.replace(/\.grid$/i, ".cpl");
  else if (!/\.[a-z0-9]{1,12}$/i.test(name)) name += ".cpl";
  return name.slice(0, 180);
}
function makeFileId() {
  try { if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID(); } catch (_) {}
  return "cpl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
function openFileDatabase() {
  if (fileDbPromise) return fileDbPromise;
  fileDbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error("IndexedDB is not available in this browser.")); return; }
    const request = indexedDB.open(FILE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_DB_STORE)) {
        const store = db.createObjectStore(FILE_DB_STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the local file database."));
    request.onblocked = () => reject(new Error("The local file database is blocked by another open tab."));
  });
  return fileDbPromise;
}
function fileDbRequest(mode, action) {
  return openFileDatabase().then(db => new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(FILE_DB_STORE, mode); }
    catch (error) { reject(error); return; }
    const request = action(tx.objectStore(FILE_DB_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Local file database operation failed."));
    tx.onabort = () => reject(tx.error || new Error("Local file database transaction was aborted."));
  }));
}
const putSavedRecord = record => fileDbRequest("readwrite", store => store.put(record));
const getSavedRecord = id => fileDbRequest("readonly", store => store.get(id));
const getSavedRecords = () => fileDbRequest("readonly", store => store.getAll());
const deleteSavedRecord = id => fileDbRequest("readwrite", store => store.delete(id));

async function persistActiveFile() {
  if (!activeFileId) activeFileId = makeFileId();
  try { localStorage.setItem(ACTIVE_FILE_STORAGE, activeFileId); } catch (_) {}
  const record = { id: activeFileId, name: currentFileName, code: Editor.getValue(), updatedAt: Date.now() };
  try {
    await putSavedRecord(record);
    if (!$("localFilesModal").hidden) renderSavedFileList();
  } catch (error) {
    fileNotice = "IndexedDB unavailable · recovery remains in browser storage";
    updateFileUi();
  }
}

async function renderSavedFileList() {
  const host = $("localFileList");
  if (!host) return;
  host.replaceChildren();
  try {
    const records = (await getSavedRecords()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!records.length) {
      const empty = document.createElement("div");
      empty.className = "saved-file-empty";
      empty.textContent = "No saved programs yet.";
      host.appendChild(empty);
      return;
    }
    for (const record of records) {
      const row = document.createElement("div");
      row.className = "saved-file-row" + (record.id === activeFileId ? " active" : "");
      const name = document.createElement("button");
      name.type = "button"; name.className = "saved-file-name";
      name.textContent = record.name || "untitled.cpl";
      name.title = "Open " + (record.name || "untitled.cpl");
      name.addEventListener("click", () => openSavedFile(record.id));
      row.appendChild(name);
      const actions = [
        ["↗", "Edit / open", () => openSavedFile(record.id)],
        ["✎", "Rename", () => renameSavedFile(record.id)],
        ["↓", "Download", () => downloadSavedRecord(record.id === activeFileId
          ? { ...record, name: currentFileName, code: Editor.getValue() } : record)],
        ["×", "Delete", () => removeSavedFile(record.id)]
      ];
      for (const [symbol, title, action] of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "saved-file-action" + (title === "Delete" ? " delete" : "");
        button.textContent = symbol;
        button.title = title;
        button.setAttribute("aria-label", title + " " + (record.name || "program"));
        button.addEventListener("click", action);
        row.appendChild(button);
      }
      host.appendChild(row);
    }
  } catch (error) {
    const note = document.createElement("div");
    note.className = "saved-file-empty";
    note.textContent = "Could not read IndexedDB: " + (error.message || error);
    host.appendChild(note);
  }
}

function activateSavedRecord(record, notice = "Opened from local storage") {
  activeFileId = record.id;
  try { localStorage.setItem(ACTIVE_FILE_STORAGE, activeFileId); } catch (_) {}
  currentFileName = cleanFileName(record.name);
  Editor.setValue(record.code || "");
  savedSnapshot = Editor.getValue();
  currentIsDirty = false;
  fileNotice = notice;
  storeCurrentToBrowser(true);
  updateFileUi();
  closeFileMenu(false);
  closeLocalFilesModal(false);
}

async function openSavedFile(id) {
  try {
    await persistActiveFile();
    const record = await getSavedRecord(id);
    if (!record) { fileNotice = "That saved program no longer exists."; updateFileUi(); await renderSavedFileList(); return; }
    activateSavedRecord(record);
    await renderSavedFileList();
  } catch (error) {
    fileNotice = "Could not open saved file: " + (error.message || error);
    updateFileUi();
  }
}

async function createSavedFile(name, code = "", persistCurrent = true) {
  if (persistCurrent) await persistActiveFile();
  activeFileId = makeFileId();
  currentFileName = cleanFileName(name);
  Editor.setValue(code);
  savedSnapshot = Editor.getValue();
  currentIsDirty = false;
  fileNotice = "Created new local program";
  try { localStorage.setItem(ACTIVE_FILE_STORAGE, activeFileId); } catch (_) {}
  storeCurrentToBrowser(true);
  await renderSavedFileList();
}

function downloadSavedRecord(record) {
  const blob = new Blob([record.code || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = cleanFileName(record.name); a.style.display = "none";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

async function renameSavedFile(id) {
  try {
    if (id === activeFileId) await persistActiveFile();
    const record = await getSavedRecord(id);
    if (!record) return;
    const name = window.prompt("Rename program", record.name || "untitled.cpl");
    if (name === null) return;
    record.name = cleanFileName(name);
    record.updatedAt = Date.now();
    await putSavedRecord(record);
    if (id === activeFileId) {
      currentFileName = record.name;
      try { localStorage.setItem(STORAGE_NAME, currentFileName); } catch (_) {}
      updateFileUi();
    }
    await renderSavedFileList();
  } catch (error) { window.alert("Could not rename file: " + (error.message || error)); }
}

async function removeSavedFile(id) {
  const record = await getSavedRecord(id).catch(() => null);
  if (!record || !window.confirm("Delete " + (record.name || "this program") + " from local storage?")) return;
  try {
    const deletingActive = id === activeFileId;
    if (!deletingActive) await persistActiveFile();
    await deleteSavedRecord(id);
    if (deletingActive) {
      const rest = (await getSavedRecords()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (rest.length) activateSavedRecord(rest[0], "Switched to another local program");
      else {
        activeFileId = "";
        await createSavedFile("untitled.cpl", "", false);
      }
    }
    await renderSavedFileList();
  } catch (error) { window.alert("Could not delete file: " + (error.message || error)); }
}

async function initializeFileLibrary() {
  try {
    const records = await getSavedRecords();
    if (!activeFileId && records.length) {
      records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      activeFileId = records[0].id;
    } else if (!activeFileId) {
      activeFileId = makeFileId();
    }
    try { localStorage.setItem(ACTIVE_FILE_STORAGE, activeFileId); } catch (_) {}

    const existing = await getSavedRecord(activeFileId);
    // IndexedDB is the durable file source. localStorage is only the recovery
    // mirror, so an existing IndexedDB record wins on startup unless the user
    // has already edited the freshly opened editor while initialization ran.
    if (existing && !currentIsDirty) {
      currentFileName = cleanFileName(existing.name);
      Editor.setValue(existing.code || "");
      savedSnapshot = Editor.getValue();
      currentIsDirty = false;
      storeCurrentToBrowser(true);
    } else {
      await putSavedRecord({
        id: activeFileId,
        name: currentFileName,
        code: Editor.getValue(),
        updatedAt: Date.now()
      });
      savedSnapshot = Editor.getValue();
      currentIsDirty = false;
      storeCurrentToBrowser(true);
    }
    fileNotice = "IndexedDB local library ready";
    updateFileUi();
    await renderSavedFileList();
  } catch (error) {
    fileNotice = "IndexedDB unavailable · browser recovery is active";
    updateFileUi();
  }
}

function isFileDirty() {
  return currentIsDirty;
}
function updateFileUi() {
  const dirty = isFileDirty();
  const label = $("activeFileLabel");
  if (label) label.textContent = currentFileName + (dirty ? " *" : "");
  const nameInput = $("fileNameInput");
  if (nameInput && document.activeElement !== nameInput) nameInput.value = currentFileName;
  const current = $("fileCurrentLabel");
  if (current) current.textContent = currentFileName + (dirty ? " *" : "");
  const state = $("fileState");
  if (state) state.textContent = fileNotice + (dirty ? " · modified (browser recovery autosave is on)" : " · no pending edits");
  document.title = currentFileName + " — Cellular Programming Language";
}
function storeCurrentToBrowser(markClean = false) {
  const code = Editor.getValue();
  try {
    localStorage.setItem(STORAGE_CODE, code);
    localStorage.setItem(STORAGE_NAME, currentFileName);
    if (markClean) { savedSnapshot = code; currentIsDirty = false; }
    fileNotice = markClean ? "Saved locally" : "Auto-saved locally";
  } catch (error) {
    fileNotice = "Browser storage unavailable";
    if (markClean) { savedSnapshot = code; currentIsDirty = false; }
  }
  updateFileUi();
  persistActiveFile();
}
function mayReplaceCurrent(action) {
  const dirty = isFileDirty();
  const message = dirty
    ? action + "? Your current edits differ from the last saved snapshot. Replace them anyway?"
    : action + "? This replaces the current editor contents.";
  return window.confirm(message);
}
function placePopup(panel, anchor, alignRight = false) {
  panel.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = panel.offsetWidth || 320;
  const left = Math.max(6, Math.min(alignRight ? r.right - w : r.left, window.innerWidth - w - 6));
  const top = Math.max(6, Math.min(r.bottom + 3, window.innerHeight - panel.offsetHeight - 6));
  panel.style.left = left + "px";
  panel.style.top = top + "px";
}
function closeFileMenu(returnFocus = false) {
  $("fileMenu").hidden = true;
  $("fileMenuBtn").setAttribute("aria-expanded", "false");
  if (returnFocus) Editor.focus();
}
function openLocalFilesModal() {
  closeFileMenu(false);
  closeEditorMenu(false);
  $("docsPanel").hidden = true;
  $("docsBtn").setAttribute("aria-expanded", "false");
  $("localFilesModal").hidden = false;
  renderSavedFileList();
}
function closeLocalFilesModal(returnFocus = false) {
  $("localFilesModal").hidden = true;
  if (returnFocus) Editor.focus();
}
function closeEditorMenu(returnFocus = false) {
  $("editorMenu").hidden = true;
  $("editorMenuBtn").setAttribute("aria-expanded", "false");
  if (returnFocus) Editor.focus();
}
function syncEditorMenu() {
  $("editorWordWrap").checked = Editor.isWordWrap();
  $("editorReadOnly").checked = Editor.isReadOnly();
}
function openEditorMenu() {
  if (!$("editorMenu").hidden) { closeEditorMenu(false); return; }
  closeFileMenu(false);
  $("docsPanel").hidden = true;
  $("docsBtn").setAttribute("aria-expanded", "false");
  syncEditorMenu();
  placePopup($("editorMenu"), $("editorMenuBtn"));
  $("editorMenuBtn").setAttribute("aria-expanded", "true");
}
function openFileMenu() {
  if (!$("fileMenu").hidden) { closeFileMenu(false); return; }
  closeEditorMenu(false);
  $("docsPanel").hidden = true;
  $("docsBtn").setAttribute("aria-expanded", "false");
  updateFileUi();
  placePopup($("fileMenu"), $("fileMenuBtn"));
  $("fileMenuBtn").setAttribute("aria-expanded", "true");
}
function openDocumentation() {
  if (!$("docsPanel").hidden) {
    $("docsPanel").hidden = true;
    $("docsBtn").setAttribute("aria-expanded", "false");
    return;
  }
  closeFileMenu(false);
  closeEditorMenu(false);
  placePopup($("docsPanel"), $("docsBtn"), true);
  $("docsBtn").setAttribute("aria-expanded", "true");
}
function downloadCurrentFile() {
  const code = Editor.getValue();
  const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = currentFileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
  fileNotice = "Exported " + currentFileName;
  updateFileUi();
}
async function copyCurrentSource() {
  const code = Editor.getValue();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(code);
    } else {
      const temp = document.createElement("textarea");
      temp.value = code;
      temp.setAttribute("readonly", "");
      temp.style.position = "fixed";
      temp.style.opacity = "0";
      temp.style.left = "-9999px";
      document.body.appendChild(temp);
      temp.select();
      const ok = document.execCommand("copy");
      temp.remove();
      if (!ok) throw new Error("Copy command was blocked");
    }
    fileNotice = "Source copied to clipboard";
  } catch (error) {
    fileNotice = "Clipboard access blocked by the browser";
    window.alert("The browser blocked clipboard access. You can still use Export / Download.");
  }
  updateFileUi();
}

Editor.init({
  onRun: runProgram,
  onChange: () => {
    currentIsDirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => storeCurrentToBrowser(false), 350);
    updateFileUi();
  }
});

let initialCode = null;
try {
  activeFileId = localStorage.getItem(ACTIVE_FILE_STORAGE) || "";
  initialCode = localStorage.getItem(STORAGE_CODE);
  if (initialCode === null) initialCode = localStorage.getItem(LEGACY_STORAGE_CODE);
  currentFileName = cleanFileName(localStorage.getItem(STORAGE_NAME) || localStorage.getItem(LEGACY_STORAGE_NAME) || "program.cpl");
} catch (error) { /* Browser storage may be unavailable. */ }
Editor.setValue(initialCode !== null ? initialCode : STARTER_SAMPLE);
savedSnapshot = Editor.getValue();
currentIsDirty = false;
updateFileUi();
Editor.focus();

$("fileMenuBtn").addEventListener("click", openFileMenu);
$("fileClose").addEventListener("click", () => closeFileMenu(false));
$("openLocalFilesBtn").addEventListener("click", openLocalFilesModal);
$("localFilesClose").addEventListener("click", () => closeLocalFilesModal(true));
$("localFilesModal").addEventListener("click", event => {
  if (event.target === $("localFilesModal")) closeLocalFilesModal(true);
});
$("editorMenuBtn").addEventListener("click", openEditorMenu);
$("editorMenuClose").addEventListener("click", () => closeEditorMenu(false));
$("editorFind").addEventListener("click", () => { closeEditorMenu(false); Editor.openFind(); });
$("editorReplace").addEventListener("click", () => { closeEditorMenu(false); Editor.openReplace(); });
$("editorGoto").addEventListener("click", () => { closeEditorMenu(false); Editor.openGoToLine(); });
$("editorSelectAll").addEventListener("click", () => { closeEditorMenu(false); Editor.selectAll(); });
$("editorWordWrap").addEventListener("change", event => { Editor.setWordWrap(event.target.checked); syncEditorMenu(); });
$("editorReadOnly").addEventListener("change", event => { Editor.setReadOnly(event.target.checked); syncEditorMenu(); });
$("docsBtn").addEventListener("click", openDocumentation);
$("docsClose").addEventListener("click", () => {
  $("docsPanel").hidden = true;
  $("docsBtn").setAttribute("aria-expanded", "false");
});
window.addEventListener("pointerdown", event => {
  if (!$("fileMenu").hidden && !$("fileMenu").contains(event.target) && event.target !== $("fileMenuBtn")) closeFileMenu(false);
  if (!$("editorMenu").hidden && !$("editorMenu").contains(event.target) && event.target !== $("editorMenuBtn")) closeEditorMenu(false);
  if (!$("docsPanel").hidden && !$("docsPanel").contains(event.target) && event.target !== $("docsBtn")) {
    $("docsPanel").hidden = true;
    $("docsBtn").setAttribute("aria-expanded", "false");
  }
});
window.addEventListener("keydown", event => {
  if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g" &&
      !$("editorView").hidden && !(event.target instanceof Element && event.target.closest("#fileMenu, #editorMenu, #docsPanel, #localFilesModal"))) {
    event.preventDefault();
    Editor.openGoToLine();
    return;
  }
  if (event.key === "Escape") {
    if (!$("fileMenu").hidden) { closeFileMenu(false); event.preventDefault(); }
    if (!$("editorMenu").hidden) { closeEditorMenu(false); event.preventDefault(); }
    if (!$("docsPanel").hidden) {
      $("docsPanel").hidden = true;
      $("docsBtn").setAttribute("aria-expanded", "false");
      event.preventDefault();
    }
    if (!$("localFilesModal").hidden) {
      closeLocalFilesModal(true);
      event.preventDefault();
    }
  }
});

$("fileNew").addEventListener("click", async () => {
  try {
    await createSavedFile("untitled.cpl", "");
    closeFileMenu(true);
  } catch (error) { window.alert("Could not create a local file: " + (error.message || error)); }
});
$("fileImportBtn").addEventListener("click", () => {
  closeFileMenu(false);
  $("fileImportInput").click();
});
$("fileImportInput").addEventListener("change", async event => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const code = await file.text();
    await createSavedFile(file.name, code);
    fileNotice = "Imported as a new local program: " + file.name;
    updateFileUi();
    closeFileMenu(true);
  } catch (error) {
    window.alert("Could not read that file: " + (error && error.message || error));
  } finally {
    event.target.value = "";
  }
});
$("fileExport").addEventListener("click", () => { downloadCurrentFile(); closeFileMenu(false); });
$("fileSave").addEventListener("click", () => { storeCurrentToBrowser(true); closeFileMenu(false); });
$("fileCopy").addEventListener("click", () => { copyCurrentSource(); closeFileMenu(false); });
$("fileRename").addEventListener("click", () => {
  currentFileName = cleanFileName($("fileNameInput").value);
  $("fileNameInput").value = currentFileName;
  try { localStorage.setItem(STORAGE_NAME, currentFileName); } catch (error) { /* no-op */ }
  fileNotice = "Filename updated";
  storeCurrentToBrowser(true);
  renderSavedFileList();
});
$("fileNameInput").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); $("fileRename").click(); }
  if (event.key === "Escape") closeFileMenu(false);
});
$("fileStarter").addEventListener("click", () => {
  if (!mayReplaceCurrent("Restore the starter sample")) return;
  currentFileName = "program.cpl";
  savedSnapshot = null;
  Editor.setValue(STARTER_SAMPLE);
  savedSnapshot = Editor.getValue();
  storeCurrentToBrowser(true);
  fileNotice = "Starter sample restored";
  updateFileUi();
  closeFileMenu(true);
});

initializeFileLibrary();

for (const button of document.querySelectorAll("[data-insert]")) {
  button.addEventListener("click", () => {
    const snippet = button.dataset.insert.replace(/\\n/g, "\n");
    Editor.insertText(snippet);
    Editor.focus();
  });
}
$("foldall").addEventListener("click", () => { Editor.foldAll(); Editor.focus(); });
$("unfoldall").addEventListener("click", () => { Editor.unfoldAll(); Editor.focus(); });

// -----------------------------------------------------------------------------
// Interpreter and live grid preview
// -----------------------------------------------------------------------------
let execution = null;
let executionTimer = 0;
let gridCells = null;
let gridWidth = 0;
let gridHeight = 0;
let drawMetrics = null;
let selectedCell = null;

function showEditor() {
  $("runView").hidden = true;
  $("editorView").hidden = false;
  Editor.focus();
}
function showRunner() {
  $("editorView").hidden = true;
  $("runView").hidden = false;
  requestAnimationFrame(drawGrid);
}
function setRunStatus(value, className = "dim") {
  const el = $("runStatus");
  el.textContent = value;
  el.className = className;
}
// ---- Rapid-mode batching -------------------------------------------------
// In Rapid speed many steps run per time slice. Log lines, grid redraws and
// statistics are collected during the slice and flushed once at its end.
let batching = false;
let batchTrace = [];
let batchDrawDirty = false;
let batchStatsDirty = false;
const TRACE_LIMIT = 450;

function beginBatch() { batching = true; }
function endBatch() {
  batching = false;
  if (batchTrace.length) {
    const lines = batchTrace.length > TRACE_LIMIT ? batchTrace.slice(-TRACE_LIMIT) : batchTrace;
    const skipped = batchTrace.length - lines.length;
    batchTrace = [];
    flushTraceLines(lines, skipped);
  }
  if (batchStatsDirty) { batchStatsDirty = false; refreshRunStats(); }
  if (batchDrawDirty) { batchDrawDirty = false; drawGridNow(); }
}
function makeTraceLine(text, kind) {
  const line = document.createElement("div");
  if (kind === "error") line.className = "trace-error";
  else if (kind === "ok") line.className = "trace-ok";
  else if (kind === "dim") line.className = "trace-dim";
  else if (kind === "warning") line.className = "trace-warning";
  line.textContent = text;
  return line;
}
function flushTraceLines(lines, skipped) {
  const trace = $("trace");
  const atBottom = trace.scrollHeight - trace.scrollTop - trace.clientHeight < 28;
  if (skipped > 0) trace.appendChild(makeTraceLine(`… ${skipped.toLocaleString()} earlier log line(s) omitted in Rapid mode …`, "dim"));
  for (const item of lines) trace.appendChild(makeTraceLine(item.text, item.kind));
  while (trace.children.length > TRACE_LIMIT) trace.removeChild(trace.firstChild);
  if (atBottom) trace.scrollTop = trace.scrollHeight;
}

function appendTrace(text, kind = "normal") {
  if (batching) { batchTrace.push({ text, kind }); return; }
  const trace = $("trace");
  const atBottom = trace.scrollHeight - trace.scrollTop - trace.clientHeight < 28;
  const line = document.createElement("div");
  if (kind === "error") line.className = "trace-error";
  else if (kind === "ok") line.className = "trace-ok";
  else if (kind === "dim") line.className = "trace-dim";
  else if (kind === "warning") line.className = "trace-warning";
  line.textContent = text;
  trace.appendChild(line);
  while (trace.children.length > 450) trace.removeChild(trace.firstChild);
  if (atBottom) trace.scrollTop = trace.scrollHeight;
}
function clearTrace() {
  $("trace").textContent = "";
}
function refreshRunStats() {
  if (batching) { batchStatsDirty = true; return; }
  const count = execution ? execution.steps : 0;
  $("executionStats").textContent = `${count.toLocaleString()} step${count === 1 ? "" : "s"}`;
  if (gridCells) {
    let active = 0;
    for (const row of gridCells) for (const cell of row) if (cell) active++;
    $("gridStats").textContent = `${active} / ${gridWidth * gridHeight} active`;
  } else {
    $("gridStats").textContent = "";
  }
}
function inspectCell(x, y) {
  if (!gridCells || x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) return;
  selectedCell = { x, y };
  const value = gridCells[y][x] ? 1 : 0;
  $("cellInspector").textContent = `Cell (${x}, ${y}) · ${value ? "white" : "black"} · tap/click to toggle`;
  const canvas = $("gridCanvas");
  canvas.setAttribute("aria-label", `Interactive black and white cellular grid. Selected cell ${x}, ${y}, currently ${value ? "white" : "black"}. Tap or click to toggle.`);
  refreshRunStats();
  drawGrid();
}

function toggleCell(x, y) {
  if (!gridCells || x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) return;
  const before = gridCells[y][x] ? 1 : 0;
  const after = before === 1 ? 0 : 1;
  gridCells[y][x] = after;
  inspectCell(x, y);
  appendTrace(`[MANUAL] Cell (${x}, ${y}) toggled: ${before} → ${after}.`, "dim");
  $("runMessage").textContent = `Cell (${x}, ${y}) is now ${after ? "white" : "black"}. Later commands can read its value.`;
}
function drawGrid() {
  if (batching) { batchDrawDirty = true; return; }
  drawGridNow();
}

const BORDER_KEY = "cpl.gridBorder";
function borderEnabled() {
  const box = $("gridBorder");
  return box ? box.checked : true;
}

function drawGridNow() {
  const canvas = $("gridCanvas");
  if (!canvas) return;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const targetW = Math.round(width * dpr), targetH = Math.round(height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  if (!gridCells) {
    drawMetrics = null;
    return;
  }

  const pad = 14;
  const cell = Math.max(1, Math.min((width - pad * 2) / gridWidth, (height - pad * 2) / gridHeight));
  const gridW = cell * gridWidth, gridH = cell * gridHeight;
  const ox = Math.round((width - gridW) / 2), oy = Math.round((height - gridH) / 2);
  drawMetrics = { ox, oy, cell, width: gridWidth, height: gridHeight };

  // Snap every cell edge to a whole pixel so neighbouring cells touch exactly
  // (no hairline gaps) when borders are turned off.
  const edgeX = i => Math.round(ox + i * cell);
  const edgeY = i => Math.round(oy + i * cell);

  ctx.fillStyle = "#000000";
  ctx.fillRect(edgeX(0), edgeY(0), edgeX(gridWidth) - edgeX(0), edgeY(gridHeight) - edgeY(0));

  // Cells are strictly binary in appearance: 0 is black, 1 is white.
  ctx.fillStyle = "#ffffff";
  for (let y = 0; y < gridHeight; y++) {
    const row = gridCells[y];
    const y0 = edgeY(y), y1 = edgeY(y + 1);
    for (let x = 0; x < gridWidth; x++) {
      if (!row[x]) continue;
      const x0 = edgeX(x), x1 = edgeX(x + 1);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }

  // Border on: draw visible grid lines (readable on black and on white cells).
  // Very small cells skip the lines so they do not swallow the picture.
  if (borderEnabled() && cell >= 4) {
    ctx.fillStyle = "#6e7781";
    const left = edgeX(0), top = edgeY(0), right = edgeX(gridWidth), bottom = edgeY(gridHeight);
    for (let x = 0; x <= gridWidth; x++) {
      const px = Math.min(edgeX(x), right - 1);
      ctx.fillRect(px, top, 1, bottom - top);
    }
    for (let y = 0; y <= gridHeight; y++) {
      const py = Math.min(edgeY(y), bottom - 1);
      ctx.fillRect(left, py, right - left, 1);
    }
  }
}

function finishExecution(kind, message) {
  if (!execution) return;
  clearTimeout(executionTimer);
  executionTimer = 0;
  execution.running = false;
  execution.paused = true;
  $("pauseResume").textContent = "Resume";
  if (kind === "done") {
    setRunStatus("Finished", "trace-ok");
    $("runMessage").textContent = message || "Program completed.";
    appendTrace(message || `Program completed in ${execution.steps} step(s).`, "ok");
  } else if (kind === "stopped") {
    setRunStatus("Stopped");
    $("runMessage").textContent = message || "Execution stopped.";
    appendTrace(message || "Execution stopped by user.", "dim");
  } else {
    setRunStatus("Runtime error", "trace-error");
    $("runMessage").textContent = message;
    appendTrace(message, "error");
  }
  refreshRunStats();
}

function runtimeError(message, command) {
  const location = command ? ` at ${command.line}:${command.col}` : "";
  finishExecution("error", `Runtime error${location}: ${message}`);
}

function activeTask() {
  if (!execution || !Array.isArray(execution.tasks) || !execution.tasks.length) return null;
  return execution.tasks[execution.activeTaskIndex] || null;
}

function syncActiveTask() {
  if (!execution) return;
  const task = activeTask();
  execution.frames = task ? task.frames : [];
}

function activeFrame() {
  const task = activeTask();
  if (!task || !Array.isArray(task.frames) || !task.frames.length) return null;
  return task.frames[0];
}

function activateFrame(frame) {
  if (!execution || !frame) return;
  execution.cbp = frame.cbp;
  execution.cmdp = frame.cmdp;
}

function createChainFrame(program, cbp, metadata = {}) {
  return {
    program,
    cbp,
    cmdp: 0,
    lastResult: true,
    reachedTerminator: false,
    branchStack: [],
    branchCbp: -1,
    moveReferences: new Map(),
    groupInstanceId: metadata.groupInstanceId ?? null,
    engineInstanceId: metadata.engineInstanceId ?? execution?.rootEngineId ?? null,
    // A normally completed CB can resolve a suspended jmpc() caller.
    reachedSemicolon: false
  };
}

// Every activation creates a fresh Chain Block instance. The instance owns
// its CBP, CMDP, conditional state, movement references, and optional sleep.
function spawnChainInstance(program, cbp, metadata = {}) {
  if (!execution || !program || !program.chains || !program.chains[cbp]) return null;
  const frame = createChainFrame(program, cbp, metadata);
  const task = {
    id: execution.nextTaskId++,
    kind: metadata.kind || "spawned",
    spawned: metadata.spawned !== false,
    parentId: metadata.parentId ?? null,
    groupInstanceId: metadata.groupInstanceId ?? null,
    engineInstanceId: metadata.engineInstanceId ?? frame.engineInstanceId,
    frames: [frame],
    sleepUntil: null,
    sleepCommand: null,
    sleepStartedAt: null,
    stepDelayCommand: null,
    waitingOnTaskId: null,
    waitingCommand: null,
    waitingOnEngineId: null,
    waitingOnEngineCommand: null,
    waiter: metadata.waiter ?? null
  };
  execution.tasks.push(task);
  return task;
}

function selectRunnableTask(startAfterCurrent = false) {
  if (!execution || !execution.tasks.length) return false;
  const tasks = execution.tasks;
  const count = tasks.length;
  const now = performance.now();
  const base = execution.activeTaskIndex || 0;
  const start = startAfterCurrent ? 1 : 0;
  for (let step = 0; step < count; step++) {
    const index = (base + start + step) % count;
    const task = tasks[index];
    if (!task) continue;
    // jmpc() parks its caller on the command until the called instance exits.
    if (task.waitingOnTaskId !== null || task.waitingOnEngineId !== null) continue;
    if (task.sleepUntil !== null && task.sleepUntil > now) continue;
    execution.activeTaskIndex = index;
    execution.advancePending = false;
    syncActiveTask();
    const frame = activeFrame();
    if (frame) activateFrame(frame);
    return !!frame;
  }
  return false;
}

function removeTask(task) {
  if (!execution || !task) return;
  const index = execution.tasks.indexOf(task);
  if (index < 0) return;
  const wasActive = index === execution.activeTaskIndex;
  execution.tasks.splice(index, 1);
  if (!execution.tasks.length) {
    execution.activeTaskIndex = 0;
    execution.frames = [];
    execution.advancePending = false;
    return;
  }
  if (wasActive) {
    // The task that followed the removed instance now occupies the same slot.
    execution.activeTaskIndex = index % execution.tasks.length;
    execution.advancePending = false;
  } else if (index < execution.activeTaskIndex) {
    execution.activeTaskIndex--;
  }
  syncActiveTask();
  const frame = activeFrame();
  if (frame) activateFrame(frame);
}

function createEngineInstance(program, metadata = {}) {
  if (!execution) return null;
  const id = execution.nextEngineInstanceId++;
  const engine = {
    id,
    program,
    parentEngineId: metadata.parentEngineId ?? null,
    parentTaskId: metadata.parentTaskId ?? null,
    parentCommand: metadata.parentCommand ?? null,
    isRoot: metadata.isRoot === true,
    active: true
  };
  execution.engines.set(id, engine);
  return id;
}

function collectEngineTree(engineId, collected = new Set()) {
  if (!execution || collected.has(engineId)) return collected;
  const engine = execution.engines.get(engineId);
  if (!engine) return collected;
  collected.add(engineId);
  for (const child of execution.engines.values()) {
    if (child.active && child.parentEngineId === engineId) collectEngineTree(child.id, collected);
  }
  return collected;
}

function maybeCompleteEngine(engineId) {
  if (!execution || !execution.running || engineId == null) return false;
  const engine = execution.engines.get(engineId);
  if (!engine || !engine.active) return false;

  const hasOwnInstances = execution.tasks.some(task => task.engineInstanceId === engineId);
  const hasActiveChildEngines = Array.from(execution.engines.values()).some(child =>
    child.active && child.parentEngineId === engineId
  );
  if (hasOwnInstances || hasActiveChildEngines) return false;

  engine.active = false;
  execution.engines.delete(engineId);
  appendTrace(`[ENGINE#${engineId}] All instances and nested engines have finished; engine completed naturally and returns TRUE.`, "dim");

  if (engine.isRoot) {
    finishExecution("done", `Root engine completed: ${execution.steps} step(s), ${execution.program.chains.length} root Chain Block(s).`);
    return true;
  }

  const parent = execution.tasks.find(task => task.id === engine.parentTaskId);
  if (parent && parent.waitingOnEngineId === engineId) {
    const parentFrame = parent.frames && parent.frames[0];
    const parentCommand = parent.waitingOnEngineCommand || engine.parentCommand;
    parent.waitingOnEngineId = null;
    parent.waitingOnEngineCommand = null;
    if (parentFrame && parentCommand) {
      appendTrace(`[ENGINE#${engineId}] IGCB parent CB#${parent.id} resumed at CMDP ${parentFrame.cmdp}; natural completion returned TRUE.`, "dim");
      routeCommandResult(parentFrame, parentCommand, true, parentCommand.positionIndex + 1);
    }
  }

  if (execution && execution.running && engine.parentEngineId != null) {
    maybeCompleteEngine(engine.parentEngineId);
  }
  return true;
}

function terminateEngine(engineId, result, sourceCommand) {
  if (!execution || !execution.running) return false;
  const engine = execution.engines.get(engineId);
  if (!engine || !engine.active) return false;

  const tree = collectEngineTree(engineId);
  const parentEngineId = engine.parentEngineId;
  const parentTaskId = engine.parentTaskId;
  const parentCommand = engine.parentCommand;
  const isRoot = engine.isRoot;
  appendTrace(`[ENGINE#${engineId}] '&!' received ${result ? "TRUE" : "FALSE"} from its left-hand CMDB; terminating this engine and ${tree.size > 1 ? `${tree.size - 1} nested engine(s)` : "all of its instances"}. Parent engines are not affected.`, "dim");

  // Remove every task owned by this engine or one of its descendants. The
  // waiting parent task belongs to the parent engine and is deliberately kept.
  const doomedTasks = execution.tasks.filter(task => tree.has(task.engineInstanceId));
  for (const task of doomedTasks) removeTask(task);
  for (const id of tree) {
    const item = execution.engines.get(id);
    if (item) item.active = false;
    execution.engines.delete(id);
  }

  if (isRoot) {
    finishExecution("done", `Root engine terminated by '&!' after ${execution.steps} step(s).`);
    return true;
  }

  const parent = execution.tasks.find(task => task.id === parentTaskId);
  if (parent && parent.waitingOnEngineId === engineId) {
    const parentFrame = parent.frames && parent.frames[0];
    const waitingCommand = parent.waitingOnEngineCommand || parentCommand;
    parent.waitingOnEngineId = null;
    parent.waitingOnEngineCommand = null;
    if (parentFrame && waitingCommand) {
      appendTrace(`[ENGINE#${engineId}] Parent CB#${parent.id} resumed at CMDP ${parentFrame.cmdp}; forced termination returned ${result ? "TRUE" : "FALSE"}.`, "dim");
      routeCommandResult(parentFrame, waitingCommand, !!result, waitingCommand.positionIndex + 1);
    }
  }

  if (execution && execution.running && parentEngineId != null) maybeCompleteEngine(parentEngineId);
  return true;
}

function saveCurrentPosition(frame = activeFrame()) {
  if (!execution || !frame) return;
  execution.cbp = frame.cbp;
  execution.cmdp = frame.cmdp;
}

function branchStackFor(frame) {
  if (!Array.isArray(frame.branchStack)) frame.branchStack = [];
  return frame.branchStack;
}

function activateChainState(frame) {
  if (frame.branchCbp === frame.cbp) return;
  frame.branchCbp = frame.cbp;
  frame.branchStack = [];
}

function divertToReference(frame, branch, sourceCommand, reason) {
  const sourceChain = frame.program.chains[frame.cbp];
  const target = branch && branch.referencePosition;
  if (!Number.isInteger(target) || target < 0 || target >= sourceChain.positions.length) {
    appendTrace(`Warning: Pointer Checker '?:' has no matching '>:' reference in CBP ${frame.cbp + 1}.`, "warning");
    frame.branchStack = branchStackFor(frame).filter(item => item !== branch);
    frame.cmdp = sourceChain.positions.length;
    frame.reachedTerminator = false;
    return;
  }
  frame.branchStack = branchStackFor(frame).filter(item => item !== branch);
  frame.cmdp = target + 1;
  frame.reachedTerminator = false;
  appendTrace(`[CBP ${frame.cbp + 1}] Pointer Checker '?:' received false and passed it to its paired '>:'; execution continues at the reference's right-hand CMDB (CMDP ${frame.cmdp}).${reason ? ` ${reason}` : ""}`, "dim");
}

// A connector only changes the CMDP of this one Chain Block instance.
function routeCommandResult(frame, command, result, nextIndex = command.positionIndex + 1) {
  if (!execution || !frame || !command) return;
  const sourceCbp = frame.cbp;
  const sourceChain = frame.program.chains[sourceCbp];
  const connector = command.connectorAfter;
  const branches = branchStackFor(frame);
  frame.lastResult = !!result;

  if (connector === "engineTerminate") {
    appendTrace(`[CBP ${sourceCbp + 1}] Engine Termination '&!' received ${result ? "TRUE" : "FALSE"} from its left-hand CMDB.`, "dim");
    terminateEngine(frame.engineInstanceId, !!result, command);
    return;
  }

  if (connector === "return") {
    const previousCmdp = frame.cmdp;
    frame.cmdp = sourceChain.positions.length;
    frame.reachedTerminator = true;
    frame.reachedSemicolon = true;
    appendTrace(`[CBP ${sourceCbp + 1}] Returnee '<:' redirected CMDP ${previousCmdp} directly to the terminal ';' boundary (CMDP ${frame.cmdp}); the CMDB Boolean result does not change this jump.`, "dim");
  } else if (connector === "end") {
    frame.cmdp = sourceChain.positions.length;
    frame.reachedTerminator = true;
    frame.reachedSemicolon = true;
    appendTrace(`[CBP ${sourceCbp + 1}] connector ';' reached; this Chain Block instance is complete.`, "dim");
  } else if (connector === "branch") {
    const def = command.branchDef || { referencePosition: -1, id: `unpaired:${sourceCbp}:${command.positionIndex}` };
    const branch = {
      id: def.id,
      openerPosition: command.positionIndex,
      referencePosition: def.referencePosition
    };
    if (result) {
      branches.push(branch);
      frame.cmdp = nextIndex;
      frame.reachedTerminator = false;
      appendTrace(`[CBP ${sourceCbp + 1}] Pointer Checker '?:' received true; continuing toward its paired '>:' reference.`, "dim");
    } else {
      divertToReference(frame, branch, command, "The left-hand CMDB returned false.");
    }
  } else if (connector === "reference") {
    const activeBranch = branches.length ? branches[branches.length - 1] : null;
    if (activeBranch && activeBranch.referencePosition === command.positionIndex) {
      if (result) {
        branches.pop();
        frame.cmdp = sourceChain.positions.length;
        frame.reachedTerminator = true;
        appendTrace(`[CBP ${sourceCbp + 1}] Paired '>:' received true; the conditional path completed and this Chain Block instance ended.`, "dim");
      } else {
        divertToReference(frame, activeBranch, command, "The left-hand CMDB at the reference returned false.");
      }
    } else if (activeBranch && !result && activeBranch.referencePosition > command.positionIndex) {
      divertToReference(frame, activeBranch, command, "The active checker selected its false path.");
    } else if (result) {
      frame.cmdp = sourceChain.positions.length;
      frame.reachedTerminator = true;
      appendTrace(`[CBP ${sourceCbp + 1}] Unpaired '>:' received true from its left-hand CMDB; this Chain Block instance ended.`, "dim");
    } else {
      frame.cmdp = nextIndex;
      frame.reachedTerminator = false;
      appendTrace(`[CBP ${sourceCbp + 1}] '>:' received false from its left-hand CMDB; continuing with the right-hand CMDB.`, "dim");
    }
  } else if (!result && branches.length) {
    const activeBranch = branches[branches.length - 1];
    divertToReference(frame, activeBranch, command, "A CMDB inside the checked path returned false.");
  } else if (connector === "next") {
    if (result) {
      frame.cmdp = nextIndex;
    } else {
      appendTrace(`[CBP ${sourceCbp + 1}] connector ':' received false; remaining CMDBs in this Chain Block instance were skipped.`, "dim");
      frame.cmdp = sourceChain.positions.length;
      frame.reachedTerminator = false;
    }
  } else {
    frame.cmdp = nextIndex;
  }

  if (activeFrame() === frame) activateFrame(frame);
  saveCurrentPosition(frame);
}

function warnUnresolvedBranches(frame) {
  const branches = branchStackFor(frame);
  if (!branches.length) return;
  for (const branch of branches) {
    appendTrace(`Warning: Pointer Checker '?:' in CBP ${frame.cbp + 1} exited without reaching its paired '>:' reference.`, "warning");
  }
  branches.length = 0;
}

function completeChainInstance(task, frame) {
  if (!execution || !execution.running || !task || !frame) return false;

  // Only reaching the CB's actual terminal semicolon is a successful jmpc()
  // result. Any earlier exit removes the called instance and returns FALSE.
  const callResult = frame.reachedSemicolon === true;
  const reachedTerminator = frame.reachedTerminator === true;
  const waiter = task.waiter;
  warnUnresolvedBranches(frame);
  const outcome = callResult
    ? "reached ';' and completed successfully"
    : reachedTerminator
      ? "was terminated before ';'"
      : "ended before reaching ';'";
  appendTrace(`[CB#${task.id}] Chain Block instance at CBP ${frame.cbp + 1} ${outcome}; instance removed.`, "dim");
  removeTask(task);

  // Wake only the exact caller that created this instance. A different root
  // activation of the same CB is not interchangeable with this invocation.
  if (waiter && execution && execution.running) {
    const caller = execution.tasks.find(candidate => candidate.id === waiter.taskId);
    if (caller && caller.waitingOnTaskId === task.id) {
      const callerFrame = caller.frames && caller.frames[0];
      const callerCommand = caller.waitingCommand || waiter.command;
      caller.waitingOnTaskId = null;
      caller.waitingCommand = null;
      if (callerFrame && callerCommand) {
        appendTrace(`[CB#${caller.id}] jmpc() resumed at CMDP ${callerFrame.cmdp}; called CB#${task.id} returned ${callResult ? "TRUE" : "FALSE"}.`, "dim");
        routeCommandResult(callerFrame, callerCommand, callResult, callerCommand.positionIndex + 1);
      }
    }
  }

  if (execution && execution.running) maybeCompleteEngine(task.engineInstanceId);
  return true;
}

function normalizeChain() {
  while (execution && execution.running) {
    const task = activeTask();
    if (!task) {
      finishExecution("done", `Program completed: ${execution.steps} step(s), ${execution.program.chains.length} Chain Block(s).`);
      return false;
    }
    const frame = activeFrame();
    if (!frame) {
      removeTask(task);
      if (execution && execution.running) maybeCompleteEngine(task.engineInstanceId);
      if (!execution || !execution.running) return false;
      if (!selectRunnableTask(false)) return false;
      continue;
    }

    const engine = frame.program;
    if (frame.cbp < 0 || frame.cbp >= engine.chains.length) {
      runtimeError(`Internal execution error: CBP ${frame.cbp} is outside its active engine.`, null);
      return false;
    }
    const chain = engine.chains[frame.cbp];
    activateChainState(frame);
    activateFrame(frame);
    if (frame.cmdp < chain.positions.length) return true;

    completeChainInstance(task, frame);
    if (!execution || !execution.running) return false;
    if (!selectRunnableTask(false)) return false;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Value Expressions (VE)
// -----------------------------------------------------------------------------
// VEs are evaluated immediately before their enclosing CMDB. Grid-reading and
// grid-writing operations share the live cellular memory. IGCBs run their own
// small synchronous engine so their final Boolean result can become 1 or 0.
const VE_MAX_DEPTH = 64;
const VE_MAX_STEPS = 20000;

// MV keeps one movement reference per engine/chain inside its execution frame.
// The first MV seeds it from sx,sy; each successful move updates it to the
// destination so later MV commands in that chain continue from the new cell.
function movementReference(context, seedX, seedY) {
  const holder = context.frame || context.state;
  if (!holder.moveReferences) holder.moveReferences = new Map();
  let chains = holder.moveReferences.get(context.program);
  if (!chains) {
    chains = new Map();
    holder.moveReferences.set(context.program, chains);
  }
  const chainIndex = context.chainIndex;
  return chains.has(chainIndex) ? { ...chains.get(chainIndex) } : { x: seedX, y: seedY };
}

function updateMovementReference(context, x, y) {
  const holder = context.frame || context.state;
  if (!holder.moveReferences) holder.moveReferences = new Map();
  let chains = holder.moveReferences.get(context.program);
  if (!chains) {
    chains = new Map();
    holder.moveReferences.set(context.program, chains);
  }
  chains.set(context.chainIndex, { x, y });
}

function isValueExpression(value) {
  return !!value && typeof value === "object" &&
    (value.type === "valueExpression" || value.type === "integerExpression");
}

function normalizeArea(x1, y1, x2, y2) {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2)
  };
}

function valueRectangleError(x1, y1, x2, y2, label) {
  if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0 ||
      x1 >= gridWidth || y1 >= gridHeight || x2 >= gridWidth || y2 >= gridHeight) {
    return `${label} rectangle out of bounds: (${x1},${y1}) to (${x2},${y2}). Valid coordinates are x=0–${gridWidth - 1}, y=0–${gridHeight - 1}.`;
  }
  return "";
}

function veError(message, command) {
  runtimeError(`Value Expression: ${message}`, command);
}

function evaluateValueArgument(argument, context, ownerCommand, depth = 0) {
  if (typeof argument === "number") return argument;
  if (!isValueExpression(argument)) {
    veError("the compiler produced an invalid numeric argument.", ownerCommand);
    return 0;
  }
  if (depth > VE_MAX_DEPTH) {
    veError(`maximum nested expression depth (${VE_MAX_DEPTH}) exceeded.`, ownerCommand);
    return 0;
  }

  if (argument.type === "integerExpression") {
    const terms = argument.terms || [];
    const operators = argument.operators || [];
    if (!terms.length || operators.length !== terms.length - 1) {
      veError("the compiler produced an invalid integer-offset expression.", ownerCommand);
      return 0;
    }
    let result = evaluateValueArgument(terms[0], context, ownerCommand, depth + 1);
    for (let i = 0; i < operators.length; i++) {
      if (!execution || !execution.running) return 0;
      const next = evaluateValueArgument(terms[i + 1], context, ownerCommand, depth + 1);
      const operator = operators[i];
      if (operator === "+") result += next;
      else if (operator === "-") result -= next;
      else if (operator === "%") {
        if (next <= 0) {
          veError(`Limiter Modulus requires a positive integer limit; received '${next}'.`, ownerCommand);
          return 0;
        }
        // Normalize JavaScript's signed remainder so negative values wrap
        // into the inclusive lower range 0 through next - 1.
        result = ((result % next) + next) % next;
      } else {
        veError(`the compiler produced an unknown integer-offset operator '${operator}'.`, ownerCommand);
        return 0;
      }
      if (!Number.isSafeInteger(result)) {
        veError("integer offset expression exceeded the supported safe-integer range.", ownerCommand);
        return 0;
      }
    }
    appendTrace(`[VE] integer offset expression evaluated to ${result}.`, "dim");
    return result;
  }

  const expression = argument.expression;
  if (expression.type === "areaCount") {
    if (!gridCells) {
      veError("area counting requires an initialized grid. Add '@grid <width> <height>' before the program.", ownerCommand);
      return 0;
    }
    const args = expression.args.map(value => evaluateValueArgument(value, context, ownerCommand, depth + 1));
    if (!execution || !execution.running) return 0;
    const [sx, sy, ex, ey, b] = args;
    if (b !== 0 && b !== 1) {
      veError(`area-count value must be 0 or 1; received '${b}'.`, ownerCommand);
      return 0;
    }
    const error = valueRectangleError(sx, sy, ex, ey, "Area-count");
    if (error) { veError(error, ownerCommand); return 0; }
    const area = normalizeArea(sx, sy, ex, ey);
    let count = 0;
    for (let y = area.top; y <= area.bottom; y++) {
      for (let x = area.left; x <= area.right; x++) {
        if ((gridCells[y][x] ? 1 : 0) === b) count++;
      }
    }
    appendTrace(`[VE] <{${sx},${sy},${ex},${ey},${b}}> counted ${count} matching cell(s) in normalized area (${area.left},${area.top})–(${area.right},${area.bottom}).`, "dim");
    return count;
  }

  if (expression.type === "cmdb") {
    const result = executeValueCMDB(expression.command, context, depth + 1);
    if (!execution || !execution.running) return 0;
    const numeric = result ? 1 : 0;
    appendTrace(`[VE] <${expression.command.raw || expression.command.name}> returned ${result ? "TRUE" : "FALSE"} → ${numeric}.`, "dim");
    return numeric;
  }

  veError("unknown expression type.", ownerCommand);
  return 0;
}

function executeValueCMDB(command, context, depth) {
  if (depth > VE_MAX_DEPTH) {
    veError(`maximum nested expression depth (${VE_MAX_DEPTH}) exceeded.`, command);
    return false;
  }
  if (!context.state) context.state = { steps: 0 };
  context.state.steps++;
  if (context.state.steps > VE_MAX_STEPS) {
    veError(`isolated expression exceeded ${VE_MAX_STEPS.toLocaleString()} CMDB evaluations. Check for an endless jump loop.`, command);
    return false;
  }

  if (command.name === "alwaysTrue" || command.name === "stepDelay") return true;
  if (command.name === "alwaysFalse") return false;
  if (command.name === "group") {
    appendTrace(`[IGCB] Executing isolated engine with ${command.program.chains.length} chain(s) inside a Value Expression.`, "dim");
    const result = executeValueEngine(command.program, context, depth + 1);
    appendTrace(`[IGCB] Isolated engine returned ${result ? "TRUE" : "FALSE"}.`, "dim");
    return result;
  }
  if (command.name === "jmp") {
    veError("jmp() needs an active Command Block Pointer (CMDP) and can only be executed as a command inside an IGCB.", command);
    return false;
  }

  const args = (command.args || []).map(value => evaluateValueArgument(value, context, command, depth + 1));
  if (!execution || !execution.running) return false;
  const program = context.program;
  const chainIndex = context.chainIndex;

  if (command.name === "set" || command.name === "if") {
    if (!gridCells) { veError("grid commands require an initialized grid.", command); return false; }
    const [x, y, b] = args;
    if (b !== 0 && b !== 1) { veError(`${command.name}() Boolean parameter must be 0 or 1; received '${b}'.`, command); return false; }
    if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) {
      veError(`${command.name}() coordinate out of bounds at (${x}, ${y}). Valid coordinates are x=0–${gridWidth - 1}, y=0–${gridHeight - 1}.`, command);
      return false;
    }
    if (command.name === "set") {
      const before = gridCells[y][x] ? 1 : 0;
      gridCells[y][x] = b;
      appendTrace(`[VE] set(${x},${y},${b}) changed cell (${x},${y}): ${before} → ${b}.`, "dim");
      execution.lastCell = { x, y };
      drawGrid();
      return true;
    }
    const actual = gridCells[y][x] ? 1 : 0;
    const passed = actual === b;
    appendTrace(`[VE] if(${x},${y},${b}) checked cell (${x},${y}): ${actual} → ${passed ? "TRUE" : "FALSE"}.`, "dim");
    return passed;
  }

  if (command.name === "fill") {
    if (!gridCells) { veError("fill() requires an initialized grid.", command); return false; }
    const [x1, y1, x2, y2, value] = args;
    if (value !== 0 && value !== 1) { veError(`fill() Boolean parameter must be 0 or 1; received '${value}'.`, command); return false; }
    const error = valueRectangleError(x1, y1, x2, y2, "Fill");
    if (error) { veError(error, command); return false; }
    const area = normalizeArea(x1, y1, x2, y2);
    for (let y = area.top; y <= area.bottom; y++) for (let x = area.left; x <= area.right; x++) gridCells[y][x] = value;
    const areaWidth = area.right - area.left + 1;
    const areaHeight = area.bottom - area.top + 1;
    appendTrace(`[VE] fill(${x1},${y1},${x2},${y2},${value}) normalized to (${area.left},${area.top})–(${area.right},${area.bottom}) and changed ${(areaWidth * areaHeight).toLocaleString()} cell(s).`, "dim");
    drawGrid();
    return true;
  }

  if (command.name === "copy") {
    if (!gridCells) { veError("copy() requires an initialized grid.", command); return false; }
    const [sx, sy, ex, ey, dx, dy] = args;
    const sourceError = valueRectangleError(sx, sy, ex, ey, "Copy source");
    if (sourceError) { veError(sourceError, command); return false; }
    const sourceArea = normalizeArea(sx, sy, ex, ey);
    const width = sourceArea.right - sourceArea.left + 1;
    const height = sourceArea.bottom - sourceArea.top + 1;
    const endX = dx + width - 1, endY = dy + height - 1;
    const destinationError = valueRectangleError(dx, dy, endX, endY, "Copy destination");
    if (destinationError) { veError(destinationError, command); return false; }
    const snapshot = Array.from({ length: height }, (_, row) => gridCells[sourceArea.top + row].slice(sourceArea.left, sourceArea.right + 1));
    for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) gridCells[dy + row][dx + col] = snapshot[row][col];
    appendTrace(`[VE] copy(${sx},${sy},${ex},${ey},${dx},${dy}) normalized source to (${sourceArea.left},${sourceArea.top})–(${sourceArea.right},${sourceArea.bottom}) and copied ${width} × ${height} cell(s).`, "dim");
    drawGrid();
    return true;
  }

  if (command.name === "mv") {
    if (!gridCells) { veError("mv() requires an initialized grid.", command); return false; }
    const [seedX, seedY, offset, axis] = args;
    if (offset !== 0 && offset !== 1) { veError(`mv() movement offset must be 0 or 1; received '${offset}'.`, command); return false; }
    if (![ -1, 0, 1 ].includes(axis)) { veError(`mv() movement axis must be -1, 0, or 1; received '${axis}'.`, command); return false; }
    const { x: sx, y: sy } = movementReference(context, seedX, seedY);
    const step = offset === 1 ? 1 : -1;
    const dx = sx + (axis === 0 || axis === -1 ? step : 0);
    const dy = sy + (axis === 1 || axis === -1 ? step : 0);
    if (sx < 0 || sy < 0 || sx >= gridWidth || sy >= gridHeight) {
      veError(`mv() source coordinate out of bounds at (${sx},${sy}). Valid coordinates are x=0–${gridWidth - 1}, y=0–${gridHeight - 1}.`, command);
      return false;
    }
    if (dx < 0 || dy < 0 || dx >= gridWidth || dy >= gridHeight) {
      veError(`mv() destination coordinate out of bounds at (${dx},${dy}). Valid coordinates are x=0–${gridWidth - 1}, y=0–${gridHeight - 1}.`, command);
      return false;
    }
    const sourceValue = gridCells[sy][sx] ? 1 : 0;
    const destinationBefore = gridCells[dy][dx] ? 1 : 0;
    gridCells[sy][sx] = sourceValue === 1 ? 0 : 1;
    gridCells[dy][dx] = sourceValue;
    updateMovementReference(context, dx, dy);
    execution.lastCell = { x: dx, y: dy };
    execution.lastMoveReference = { x: dx, y: dy };
    appendTrace(`[VE] mv(${seedX},${seedY},${offset},${axis}) moved reference (${sx},${sy}) → (${dx},${dy}); source ${sourceValue} → ${sourceValue ? 0 : 1}, destination ${destinationBefore} → ${sourceValue}.`, "dim");
    drawGrid();
    return true;
  }

  if (command.name === "jmpc") {
    veError("jmpc() suspends its caller until the invoked Chain Block instance exits, so it cannot run inside a synchronous Value Expression.", command);
    return false;
  }
  if (command.name === "call") {
    if (!program || !program.chains.length) { veError("call() has no active engine.", command); return false; }
    const target = chainIndex + args[0];
    if (target < 0 || target >= program.chains.length) {
      veError(`call(${args[0]}) target is outside the active engine's CBP range (1–${program.chains.length}).`, command);
      return false;
    }
    const spawned = spawnChainInstance(program, target, {
      kind: "call",
      spawned: true,
      parentId: context.task && context.task.id,
      groupInstanceId: context.task && context.task.groupInstanceId,
      engineInstanceId: context.task && context.task.engineInstanceId
    });
    if (!spawned) { veError("call() could not activate the requested Chain Block.", command); return false; }
    appendTrace(`[VE] call(${args[0]}) activated independent CB#${spawned.id} at CBP ${target + 1}; returned TRUE immediately.`, "dim");
    return true;
  }

  veError(`unsupported CMDB '${command.name}'.`, command);
  return false;
}

function executeValueChain(program, chainIndex, context, depth) {
  const chain = program.chains[chainIndex];
  if (!chain) return { engineResult: false, returned: false };
  let cmdp = 0;
  let reachedTerminator = false;
  const branches = [];
  while (cmdp < chain.positions.length) {
    if (depth > VE_MAX_DEPTH) {
      veError(`maximum nested engine depth (${VE_MAX_DEPTH}) exceeded.`, chain.positions[cmdp]);
      return { engineResult: false, returned: false };
    }
    context.state.steps++;
    if (context.state.steps > VE_MAX_STEPS) {
      veError(`isolated expression exceeded ${VE_MAX_STEPS.toLocaleString()} CMDB evaluations. Check for an endless jump loop.`, chain.positions[cmdp]);
      return { engineResult: false, returned: false };
    }
    const command = chain.positions[cmdp];
    const cmdContext = { ...context, program, chainIndex };

    if (command.name === "jmp") {
      const jumpOffset = evaluateValueArgument(command.args[0], cmdContext, command, depth + 1);
      if (!execution || !execution.running) return { engineResult: false, returned: false };
      const target = cmdp + jumpOffset;
      if (target < 0 || target >= chain.positions.length) {
        veError(`jmp(${jumpOffset}) from CMDP ${cmdp} resolves to CMDP ${target}; valid positions are 0–${chain.positions.length - 1}.`, command);
        return { engineResult: false, returned: false };
      }
      appendTrace(`[IGCB] jmp(${jumpOffset}) moved CMDP ${cmdp} → ${target}.`, "dim");
      cmdp = target;
      continue;
    }

    let result = executeValueCMDB(command, cmdContext, depth + 1);
    if (!execution || !execution.running) return { engineResult: false, returned: false };
    const next = cmdp + 1;
    const connector = command.connectorAfter;

    if (connector === "return") {
      appendTrace(`[IGCB] Returnee '<:' redirected the isolated CMDP ${cmdp} directly to the terminal ';' boundary.`, "dim");
      return { engineResult: true, returned: false };
    }
    if (connector === "end") return { engineResult: true, returned: false };
    if (connector === "branch") {
      const def = command.branchDef || { referencePosition: -1, id: `ve:${chainIndex}:${cmdp}` };
      const branch = { id: def.id, referencePosition: def.referencePosition };
      if (result) { branches.push(branch); cmdp = next; }
      else {
        const target = branch.referencePosition;
        if (!Number.isInteger(target) || target < 0 || target >= chain.positions.length) return { engineResult: false, returned: false };
        cmdp = target + 1;
      }
      continue;
    }
    if (connector === "reference") {
      const active = branches.length ? branches[branches.length - 1] : null;
      if (active && active.referencePosition === cmdp) {
        if (result) return { engineResult: true, returned: false };
        branches.pop();
        cmdp = next;
        continue;
      }
      if (active && !result && active.referencePosition > cmdp) {
        cmdp = active.referencePosition + 1;
        branches.pop();
        continue;
      }
      if (result) return { engineResult: true, returned: false };
      cmdp = next;
      continue;
    }
    if (!result && branches.length) {
      const active = branches.pop();
      const target = active.referencePosition;
      if (!Number.isInteger(target) || target < 0 || target >= chain.positions.length) return { engineResult: false, returned: false };
      cmdp = target + 1;
      continue;
    }
    if (connector === "next") {
      if (!result) return { engineResult: false, returned: false };
      cmdp = next;
      continue;
    }
    cmdp = next;
  }
  return { engineResult: reachedTerminator, returned: false };
}

function executeValueEngine(program, parentContext, depth) {
  if (!program || !program.chains || !program.chains.length) return false;
  if (depth > VE_MAX_DEPTH) {
    veError(`maximum nested engine depth (${VE_MAX_DEPTH}) exceeded.`, parentContext.ownerCommand);
    return false;
  }
  const state = parentContext.state || { steps: 0 };
  for (let chainIndex = 0; chainIndex < program.chains.length; chainIndex++) {
    const context = { ...parentContext, program, chainIndex, state };
    executeValueChain(program, chainIndex, context, depth + 1);
    if (!execution || !execution.running) return false;
  }
  // A synchronous IGCB in a VE returns TRUE when its isolated engine has
  // naturally exhausted all of its internal CBs. Individual CB early exits
  // do not turn natural engine completion into FALSE.
  return true;
}

function executeOne() {
  if (!execution || !execution.running) return false;

  const wasPending = execution.advancePending;
  if (!selectRunnableTask(wasPending)) return false;
  if (!normalizeChain()) return false;

  const task = activeTask();
  const frame = activeFrame();
  if (!task || !frame) return false;
  const engine = frame.program;
  const chain = engine.chains[frame.cbp];

  // The first ~ step leaves CMDP parked on the Step Delayer. On this next
  // interpreter turn, release it and route its TRUE result through the CC.
  if (task.stepDelayCommand) {
    const delayCommand = task.stepDelayCommand;
    task.stepDelayCommand = null;
    execution.steps++;
    appendTrace(`[CB#${task.id} · CBP ${frame.cbp + 1} · CMDP ${frame.cmdp}] ~ delay elapsed · CMDP advances now.`, "dim");
    routeCommandResult(frame, delayCommand, true, delayCommand.positionIndex + 1);
    const instanceCompleted = frame.cmdp >= chain.positions.length;
    if (instanceCompleted) completeChainInstance(task, frame);
    else execution.advancePending = true;
    if (execution && execution.running && activeFrame()) {
      const current = activeFrame();
      $("activePosition").textContent = `CBP ${current.cbp + 1} · CMDP ${current.cmdp}`;
    }
    refreshRunStats();
    return true;
  }

  // A sleeping instance keeps CMDP parked on its slp() CMDB. Once its timer
  // expires, the CMDB completes and normal connector routing resumes.
  if (task.sleepUntil !== null) {
    if (task.sleepUntil > performance.now()) return false;
    const sleepCommand = task.sleepCommand;
    const sleepStartedAt = Number.isFinite(task.sleepStartedAt) ? task.sleepStartedAt : performance.now();
    const sleptFor = Math.max(0, Math.round(performance.now() - sleepStartedAt));
    task.sleepUntil = null;
    task.sleepCommand = null;
    task.sleepStartedAt = null;
    appendTrace(`[CB#${task.id}] slp() finished after approximately ${sleptFor} ms; CMDP ${frame.cmdp} resumes.`, "dim");
    routeCommandResult(frame, sleepCommand, true, sleepCommand.positionIndex + 1);
    const instanceCompleted = frame.cmdp >= chain.positions.length;
    if (instanceCompleted) {
      completeChainInstance(task, frame);
    } else {
      execution.advancePending = true;
    }
    if (execution && execution.running && activeFrame()) {
      const current = activeFrame();
      $("activePosition").textContent = `CBP ${current.cbp + 1} · CMDP ${current.cmdp}`;
    }
    refreshRunStats();
    return true;
  }

  const command = chain.positions[frame.cmdp];
  execution.steps++;
  const prefix = `[CB#${task.id} · CBP ${frame.cbp + 1} · CMDP ${frame.cmdp}]`;
  const gridCommand = ["set", "if", "fill", "copy", "mv"].includes(command.name);
  if (gridCommand && !gridCells) {
    runtimeError("Grid is not initialized. Declare '@grid <width> <height>' before using grid commands.", command);
    return false;
  }
  const valueContext = { program: engine, chainIndex: frame.cbp, frame, task, state: { steps: 0 }, ownerCommand: command };
  const args = command.args.map(argument => evaluateValueArgument(argument, valueContext, command, 0));
  if (!execution || !execution.running) return false;

  function rectangleError(x1, y1, x2, y2, label) {
    if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0 ||
        x1 >= gridWidth || y1 >= gridHeight || x2 >= gridWidth || y2 >= gridHeight) {
      return `${label} rectangle out of bounds: (${x1},${y1}) to (${x2},${y2}). Valid coordinates are x=0–${gridWidth - 1}, y=0–${gridHeight - 1}.`;
    }
    return "";
  }

  function finishCommand(result, nextIndex = command.positionIndex + 1) {
    routeCommandResult(frame, command, result, nextIndex);
  }

  if (command.name === "group") {
    const childCount = command.program.chains.length;
    const groupEngineId = createEngineInstance(command.program, {
      parentEngineId: task.engineInstanceId,
      parentTaskId: task.id,
      parentCommand: command
    });
    task.waitingOnEngineId = groupEngineId;
    task.waitingOnEngineCommand = command;
    for (let cbp = 0; cbp < childCount; cbp++) {
      spawnChainInstance(command.program, cbp, {
        kind: "group",
        spawned: true,
        parentId: task.id,
        groupInstanceId: groupEngineId,
        engineInstanceId: groupEngineId
      });
    }
    appendTrace(`${prefix} [...] activated isolated engine #${groupEngineId} with ${childCount} internal Chain Block instance(s); parent CB#${task.id} is suspended until the engine terminates.`);
  } else if (command.name === "alwaysFalse") {
    appendTrace(`${prefix} -  Boolean CMDB · return false`);
    finishCommand(false);
  } else if (command.name === "alwaysTrue") {
    appendTrace(`${prefix} +  Boolean CMDB · return true`);
    finishCommand(true);
  } else if (command.name === "stepDelay") {
    task.stepDelayCommand = command;
    appendTrace(`${prefix} ~  Step Delayer · CMDP remains at ${frame.cmdp} for one interpreter step before advancing.`);
  } else if (command.name === "slp") {
    const milliseconds = args[0];
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 2147483647) {
      runtimeError(`slp() requires a non-negative integer duration from 0 to 2147483647 milliseconds; received '${milliseconds}'.`, command);
      return false;
    }
    if (milliseconds === 0) {
      appendTrace(`${prefix} slp(0)  no waiting required · return true`);
      finishCommand(true);
    } else {
      task.sleepStartedAt = performance.now();
      task.sleepUntil = task.sleepStartedAt + milliseconds;
      task.sleepCommand = command;
      appendTrace(`${prefix} slp(${milliseconds})  suspended this CB instance until its sleep expires; CMDP remains at ${frame.cmdp}. Other Chain Block instances continue.`);
    }
  } else if (command.name === "set" || command.name === "if") {
    const [x, y, b] = args;
    if (b !== 0 && b !== 1) {
      runtimeError(`${command.name}() Boolean parameter must be 0 or 1; received '${b}'.`, command);
      return false;
    }
    if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) {
      const action = command.name === "set" ? "setting" : "checking";
      runtimeError(`Grid coordinate out of bounds while ${action} (${x}, ${y}). Valid coordinates are x=0–${gridWidth - 1}, y=0–${gridHeight - 1}.`, command);
      return false;
    }
    if (command.name === "set") {
      const before = gridCells[y][x] ? 1 : 0;
      gridCells[y][x] = b;
      appendTrace(`${prefix} set(${x},${y},${b})  cell (${x},${y}): ${before} → ${b} · return true`);
      execution.lastCell = { x, y };
      finishCommand(true);
      drawGrid();
    } else {
      const actual = gridCells[y][x] ? 1 : 0;
      const passed = actual === b;
      appendTrace(`${prefix} if(${x},${y},${b})  cell value ${actual} → ${passed ? "true" : "false"}`);
      finishCommand(passed);
    }
  } else if (command.name === "fill") {
    const [x1, y1, x2, y2, value] = args;
    if (value !== 0 && value !== 1) {
      runtimeError(`fill() Boolean parameter must be 0 or 1; received '${value}'.`, command);
      return false;
    }
    const error = rectangleError(x1, y1, x2, y2, "Fill");
    if (error) { runtimeError(error, command); return false; }
    const area = normalizeArea(x1, y1, x2, y2);
    for (let y = area.top; y <= area.bottom; y++) for (let x = area.left; x <= area.right; x++) gridCells[y][x] = value;
    appendTrace(`${prefix} fill(${x1},${y1},${x2},${y2},${value})  normalized to (${area.left},${area.top})–(${area.right},${area.bottom}); filled ${area.right - area.left + 1} × ${area.bottom - area.top + 1} cell(s) with ${value} · return true`);
    finishCommand(true);
    drawGrid();
  } else if (command.name === "copy") {
    const [sx, sy, ex, ey, dx, dy] = args;
    const sourceError = rectangleError(sx, sy, ex, ey, "Copy source");
    if (sourceError) { runtimeError(sourceError, command); return false; }
    const sourceArea = normalizeArea(sx, sy, ex, ey);
    const copyWidth = sourceArea.right - sourceArea.left + 1;
    const copyHeight = sourceArea.bottom - sourceArea.top + 1;
    const destinationEndX = dx + copyWidth - 1;
    const destinationEndY = dy + copyHeight - 1;
    const destinationError = rectangleError(dx, dy, destinationEndX, destinationEndY, "Copy destination");
    if (destinationError) { runtimeError(destinationError, command); return false; }
    const snapshot = Array.from({ length: copyHeight }, (_, row) => gridCells[sourceArea.top + row].slice(sourceArea.left, sourceArea.right + 1));
    for (let row = 0; row < copyHeight; row++) for (let col = 0; col < copyWidth; col++) gridCells[dy + row][dx + col] = snapshot[row][col];
    appendTrace(`${prefix} copy(${sx},${sy},${ex},${ey},${dx},${dy})  normalized source to (${sourceArea.left},${sourceArea.top})–(${sourceArea.right},${sourceArea.bottom}); copied ${copyWidth} × ${copyHeight} cell(s) · return true`);
    finishCommand(true);
    drawGrid();
  } else if (command.name === "mv") {
    const [seedX, seedY, offset, axis] = args;
    if (offset !== 0 && offset !== 1) {
      runtimeError(`MV movement offset must be 0 or 1; received '${offset}'.`, command);
      return false;
    }
    if (![ -1, 0, 1 ].includes(axis)) {
      runtimeError(`MV movement axis must be -1, 0, or 1; received '${axis}'.`, command);
      return false;
    }
    const { x: sx, y: sy } = movementReference(valueContext, seedX, seedY);
    const step = offset === 1 ? 1 : -1;
    const dx = sx + (axis === 0 || axis === -1 ? step : 0);
    const dy = sy + (axis === 1 || axis === -1 ? step : 0);
    if (sx < 0 || sy < 0 || sx >= gridWidth || sy >= gridHeight) {
      runtimeError(`MV source coordinate out of bounds at (${sx},${sy}). Valid coordinates are x=0–${gridWidth - 1}, y=0–${gridHeight - 1}.`, command);
      return false;
    }
    if (dx < 0 || dy < 0 || dx >= gridWidth || dy >= gridHeight) {
      runtimeError(`MV destination coordinate out of bounds at (${dx},${dy}). Valid coordinates are x=0–${gridWidth - 1}, y=0–${gridHeight - 1}.`, command);
      return false;
    }
    const sourceValue = gridCells[sy][sx] ? 1 : 0;
    const destinationBefore = gridCells[dy][dx] ? 1 : 0;
    gridCells[sy][sx] = sourceValue === 1 ? 0 : 1;
    gridCells[dy][dx] = sourceValue;
    updateMovementReference(valueContext, dx, dy);
    execution.lastCell = { x: dx, y: dy };
    execution.lastMoveReference = { x: dx, y: dy };
    appendTrace(`${prefix} mv(${seedX},${seedY},${offset},${axis})  reference (${sx},${sy}) → (${dx},${dy}) · source ${sourceValue} → ${sourceValue ? 0 : 1}, destination ${destinationBefore} → ${sourceValue} · return true`);
    finishCommand(true);
    drawGrid();
  } else if (command.name === "jmp") {
    const target = frame.cmdp + args[0];
    const last = chain.positions.length - 1;
    if (target < 0 || target > last) {
      runtimeError(`Jump target out of range. jmp(${args[0]}) from CMDP ${frame.cmdp} resolves to CMDP ${target}; valid positions in this Chain Block are 0–${last}.`, command);
      return false;
    }
    const previous = frame.cmdp;
    frame.lastResult = true;
    frame.reachedTerminator = false;
    frame.cmdp = target;
    activateFrame(frame);
    saveCurrentPosition();
    appendTrace(`${prefix} jmp(${args[0]})  CMDP overridden: ${previous} → ${target} · connector after jmp() is bypassed`);
  } else if (command.name === "jmpc" || command.name === "call") {
    const targetCbp = frame.cbp + args[0];
    const lastCbp = engine.chains.length - 1;
    if (targetCbp < 0 || targetCbp > lastCbp) {
      runtimeError(`Chain target out of range. ${command.name}(${args[0]}) from CBP ${frame.cbp + 1} resolves to CBP ${targetCbp + 1}; valid CBPs in this engine are 1–${lastCbp + 1}.`, command);
      return false;
    }

    if (command.name === "jmpc") {
      // jmpc is a synchronous, suspending chain call: the caller's CMDP stays
      // on this exact CMDB until this newly-created child instance exits.
      const spawned = spawnChainInstance(engine, targetCbp, {
        kind: "jmpc",
        spawned: true,
        parentId: task.id,
        groupInstanceId: task.groupInstanceId,
        engineInstanceId: task.engineInstanceId,
        waiter: { taskId: task.id, command }
      });
      if (!spawned) {
        runtimeError("jmpc() could not create the requested Chain Block instance.", command);
        return false;
      }
      task.waitingOnTaskId = spawned.id;
      task.waitingCommand = command;
      appendTrace(`${prefix} jmpc(${args[0]})  activated fresh CB#${spawned.id} at CBP ${targetCbp + 1} · caller suspended at CMDP ${frame.cmdp} until that exact instance exits`);
    } else {
      // call remains a fire-and-forget activation. It creates an independent
      // instance but does not suspend or receive a result in the caller.
      const spawned = spawnChainInstance(engine, targetCbp, {
        kind: "call",
        spawned: true,
        parentId: task.id,
        groupInstanceId: task.groupInstanceId,
        engineInstanceId: task.engineInstanceId
      });
      if (!spawned) {
        runtimeError("call() could not create the requested Chain Block instance.", command);
        return false;
      }
      appendTrace(`${prefix} call(${args[0]})  activated fresh CB#${spawned.id} at CBP ${targetCbp + 1} · caller continues immediately`);
      finishCommand(true);
    }
  }

  let instanceCompleted = false;
  if (execution && execution.running && task.sleepUntil === null && frame.cmdp >= chain.positions.length) {
    instanceCompleted = completeChainInstance(task, frame);
  }
  if (execution && execution.running) {
    const current = activeFrame();
    if (current) $("activePosition").textContent = `CBP ${current.cbp + 1} · CMDP ${current.cmdp}`;
    execution.advancePending = !instanceCompleted;
  }
  refreshRunStats();
  return true;
}

function isRapid() { return $("speed").value === "rapid"; }

function scheduleNext() {
  if (!execution || !execution.running || execution.paused) return;
  clearTimeout(executionTimer);
  executionTimer = 0;

  const now = performance.now();
  const runnable = execution.tasks.filter(task =>
    task.waitingOnTaskId === null && task.waitingOnEngineId === null && (task.sleepUntil === null || task.sleepUntil <= now)
  );
  if (!runnable.length) {
    const deadlines = execution.tasks
      .filter(task => task.waitingOnTaskId === null && Number.isFinite(task.sleepUntil))
      .map(task => task.sleepUntil);
    if (deadlines.length) {
      const wakeAt = Math.min(...deadlines);
      executionTimer = setTimeout(() => {
        executionTimer = 0;
        scheduleNext();
      }, Math.max(1, wakeAt - now));
    } else if (execution.tasks.length && execution.tasks.every(task =>
      task.waitingOnTaskId !== null || task.waitingOnEngineId !== null
    )) {
      runtimeError("Deadlock: every active Chain Block instance is waiting for another instance or isolated engine, and no runnable path can finish the wait.", null);
    }
    return;
  }

  if (isRapid()) {
    executionTimer = setTimeout(rapidSlice, 0);
    return;
  }
  const delay = Math.max(0, Number($("speed").value) || 0);
  executionTimer = setTimeout(() => {
    executionTimer = 0;
    if (!execution || !execution.running || execution.paused) return;
    executeOne();
    if (execution && execution.running && !execution.paused) scheduleNext();
  }, delay);
}

const RAPID_SLICE_MS = 20;
const RAPID_CHECK_EVERY = 64;
function rapidSlice() {
  executionTimer = 0;
  if (!execution || !execution.running || execution.paused) return;
  const started = performance.now();
  let n = 0;
  beginBatch();
  try {
    while (execution && execution.running && !execution.paused) {
      if (!executeOne()) break;
      if (++n % RAPID_CHECK_EVERY === 0 && performance.now() - started > RAPID_SLICE_MS) break;
    }
  } finally {
    endBatch();
  }
  if (execution && execution.running && !execution.paused) scheduleNext();
}

function runProgram() {
  clearTimeout(executionTimer);
  executionTimer = 0;
  execution = null;
  clearTrace();
  selectedCell = null;
  gridCells = null;
  gridWidth = 0;
  gridHeight = 0;
  $("cellInspector").textContent = "Tap or click a cell to select it and toggle its value.";
  $("gridDimensions").textContent = "Not initialized";
  $("gridStats").textContent = "";
  $("executionStats").textContent = "0 steps";
  $("activePosition").textContent = "";
  $("pauseResume").textContent = "Pause";
  setRunStatus("Compiling");
  $("runMessage").textContent = "Compiling source code…";
  showRunner();

  let program;
  try {
    program = GridLanguage.compile(Editor.getValue());
  } catch (error) {
    setRunStatus("Compilation failed", "trace-error");
    const message = error && typeof error.toString === "function" ? error.toString() : String(error);
    $("runMessage").textContent = message;
    appendTrace(message, "error");
    drawGrid();
    return;
  }

  if (program.grid) {
    gridWidth = program.grid.width;
    gridHeight = program.grid.height;
    gridCells = Array.from({ length: gridHeight }, () => Array(gridWidth).fill(0));
    $("gridDimensions").textContent = `${gridWidth} × ${gridHeight}`;
  } else {
    $("gridDimensions").textContent = "Grid initialization missing";
  }
  drawGrid();
  execution = {
    program,
    tasks: [],
    activeTaskIndex: 0,
    frames: [],
    nextTaskId: 1,
    nextGroupInstanceId: 1,
    nextEngineInstanceId: 1,
    rootEngineId: null,
    engines: new Map(),
    advancePending: false,
    cbp: 0,
    cmdp: 0,
    steps: 0,
    running: true,
    paused: false,
    lastCell: null,
    lastMoveReference: null
  };
  // The root program is one engine scope. Each top-level CB starts as an
  // independent instance owned by that engine.
  execution.rootEngineId = createEngineInstance(program, { isRoot: true });
  // The cooperative scheduler gives each runnable instance one CMDB turn at a time.
  for (let cbp = 0; cbp < program.chains.length; cbp++) {
    spawnChainInstance(program, cbp, {
      kind: "root",
      spawned: false,
      engineInstanceId: execution.rootEngineId
    });
  }
  syncActiveTask();
  const firstFrame = activeFrame();
  if (firstFrame) activateFrame(firstFrame);
  appendTrace(`Compilation successful: ${program.chains.length} root Chain Block(s), ${program.commandCount} CMDB position(s).`, "ok");
  if (program.grid) appendTrace(`Grid initialized: ${program.grid.width} × ${program.grid.height}.`, "dim");
  appendTrace(`Execution started: ${execution.tasks.length} independent root Chain Block instance(s) activated.`, "dim");
  setRunStatus("Running", "trace-ok");
  $("runMessage").textContent = "Program is running.";
  if (!execution.tasks.length) {
    finishExecution("done", "Program contains no executable Chain Blocks.");
    return;
  }
  scheduleNext();
}

$("run").addEventListener("click", runProgram);
$("restart").addEventListener("click", runProgram);
$("pauseResume").addEventListener("click", () => {
  if (!execution || !execution.running) return;
  execution.paused = !execution.paused;
  if (execution.paused) {
    clearTimeout(executionTimer);
    executionTimer = 0;
    $("pauseResume").textContent = "Resume";
    setRunStatus("Paused");
    $("runMessage").textContent = "Execution paused.";
  } else {
    $("pauseResume").textContent = "Pause";
    setRunStatus("Running", "trace-ok");
    $("runMessage").textContent = "Program is running.";
    scheduleNext();
  }
});
$("stepOnce").addEventListener("click", () => {
  if (!execution || !execution.running) return;
  if (!execution.paused) {
    execution.paused = true;
    clearTimeout(executionTimer);
    executionTimer = 0;
  }
  $("pauseResume").textContent = "Resume";
  setRunStatus("Stepping");
  executeOne();
  if (execution && execution.running) {
    execution.paused = true;
    $("pauseResume").textContent = "Resume";
    setRunStatus("Paused");
  }
});
$("stop").addEventListener("click", () => {
  if (!execution || !execution.running) return;
  finishExecution("stopped");
});
$("clearTrace").addEventListener("click", clearTrace);
$("speed").addEventListener("change", () => {
  // Apply a new speed immediately to a run that is in progress.
  if (execution && execution.running && !execution.paused) scheduleNext();
});
(function initBorderToggle() {
  const box = $("gridBorder");
  try {
    const saved = localStorage.getItem(BORDER_KEY);
    if (saved === "0") box.checked = false;
    else if (saved === "1") box.checked = true;
  } catch (error) { /* storage unavailable */ }
  box.addEventListener("change", () => {
    try { localStorage.setItem(BORDER_KEY, box.checked ? "1" : "0"); } catch (error) { /* no-op */ }
    drawGrid();
  });
})();
function setLogsVisible(visible) {
  const panel = $("tracePanel");
  const layout = $("runLayout");
  const button = $("toggleLogs");
  panel.hidden = !visible;
  layout.classList.toggle("logs-hidden", !visible);
  button.textContent = visible ? "Hide logs" : "Show logs";
  button.setAttribute("aria-expanded", String(visible));
}
$("toggleLogs").addEventListener("click", () => setLogsVisible($("tracePanel").hidden));
$("backToEditor").addEventListener("click", () => {
  if (execution && execution.running) finishExecution("stopped", "Execution stopped when returning to the editor.");
  showEditor();
});
function gridCellFromEvent(event) {
  if (!drawMetrics || !gridCells) return null;
  const rect = event.currentTarget.getBoundingClientRect();
  const xPx = event.clientX - rect.left;
  const yPx = event.clientY - rect.top;
  const x = Math.floor((xPx - drawMetrics.ox) / drawMetrics.cell);
  const y = Math.floor((yPx - drawMetrics.oy) / drawMetrics.cell);
  if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) return null;
  return { x, y };
}

$("gridCanvas").addEventListener("click", event => {
  const cell = gridCellFromEvent(event);
  if (cell) toggleCell(cell.x, cell.y);
});

window.addEventListener("resize", () => {
  if (!$("runView").hidden) drawGrid();
  if (!$("fileMenu").hidden) placePopup($("fileMenu"), $("fileMenuBtn"));
  if (!$("editorMenu").hidden) placePopup($("editorMenu"), $("editorMenuBtn"));
  if (!$("docsPanel").hidden) placePopup($("docsPanel"), $("docsBtn"), true);
});

// Make the editor immediately usable from the phone's on-screen keyboard.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && execution && execution.running && !execution.paused) {
    // Do not silently stop a program when the browser tab loses focus.
    // The execution-step limit still prevents unbounded loops.
  }
});


// Keep the page itself pinned. Long source lines scroll inside the editor
// (#ed); if the browser tries to scroll the page or a container to reveal the
// caret, put the header and layout back in place.
(function pinLayout() {
  const reset = () => {
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollLeft || root.scrollTop) { root.scrollLeft = 0; root.scrollTop = 0; }
    if (document.body.scrollLeft || document.body.scrollTop) { document.body.scrollLeft = 0; document.body.scrollTop = 0; }
    for (const id of ["editorView", "runView"]) {
      const el = document.getElementById(id);
      if (el && (el.scrollLeft || el.scrollTop)) { el.scrollLeft = 0; el.scrollTop = 0; }
    }
  };
  window.addEventListener("scroll", reset, { passive: true });
  document.addEventListener("scroll", reset, { passive: true, capture: true });
  for (const id of ["editorView", "runView"]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("scroll", reset, { passive: true });
  }
  if (window.visualViewport) window.visualViewport.addEventListener("scroll", reset, { passive: true });
})();
