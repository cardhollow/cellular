"use strict";

const Editor = (() => {
  const g = id => document.getElementById(id);
  const ed = g("ed"), box = g("lines"), rowsEl = g("rows"), taEl = g("ta"), curEl = g("cur"),
        clEl = g("curline"), selBox = g("selbox"), pairEl = g("pairbox"), multiEl = g("multi"),
        pop = g("pop"), sigEl = g("sig"), posEl = g("pos"),
        contextMenuEl = g("contextMenu"), contextNoticeEl = g("contextNotice"),
        diagnosticPopupEl = g("diagnosticPopup"), diagnosticMessageEl = g("diagnosticMessage");
  const searchBar = g("searchbar"), findInput = g("findq"), replaceInput = g("replaceq"),
        replaceRow = g("replaceRow"), findCase = g("findCase"), findRegex = g("findRegex"), findStatus = g("findStatus");
  const gotoBar = g("gotoBar"), gotoInput = g("gotoLine"), gotoStatus = g("gotoStatus");
  let findMatches = [], activeFindIndex = -1;
  let searchTimer = 0, searchRequest = 0, searchWorker = null, searchWorkerUrl = null;
  let sourceVersion = 0, searchReadyKey = "", pendingFindNavigation = null, pendingFindSelection = null;
  const LH = 18, PAD = 6;
  const W = s => s.trim() ? s.trim().split(/\s+/) : [];
  const KW = new Set();
  const LIT = new Set(W("0 1"));
  const BIF = W("set() if() fill() copy() mv() jmp() jmpc() call() slp()");
  const BIO = [];
  const BI = new Set([...BIF.map(x => x.replace("()", "")), "grid"]);
  const EV = "";
  const MEM = {};
  const GEN = "";

  const SIG = Object.create(null);
  (function () {
    SIG.set = "x, y, b";
    SIG.if = "x, y, expectedBoolean";
    SIG.fill = "x1, y1, x2, y2, value";
    SIG.copy = "sx, sy, ex, ey, dx, dy";
    SIG.mv = "sx, sy, movementOffset (0 or 1), movementAxis (-1, 0, or 1)";
    SIG.jmp = "codePositionOffset";
    SIG.jmpc = "chainOffset";
    SIG.call = "chainOffset";
    SIG.slp = "milliseconds (integer 0–2147483647)";
    SIG.areaCount = "sx, sy, ex, ey, b (0 or 1)";
  })();

  const SNIPS = [
    ["grid", "grid initialization", "@grid 5 5\n$0"],
    ["setcell", "set a cell", "set(0,0,1)"],
    ["checkcell", "check a cell", "if(0,0,1)"],
    ["fillrect", "fill a rectangular region", "fill(0,0,3,3,1)"],
    ["copyrect", "copy a rectangular region", "copy(0,0,2,2,5,5)"],
    ["move", "exchange a cell with an adjacent cell", "mv(0,0,1,0)"],
    ["jump", "relative program jump", "jmp(1)"],
    ["jumpchain", "wait for a fresh instance of a relative chain to exit", "jmpc(1)"],
    ["callchain", "activate a new independent chain instance", "call(1)"],
    ["sleep", "suspend this chain instance for milliseconds", "slp(1000)"],
    ["stepdelay", "hold CMDP for one interpreter step before advancing", "~"],
    ["branch", "conditional reference connector after a CMDB", "?:$0"],
    ["reference", "conditional reference paired with ?:", ">:$0"],
    ["returnee", "Returnee: redirect CMDP to the terminal semicolon", "<:$0"],
    ["enginekill", "terminate this engine and all nested engines; return the left CMDB result", "+&!"],
    ["foldblock", "insert an FCBC comment region", "#<block>#\n$0\n#</block>#"],
    ["group", "insert an IGCB", "[\n$0\n+;\n]"],
    ["cmdbve", "insert a CMDB Value Expression", "<$0>"],
    ["countve", "insert an area-count Value Expression", "<{0,0,4,4,1}>"],
    ["stop", "a zero-parameter CMDB that returns false", "-"],
    ["alwaystrue", "a zero-parameter CMDB that returns true", "+"],
    ["chain", "run the next command block when true", ":$0"],
    ["endchain", "terminate the current chain block", ";\n$0"]
  ];
  const GLOBALS = [
    ...[...KW, ...LIT].map(m => ({ m, k: "k" })),
    ...BIF.map(x => { const m = x.replace("()", ""); return { m, k: "f", fn: 1, p: SIG[m] }; }),
    ...SNIPS.map(([m, d, t]) => ({ m, d, t, k: "s" }))
  ];
  const mkMem = () => [];
  const MEMI = {};
  const GENI = [];

  let CW = 8.4, GW = 0, digits = 2;
  let lines = [""], cur = { l: 0, c: 0 }, anc = { l: 0, c: 0 }, want = -1;
  let extra = [], diagPairs = new Map(), diagUnused = new Set(), diagDead = [], diagStarts = [];
  let toks = [[]], ranges = new Map(), folded = new Set(), vis = [0], vmap = [0], lastOn = null;
  let commentStateAtLine = [], commentStartAtLine = [], commentStateAfterLine = [], commentStartAfterLine = [];
  let pendingSimpleMutation = null, pendingNativeEdit = null, maxLineColumns = 0;
  let defs = new Map(), sigHide = false;
  let dirty = true, undoS = [], redoS = [], lastKind = "", lastT = 0, comp = false, dragging = false, draggingExtra = -1;
  let onRun = () => {}, onChange = () => {};
  let liveDiagnostic = null, diagnosticTimer = 0;
  let sourceCache = null, lineStarts = [], lineOffsetsValid = false, lineOffsetsDirtyFrom = Infinity;
  let textareaMatchesSource = false;
  let renderedRows = new Map(), rowOffsets = [0], virtualStart = -1, virtualEnd = -1;
  let editorContentWidth = 1, editorContentHeight = LH, measured = false, scrollRenderPending = false;
  const VIRTUAL_OVERSCAN = 18;
  let items = [], sel = 0, popOpen = false, plen = 0;
  let nativeSelectionWrite = false;
  let wordWrap = false, readOnly = false;
  try {
    wordWrap = localStorage.getItem("cpl.editor.wordWrap") === "true";
    readOnly = localStorage.getItem("cpl.editor.readOnly") === "true";
  } catch (_) {}

  const esc = s => s.replace(/[&<>]/g, c => c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isW = ch => /[\w$]/.test(ch || "");
  const hasSel = () => cur.l !== anc.l || cur.c !== anc.c;
  const before = (a, b) => a.l < b.l || (a.l === b.l && a.c <= b.c);
  const order = () => before(anc, cur) ? [anc, cur] : [cur, anc];
  const selText = () => {
    const [a, b] = order();
    return a.l === b.l ? lines[a.l].slice(a.c, b.c)
      : [lines[a.l].slice(a.c), ...lines.slice(a.l + 1, b.l), lines[b.l].slice(0, b.c)].join("\n");
  };
  const extraHasSel = p => !!p.a && (p.a.l !== p.l || p.a.c !== p.c);
  const extraSelText = p => {
    if (!extraHasSel(p)) return "";
    const a = offsetAt(p.a), b = offsetAt(p);
    const text = source(); return text.slice(Math.min(a, b), Math.max(a, b));
  };
  const norm = t => t.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  const source = () => sourceCache === null ? (sourceCache = lines.join("\n")) : sourceCache;
  function invalidateSource() {
    sourceCache = null;
    sourceVersion++;
    lineOffsetsValid = false;
    lineOffsetsDirtyFrom = 0;
    textareaMatchesSource = false;
  }
  function ensureLineOffsetsThrough(line) {
    if (!lineOffsetsValid || lineOffsetsDirtyFrom === Infinity || line < lineOffsetsDirtyFrom) return;
    const first = Math.max(1, lineOffsetsDirtyFrom);
    let offset = (lineStarts[first - 1] || 0) + lines[first - 1].length + 1;
    for (let i = first; i <= line && i < lines.length; i++) {
      lineStarts[i] = offset;
      offset += lines[i].length + 1;
    }
    lineOffsetsDirtyFrom = line + 1 < lines.length ? line + 1 : Infinity;
  }
  function ensureAllLineOffsets() {
    if (!lineOffsetsValid || lineOffsetsDirtyFrom === Infinity) return;
    ensureLineOffsetsThrough(lines.length - 1);
  }
  const offsetAt = p => {
    if (lineOffsetsValid && lineStarts[p.l] !== undefined) {
      ensureLineOffsetsThrough(p.l);
      return lineStarts[p.l] + p.c;
    }
    return lines.slice(0, p.l).reduce((n, line) => n + line.length + 1, 0) + p.c;
  };
  function pointAt(n, text = source()) {
    n = clamp(n, 0, text.length);
    if (lineOffsetsValid && text === source()) {
      ensureAllLineOffsets();
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= n) lo = mid; else hi = mid - 1;
      }
      return { l: lo, c: Math.min(lines[lo].length, n - lineStarts[lo]) };
    }
    const part = text.slice(0, n), l = (part.match(/\n/g) || []).length, i = part.lastIndexOf("\n");
    return { l, c: n - (i + 1) };
  }

  // Convert an absolute source offset to the editor's line/column position.
  // Bracket-pair diagnostics use this helper when drawing matching delimiters.
  function pointForOffset(offset) {
    return pointAt(offset);
  }

  function updateNativeTextarea(caretX = null, caretY = null) {
    // Keep one stable, full-source textarea as the actual input surface.
    // A moving 2px per-line proxy proved unreliable on mobile WebViews: the
    // IME could lose focus and native Select All could escape into the page.
    // Large-file rendering is still virtualized and ordinary typing remains
    // line-local, so the DOM/highlighting work does not scale with file size.
    if (!comp && !textareaMatchesSource) {
      const text = source();
      if (taEl.value !== text) taEl.value = text;
      textareaMatchesSource = true;
    }
    taEl.style.left = (GW + PAD) + "px";
    taEl.style.top = "0px";
    taEl.style.width = Math.max(1, editorContentWidth - GW - PAD) + "px";
    taEl.style.height = Math.max(lines.length * LH, editorContentHeight, ed.clientHeight) + "px";
    // The textarea always contains the FULL source, including folded lines,
    // while the rendered editor uses a compressed visible-line map. Letting a
    // tap hit the textarea in folded mode makes the browser place its native
    // caret using uncompressed source coordinates. A tap below a fold can then
    // land inside hidden code and appear trapped in the folded block.
    // Route folded-mode pointer/touch placement through the editor's `hit()`
    // mapper instead. Programmatic focus still activates the mobile keyboard,
    // so typing remains native even though the textarea is not hit-testable.
    taEl.style.pointerEvents = (wordWrap || folded.size > 0) ? "none" : "auto";
    taEl.readOnly = readOnly;
    ed.classList.toggle("read-only", readOnly);
    ed.classList.toggle("word-wrap", wordWrap);
    for (const button of document.querySelectorAll(".mobile-tools button")) button.disabled = readOnly;
    for (const id of ["replaceOne", "replaceAll"]) { const button = g(id); if (button) button.disabled = readOnly; }
  }

  // Only push a selection into the native textarea after an editor command
  // deliberately moves the model caret. Do not do this during ordinary native
  // typing or selectionchange events: Android IMEs can emit delayed selection
  // events, and writing the model position back during those events can send
  // the caret to an old offset (often the beginning of the document).
  function writeNativeSelection() {
    if (comp) return;
    const start = offsetAt(anc), end = offsetAt(cur);
    const low = Math.min(start, end), high = Math.max(start, end);
    const direction = start <= end ? "forward" : "backward";
    if (taEl.selectionStart === low && taEl.selectionEnd === high &&
        (high === low || taEl.selectionDirection === direction)) return;
    nativeSelectionWrite = true;
    try { taEl.setSelectionRange(low, high, direction); } catch (_) { /* older WebView */ }
    requestAnimationFrame(() => { nativeSelectionWrite = false; });
  }

  function readNativeSelection() {
    if (nativeSelectionWrite || document.activeElement !== taEl || comp) return;
    // Ignore selectionchange events emitted while the browser has already
    // changed the textarea but before its corresponding input event updates
    // the editor model. Otherwise the old source text can reinterpret the new
    // native caret offset and make the caret jump to another character.
    if (!textareaMatchesSource || taEl.value !== source()) return;
    const start = taEl.selectionStart || 0;
    const end = taEl.selectionEnd || 0;
    const direction = taEl.selectionDirection || "forward";
    const expectedStart = offsetAt(anc), expectedEnd = offsetAt(cur);
    const expectedLow = Math.min(expectedStart, expectedEnd), expectedHigh = Math.max(expectedStart, expectedEnd);
    const expectedDirection = expectedStart <= expectedEnd ? "forward" : "backward";
    if (start === expectedLow && end === expectedHigh &&
        (start === end || direction === expectedDirection)) return;
    let a, b;
    if (start === end) {
      a = b = pointAt(start);
    } else if (direction === "backward") {
      a = pointAt(end);
      b = pointAt(start);
    } else {
      a = pointAt(start);
      b = pointAt(end);
    }
    if (offsetAt(a) === offsetAt(anc) && offsetAt(b) === offsetAt(cur)) return;
    anc = a;
    cur = b;
    extra = [];
    want = -1;
    sigHide = false;
    closePop();
    // Mirror the native textarea range into the editor's persistent selection
    // layer without refocusing or rewriting the textarea selection. This keeps
    // the highlight visible if a toolbar/menu interaction later blurs the input.
    renderSelectionHighlight();
    clEl.style.display = hasSel() ? "none" : "block";
    const opened = a.l === b.l && a.c === b.c ? reveal(cur.l) : revealSelection(a, b);
    if (opened) {
      // Only rebuild the editor when the range crosses folded source. For an
      // ordinary native drag-selection, avoid overlays()/textarea repositioning
      // because mobile browsers can dismiss the draggable selection handles.
      sync(true);
    } else if (hasSel()) {
      renderSelectionHighlight();
      clEl.style.display = "none";
    } else {
      // A collapsed caret has no native selection handles to preserve, so it
      // is safe to refresh the editor caret overlay.
      overlays(true);
    }
  }

  function applyNativeTextareaInput(inputEvent = null) {
    if (readOnly) { updateNativeTextarea(); writeNativeSelection(); return; }
    const edit = pendingNativeEdit;
    pendingNativeEdit = null;
    const rawNext = taEl.value;
    const rawInsert = inputEvent && typeof inputEvent.data === "string" ? inputEvent.data
      : edit && typeof edit.data === "string" ? edit.data : null;

    const previous = source();
    // Common typing stays line-local. The textarea has already inserted the
    // character, so update only the corresponding source line and tokens
    // instead of splitting and re-highlighting the entire document.
    if (edit && edit.inputType === "insertText" && rawInsert !== null &&
        !/[\r\n\t]/.test(rawInsert)) {
      const start = clamp(edit.start, 0, previous.length);
      const end = clamp(edit.end, start, previous.length);
      const expectedLength = previous.length - (end - start) + rawInsert.length;
      if (rawNext.length === expectedLength && rawNext.slice(start, start + rawInsert.length) === rawInsert) {
        let a, b;
        const [modelA, modelB] = order();
        if (offsetAt(modelA) === start && offsetAt(modelB) === end) {
          a = { ...modelA }; b = { ...modelB };
        } else {
          a = pointAt(start, previous); b = pointAt(end, previous);
        }
        if (a.l === b.l) {
          snap("type");
          replaceRange(a.l, a.c, b.l, b.c, rawInsert, true);
          extra = [];
          commit();
          return;
        }
      }
    }

    // Fallback for composition, multi-line paste/dictation, browser rewriting,
    // and any edit that cannot safely be represented as one line operation.
    const next = norm(rawNext);
    const normalizeOffset = rawOffset => norm(rawNext.slice(0, rawOffset)).length;
    const nativeStart = clamp(normalizeOffset(taEl.selectionStart ?? rawNext.length), 0, next.length);
    const nativeEnd = clamp(normalizeOffset(taEl.selectionEnd ?? nativeStart), 0, next.length);
    const nativeDirection = taEl.selectionDirection || "forward";
    const a = pointAt(nativeStart, next);
    const b = pointAt(nativeEnd, next);

    if (next !== previous) {
      snap("type");
      pendingSimpleMutation = null;
      const oldLineCount = lines.length;
      lines = next.split("\n");
      if (lines.length !== oldLineCount) folded.clear();
    }

    if (nativeStart === nativeEnd) { anc = { ...a }; cur = { ...a }; }
    else if (nativeDirection === "backward") { anc = b; cur = a; }
    else { anc = a; cur = b; }
    extra = [];

    if (taEl.value !== next) taEl.value = next;
    textareaMatchesSource = false;
    if (next !== previous) commit(false);
    else sync(false);
  }

  function insertLiteralPunctuation(ch) {
    if (readOnly) return false;
    const previous = source();
    if (taEl.value !== previous) return false;
    const start = clamp(taEl.selectionStart ?? offsetAt(cur), 0, previous.length);
    const end = clamp(taEl.selectionEnd ?? start, 0, previous.length);
    const [modelA, modelB] = order();
    const a = offsetAt(modelA) === start && offsetAt(modelB) === end
      ? { ...modelA } : pointAt(start, previous);
    const b = offsetAt(modelA) === start && offsetAt(modelB) === end
      ? { ...modelB } : pointAt(end, previous);
    snap("type");
    replaceRange(a.l, a.c, b.l, b.c, ch);
    extra = [];
    // Punctuation is inserted by the editor rather than the native input event.
    // Lines containing IGCB brackets require a full tokenize/render pass; that
    // pass may rewrite the textarea value, which resets its native caret to the
    // document end. Commit with selection restoration so the caret stays just
    // after the typed punctuation at its original location.
    commit(true);
    return true;
  }

  const NUM = /(?:0[xX][\da-fA-F_]+|0[bBoO][\d_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y;
  const ID = /[A-Za-z_$][\w$]*/y;
  const MATCH = { "(": ")", "[": "]", "{": "}" };
  const scanTpl = (s, j) => { while (j < s.length) { if (s[j] === "\\") j += 2; else if (s[j] === "`") return j + 1; else j++; } return -1; };

  function tokenize() {
    toks = []; ranges = new Map();
    lineStarts = new Array(lines.length);
    diagStarts = lineStarts;
    commentStateAtLine = new Array(lines.length);
    commentStartAtLine = new Array(lines.length);
    commentStateAfterLine = new Array(lines.length);
    commentStartAfterLine = new Array(lines.length);
    let sourceOffset = 0;
    let inComment = false, commentStartLine = -1;
    const foldStack = [];
    for (let l = 0; l < lines.length; l++) {
      const s = lines[l], t = [];
      lineStarts[l] = sourceOffset;
      sourceOffset += s.length + 1;
      commentStateAtLine[l] = inComment;
      commentStartAtLine[l] = commentStartLine;
      const trimmed = s.trim();
      const openBlock = /^#<([^\/>\r\n][^>\r\n]*)>#$/.exec(trimmed);
      const closeBlock = /^#<\/([^>\r\n]+)>#$/.exec(trimmed);
      // FCBC header/footer lines are ordinary single-line comments. The
      // named pair only defines an editor fold; all lines between the markers
      // are highlighted and edited as normal executable CPL source.
      if (openBlock) {
        if (s.length) t.push({ s: 0, e: s.length, k: "com" });
        foldStack.push({ name: openBlock[1], line: l });
        toks.push(t);
        commentStateAfterLine[l] = inComment;
        commentStartAfterLine[l] = commentStartLine;
        continue;
      }
      if (closeBlock) {
        if (s.length) t.push({ s: 0, e: s.length, k: "com" });
        const active = foldStack[foldStack.length - 1];
        if (active && active.name === closeBlock[1]) {
          foldStack.pop();
          ranges.set(active.line, { from: active.line + 1, to: l });
        }
        toks.push(t);
        commentStateAfterLine[l] = inComment;
        commentStartAfterLine[l] = commentStartLine;
        continue;
      }
      let i = 0;
      while (i < s.length) {
        if (inComment) {
          const close = s.indexOf("#", i);
          const e = close < 0 ? s.length : close + 1;
          if (e > i) t.push({ s: i, e, k: "com" });
          i = e;
          if (close >= 0) {
            if (commentStartLine >= 0 && l > commentStartLine) ranges.set(commentStartLine, { from: commentStartLine + 1, to: l });
            inComment = false;
            commentStartLine = -1;
          }
          continue;
        }
        if (s[i] === "#") {
          const close = s.indexOf("#", i + 1);
          const e = close < 0 ? s.length : close + 1;
          t.push({ s: i, e, k: "com" });
          i = e;
          if (close < 0) { inComment = true; commentStartLine = l; }
          continue;
        }
        if (/\s/.test(s[i])) { i++; continue; }
        if (s.startsWith("<:", i) || s.startsWith("?:", i) || s.startsWith(">:", i) || s.startsWith("&!", i)) {
          t.push({ s: i, e: i + 2, k: "cc" }); i += 2; continue;
        }
        if (s[i] === ":") { t.push({ s: i, e: i + 1, k: "cc" }); i++; continue; }
        if ((s[i] === "<" && s[i + 1] !== ":") || (s[i] === ">" && s[i + 1] !== ":") || s[i] === "{" || s[i] === "}") { t.push({ s: i, e: i + 1, k: "ve" }); i++; continue; }
        if ((s[i] === "-" || s[i] === "+") && !/\d/.test(s[i + 1] || "")) { t.push({ s: i, e: i + 1, k: "fnc" }); i++; continue; }
        if (s.startsWith("@grid", i) && !/[\w$]/.test(s[i + 5] || "")) {
          t.push({ s: i, e: i + 5, k: "dir" }); i += 5; continue;
        }
        const id = /^[A-Za-z_][A-Za-z_0-9]*/.exec(s.slice(i));
        if (id) {
          const word = id[0], e = i + word.length;
          const k = ["set", "if", "fill", "copy", "mv", "jmp", "jmpc", "call", "slp"].includes(word) ? "fnc" : KW.has(word) ? "kw" : "";
          if (k) t.push({ s: i, e, k });
          i = e; continue;
        }
        const num = /^-?\d+/.exec(s.slice(i));
        if (num && (i === 0 || !/[A-Za-z_0-9]/.test(s[i - 1]))) {
          const e = i + num[0].length;
          t.push({ s: i, e, k: (num[0] === "0" || num[0] === "1") ? "lit" : "num" });
          i = e; continue;
        }
        i++;
      }
      toks.push(t);
      commentStateAfterLine[l] = inComment;
      commentStartAfterLine[l] = commentStartLine;
    }

    // A multi-line square-bracket group is also an editor fold region.
    // The range is derived from the same token stream as highlighting, so
    // brackets inside comments are ignored. Track all bracket kinds so a
    // nested CMDB call or VE does not accidentally close an outer group.
    const bracketStack = [];
    const bracketClose = { ")": "(", "]": "[", "}": "{" };
    for (let l = 0; l < lines.length; l++) {
      const text = lines[l], lineTokens = toks[l] || [];
      let tokenIndex = 0;
      for (let i = 0; i < text.length; i++) {
        while (tokenIndex < lineTokens.length && lineTokens[tokenIndex].e <= i) tokenIndex++;
        const token = lineTokens[tokenIndex];
        if (token && i >= token.s && i < token.e && token.k === "com") {
          i = token.e - 1;
          continue;
        }
        const ch = text[i];
        if (ch === "(" || ch === "[" || ch === "{") {
          bracketStack.push({ ch, line: l });
        } else if (ch === ")" || ch === "]" || ch === "}") {
          const top = bracketStack[bracketStack.length - 1];
          if (top && top.ch === bracketClose[ch]) {
            bracketStack.pop();
            if (top.ch === "[" && l > top.line) {
              ranges.set(top.line, { from: top.line + 1, to: l });
            }
          }
        }
      }
    }

    lineOffsetsValid = true;
    lineOffsetsDirtyFrom = Infinity;
  }

  function tokenizeSingleLine(l) {
    const s = lines[l], t = [];
    const trimmed = s.trim();
    const openBlock = /^#<([^\/>\r\n][^>\r\n]*)>#$/.exec(trimmed);
    const closeBlock = /^#<\/([^>\r\n]+)>#$/.exec(trimmed);
    if (openBlock || closeBlock) return { marker: true, tokens: t };
    let inComment = !!commentStateAtLine[l];
    let commentStartLine = commentStartAtLine[l] ?? -1;
    let i = 0;
    while (i < s.length) {
      if (inComment) {
        const close = s.indexOf("#", i);
        const e = close < 0 ? s.length : close + 1;
        if (e > i) t.push({ s: i, e, k: "com" });
        i = e;
        if (close >= 0) {
          inComment = false;
          commentStartLine = -1;
        }
        continue;
      }
      if (s[i] === "#") {
        const close = s.indexOf("#", i + 1);
        const e = close < 0 ? s.length : close + 1;
        t.push({ s: i, e, k: "com" });
        i = e;
        if (close < 0) { inComment = true; commentStartLine = l; }
        continue;
      }
      if (/\s/.test(s[i])) { i++; continue; }
      if (s.startsWith("<:", i) || s.startsWith("?:", i) || s.startsWith(">:", i) || s.startsWith("&!", i)) {
        t.push({ s: i, e: i + 2, k: "cc" }); i += 2; continue;
      }
      if (s[i] === ":") { t.push({ s: i, e: i + 1, k: "cc" }); i++; continue; }
      if ((s[i] === "<" && s[i + 1] !== ":") || (s[i] === ">" && s[i + 1] !== ":") || s[i] === "{" || s[i] === "}") { t.push({ s: i, e: i + 1, k: "ve" }); i++; continue; }
      if ((s[i] === "-" || s[i] === "+") && !/\d/.test(s[i + 1] || "")) { t.push({ s: i, e: i + 1, k: "fnc" }); i++; continue; }
      if (s.startsWith("@grid", i) && !/[\w$]/.test(s[i + 5] || "")) { t.push({ s: i, e: i + 5, k: "dir" }); i += 5; continue; }
      const id = /^[A-Za-z_][A-Za-z_0-9]*/.exec(s.slice(i));
      if (id) {
        const word = id[0], e = i + word.length;
        const k = ["set", "if", "fill", "copy", "mv", "jmp", "jmpc", "call", "slp"].includes(word) ? "fnc" : KW.has(word) ? "kw" : "";
        if (k) t.push({ s: i, e, k });
        i = e; continue;
      }
      const num = /^-?\d+/.exec(s.slice(i));
      if (num && (i === 0 || !/[A-Za-z_0-9]/.test(s[i - 1]))) {
        const e = i + num[0].length;
        t.push({ s: i, e, k: (num[0] === "0" || num[0] === "1") ? "lit" : "num" });
        i = e; continue;
      }
      i++;
    }
    return { marker: false, tokens: t, inComment, commentStartLine };
  }

  function analyseDiagnostics() {
    diagPairs = new Map(); diagUnused = new Set(); diagDead = []; diagStarts = [];
    const stack = [];
    let total = 0;
    for (let l = 0; l < lines.length; l++) {
      diagStarts[l] = total;
      const s = lines[l], ts = toks[l] || [];
      let ti = 0;
      for (let i = 0; i < s.length; i++) {
        while (ti < ts.length && ts[ti].e <= i) ti++;
        const token = ti < ts.length && i >= ts[ti].s ? ts[ti] : null;
        if (token && (token.k === "com" || token.k === "str")) { i = token.e - 1; continue; }
        if (s[i] === "(" || s[i] === "[" || s[i] === "{") stack.push({ ch: s[i], offset: total + i });
        else if (s[i] === "<" && s[i + 1] !== ":") stack.push({ ch: "<", offset: total + i });
        else if (s[i] === ">" && s[i + 1] !== ":") {
          const top = stack[stack.length - 1];
          if (top && top.ch === "<") { stack.pop(); diagPairs.set(top.offset, total + i); diagPairs.set(total + i, top.offset); }
        }
        else if (s[i] === ")" || s[i] === "]" || s[i] === "}") {
          const expected = { ")": "(", "]": "[", "}": "{" }[s[i]];
          const top = stack[stack.length - 1];
          if (top && top.ch === expected) {
            stack.pop();
            diagPairs.set(top.offset, total + i);
            diagPairs.set(total + i, top.offset);
          }
        }
      }
      total += s.length + 1;
    }
  }

  // Search helpers. These are kept inside the editor closure so rendering,
  // find/replace, and the highlighted search results share the same match list.
  function isDeadOffset(offset) {
    let lo = 0, hi = diagDead.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (diagDead[mid].e <= offset) lo = mid + 1;
      else hi = mid;
    }
    const range = diagDead[lo];
    return !!range && offset >= range.s && offset < range.e;
  }
  function lineIsDead(lineStart, lineEnd) {
    let lo = 0, hi = diagDead.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (diagDead[mid].e <= lineStart) lo = mid + 1;
      else hi = mid;
    }
    const range = diagDead[lo];
    return !!range && range.s < lineEnd && range.e > lineStart;
  }

  function lowerFindIndex(offset) {
    let lo = 0, hi = findMatches.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (findMatches[mid].end <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function makeSearchRegex(globalMatch = true) {
    const query = findInput.value;
    // In regex mode, ^ and $ are useful for matching individual source lines.
    // The search field accepts the pattern only (no /.../ delimiters); g is
    // supplied for collecting every result and m makes anchors line-aware.
    const flags = (findCase.checked ? "" : "i") + (globalMatch ? "g" : "") + (findRegex.checked ? "m" : "");
    if (findRegex.checked) return new RegExp(query, flags);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, flags);
  }

  function rebuildFindMatches(updateStatus = false) {
    findMatches = [];
    findInput.classList.remove("invalid");
    findStatus.classList.remove("error");

    const query = findInput.value;
    if (!query) {
      activeFindIndex = -1;
      if (updateStatus) findStatus.textContent = "Enter text to find";
      return;
    }

    const text = source();
    if (!findRegex.checked) {
      // Literal search uses indexOf rather than constructing a RegExp. This
      // means characters such as (, [, *, and ? are always ordinary text when
      // the Regex checkbox is off.
      const haystack = findCase.checked ? text : text.toLocaleLowerCase();
      const needle = findCase.checked ? query : query.toLocaleLowerCase();
      let from = 0, index;
      while ((index = haystack.indexOf(needle, from)) !== -1) {
        findMatches.push({ start: index, end: index + query.length });
        from = index + Math.max(1, needle.length);
      }
    } else {
      let regex;
      try {
        regex = makeSearchRegex(true);
      } catch (error) {
        activeFindIndex = -1;
        findInput.classList.add("invalid");
        findStatus.classList.add("error");
        findStatus.textContent = "Invalid regex: " + (error && error.message ? error.message : String(error));
        return;
      }
      try {
        for (const match of text.matchAll(regex)) {
          const start = match.index;
          findMatches.push({ start, end: start + match[0].length });
        }
      } catch (error) {
        activeFindIndex = -1;
        findInput.classList.add("invalid");
        findStatus.classList.add("error");
        findStatus.textContent = "Search failed: " + (error && error.message ? error.message : String(error));
        return;
      }
    }

    if (activeFindIndex >= findMatches.length) activeFindIndex = -1;
    if (updateStatus) {
      findStatus.textContent = findMatches.length
        ? findMatches.length + " match" + (findMatches.length === 1 ? "" : "es")
        : "No matches";
    }
  }

  function currentSearchKey() {
    return [findInput.value, findRegex.checked ? "1" : "0", findCase.checked ? "1" : "0", sourceVersion].join("\u001f");
  }
  function finishPendingSearch() {
    if (pendingFindSelection) {
      const pending = pendingFindSelection;
      if (pending.key !== searchReadyKey) return;
      pendingFindSelection = null;
      const index = findMatches.findIndex(match => match.start === pending.range[0] && match.end === pending.range[1]);
      if (index >= 0) {
        activeFindIndex = index;
        const text = source();
        setSel(pointAt(findMatches[index].start, text), pointAt(findMatches[index].end, text));
        renderWindow(true);
        overlays();
      }
    }
    if (pendingFindNavigation) {
      const pending = pendingFindNavigation;
      if (pending.key !== searchReadyKey) return;
      pendingFindNavigation = null;
      performFindMatch(pending.back, pending.returnToEditor);
    }
  }

  function createSearchWorker() {
    if (searchWorker) return searchWorker;
    if (!window.Worker || !window.Blob || !URL.createObjectURL) return null;
    const workerCode = `
      self.onmessage = function (event) {
        const data = event.data || {};
        const id = data.id;
        try {
          const query = String(data.query || "");
          const source = String(data.text || "");
          const matches = [];
          let truncated = false;
          if (!data.regex) {
            const haystack = data.caseSensitive ? source : source.toLocaleLowerCase();
            const needle = data.caseSensitive ? query : query.toLocaleLowerCase();
            let from = 0, index;
            while ((index = haystack.indexOf(needle, from)) !== -1) {
              matches.push({ start: index, end: index + query.length });
              if (matches.length >= 50000) { truncated = index + query.length < source.length; break; }
              from = index + Math.max(1, needle.length);
            }
          } else {
            const flags = (data.caseSensitive ? "" : "i") + "gm";
            const regex = new RegExp(query, flags);
            let match;
            while ((match = regex.exec(source)) !== null) {
              matches.push({ start: match.index, end: match.index + match[0].length });
              if (matches.length >= 50000) { truncated = regex.lastIndex < source.length; break; }
              if (match[0].length === 0) {
                if (regex.lastIndex >= source.length) break;
                regex.lastIndex++;
              }
            }
          }
          self.postMessage({ id, matches, truncated });        } catch (error) {
          self.postMessage({ id, error: error && error.message ? error.message : String(error) });
        }
      };
    `;
    try {
      searchWorkerUrl = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
      searchWorker = new Worker(searchWorkerUrl);
      searchWorker.onmessage = event => {
        const result = event.data || {};
        if (result.id !== searchRequest) return;
        clearTimeout(searchTimer);
        if (result.error) {
          findMatches = [];
          findInput.classList.add("invalid");
          findStatus.classList.add("error");
          findStatus.textContent = "Invalid regex: " + result.error;
        } else {
          findMatches = result.matches || [];
          findInput.classList.remove("invalid");
          findStatus.classList.remove("error");
          if (!findInput.value) findStatus.textContent = "Enter text to find";
          else if (!findMatches.length) findStatus.textContent = "No matches";
          else findStatus.textContent = findMatches.length + (result.truncated ? "+" : "") +
            " match" + (findMatches.length === 1 && !result.truncated ? "" : "es");
        }
        searchReadyKey = currentSearchKey();
        renderWindow(true);
        overlays();
        finishPendingSearch();
      };
      searchWorker.onerror = () => {
        try { searchWorker.terminate(); } catch (_) {}
        searchWorker = null;
        if (searchWorkerUrl) URL.revokeObjectURL(searchWorkerUrl);
        searchWorkerUrl = null;
        rebuildFindMatches(true);
        searchReadyKey = currentSearchKey();
        renderWindow(true);
        overlays();
        finishPendingSearch();
      };
      return searchWorker;
    } catch (_) {
      if (searchWorkerUrl) URL.revokeObjectURL(searchWorkerUrl);
      searchWorkerUrl = null;
      searchWorker = null;
      return null;
    }
  }
  function queueSearchRefresh() {
    activeFindIndex = -1;
    const request = ++searchRequest;
    const key = currentSearchKey();
    searchReadyKey = "";
    clearTimeout(searchTimer);
    findInput.classList.remove("invalid");
    findStatus.classList.remove("error");
    if (!findInput.value) {
      findMatches = [];
      pendingFindNavigation = null;
      pendingFindSelection = null;
      findStatus.textContent = "Enter text to find";
      renderWindow(true);
      overlays();
      return;
    }
    findMatches = [];
    findStatus.textContent = "Searching…";
    searchTimer = setTimeout(() => {
      if (request !== searchRequest) return;
      const worker = createSearchWorker();
      if (worker) {
        try {
          worker.postMessage({
            id: request,
            text: source(),
            query: findInput.value,
            regex: findRegex.checked,
            caseSensitive: findCase.checked
          });
        } catch (_) {
          rebuildFindMatches(true);
          searchReadyKey = key;
          renderWindow(true);
          overlays();
          finishPendingSearch();
        }
      } else {
        rebuildFindMatches(true);
        searchReadyKey = key;
        renderWindow(true);
        overlays();
        finishPendingSearch();
      }
    }, 160);
  }

  function cancelQueuedSearch() {
    clearTimeout(searchTimer);
    searchRequest++;
  }

  function lineHtml(l) {
    ensureLineOffsetsThrough(l);
    const s = lines[l], start = diagStarts[l] || 0, ts = toks[l] || [];
    let html = "", lastClass = null, chunk = "", ti = 0;
    let fi = lowerFindIndex(start);
    const flush = () => {
      if (!chunk) return;
      const out = esc(chunk);
      html += lastClass ? '<span class="' + lastClass + '">' + out + '</span>' : out;
      chunk = "";
    };
    for (let i = 0; i < s.length; i++) {
      while (ti < ts.length && ts[ti].e <= i) ti++;
      const token = ts[ti], cls = [];
      if (token && i >= token.s && i < token.e) cls.push(token.k);
      const global = start + i;
      while (fi < findMatches.length && findMatches[fi].end <= global) fi++;
      if (fi < findMatches.length && global >= findMatches[fi].start && global < findMatches[fi].end) {
        cls.push(fi === activeFindIndex ? "search-current" : "search-hit");
      }
      if (diagUnused.has(global)) cls.push("unused");
      if (isDeadOffset(global)) cls.push("deadspan");
      const mate = diagPairs.get(global);
      const key = cls.join(" ");
      if (lastClass !== key) { flush(); lastClass = key; }
      chunk += s[i];
    }
    flush();
    return html || " ";
  }
  const inStrCom = (l, c) => (toks[l] || []).some(t => c >= t.s && c < t.e && (t.k === "str" || t.k === "com"));

  
  const CTL = new Set(W("if for while switch catch function return with"));
  function parseDefs() { return new Map(); }

  function callCtx() {
    
    const stack = []; let last = "";
    // Parameter hints only need a nearby open call. Bound the scan so moving
    // the caret near the end of a large file never walks the entire document.
    const firstLine = Math.max(0, cur.l - 300);
    for (let l = firstLine; l <= cur.l; l++) {
      const s = lines[l], end = l === cur.l ? cur.c : s.length, t = toks[l] || []; let ti = 0;
      for (let i = 0; i < end; i++) {
        while (ti < t.length && t[ti].e <= i) ti++;
        const k = ti < t.length && i >= t[ti].s ? t[ti] : null;
        if (k && (k.k === "str" || k.k === "com")) {
          if (k.k === "com") { if (l === cur.l && end <= k.e) return null; }   
          else last = "s";
          i = k.e - 1; continue;
        }
        const c = s[i];
        if (/\s/.test(c)) continue;
        if (c === "(" || c === "[") stack.push({ ch: c, l, c: i, n: 0, blk: false, areaCount: false });
        else if (c === "{") {
          const areaCount = last === "<";
          stack.push({ ch: c, l, c: i, n: 0, blk: !areaCount, areaCount });
        }
        else if (c === ")" || c === "]" || c === "}") stack.pop();
        else if (c === "," && stack.length && (stack[stack.length - 1].ch === "(" || stack[stack.length - 1].areaCount)) stack[stack.length - 1].n++;
        last = c;
      }
    }
    for (let j = stack.length - 1; j >= 0; j--) {
      const e = stack[j];
      if (e.areaCount) return { obj: "", name: "areaCount", l: e.l, nc: e.c, n: e.n };
      if (e.ch === "{" && e.blk) return null;
      if (e.ch !== "(") continue;
      const pre = lines[e.l].slice(0, e.c);
      if (/\bfunction\s*\*?\s*[\w$]*\s*$/.test(pre)) return null;   
      const m = /(?:([\w$]+)\s*\??\.\s*)?([\w$]+)\s*$/.exec(pre);
      if (!m) return null;
      if (!m[1] && KW.has(m[2])) return null;               
      return { obj: m[1] || "", name: m[2], l: e.l, nc: m.index, n: e.n };
    }
    return null;
  }
  function splitTop(p) {
    const out = []; let d = 0, q = "", acc = "";
    for (const ch of p) {
      if (q) { acc += ch; if (ch === q) q = ""; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { q = ch; acc += ch; }
      else if ("([{".includes(ch)) { d++; acc += ch; }
      else if (")]}".includes(ch)) { d--; acc += ch; }
      else if (ch === "," && d === 0) { out.push(acc.trim()); acc = ""; }
      else acc += ch;
    }
    if (acc.trim()) out.push(acc.trim());
    return out;
  }
  function sigFor(ctx) {
    const { obj, name } = ctx;
    if (obj) return SIG[obj + "." + name] ?? defs.get(name) ?? SIG["." + name];
    return defs.has(name) ? defs.get(name) : SIG[name];
  }
  function updateSig() {
    sigEl.style.display = "none";
    if (sigHide || dirty || hasSel()) return;
    const ctx = callCtx();
    if (!ctx) return;
    const p = sigFor(ctx);
    if (p === undefined) return;
    const ps = splitTop(p);
    const act = ctx.n < ps.length ? ctx.n : (ps.length && ps[ps.length - 1].startsWith("...") ? ps.length - 1 : -1);
    const signatureName = ctx.name === "areaCount" ? "area-count" : (ctx.obj ? ctx.obj + "." : "") + ctx.name;
    sigEl.innerHTML = '<span class="sn">' + esc(signatureName) + "</span>(" +
      ps.map((x, i) => '<span class="' + (i === act ? "sa" : "sp") + '">' + esc(x) + "</span>").join(", ") + ")" +
      (ps.length ? "" : ' <span class="sp">no parameters</span>');
    sigEl.style.display = "block";
    const w = sigEl.offsetWidth, h = sigEl.offsetHeight;
    const point = caretPosition(ctx.l, ctx.nc);
    let top = point.y - h - 2;
    if (top < ed.scrollTop) {
      if (popOpen) { sigEl.style.display = "none"; return; }
      top = point.y + LH + 2;
    }
    let left = point.x;
    left = Math.min(left, ed.scrollLeft + ed.clientWidth - w - 6);
    left = Math.max(left, ed.scrollLeft + GW + 2);
    sigEl.style.left = left + "px"; sigEl.style.top = top + "px";
  }

  
  function measure() {
    if (measured) return true;
    if (!box.offsetParent) return false;
    const p = document.createElement("span");
    p.style.cssText = "position:absolute;visibility:hidden;white-space:pre"; p.textContent = "M".repeat(50);
    box.appendChild(p); const w = p.getBoundingClientRect().width / 50; box.removeChild(p);
    if (w) CW = w;
    measured = !!w;
    return measured;
  }
  function rowElement(l) { return renderedRows.get(l) || null; }
  function rowTop(l) {
    const row = rowElement(l), index = vmap[l] || 0;
    return row ? row.offsetTop : (rowOffsets[index] || 0);
  }
  function rowHeight(l) {
    const row = rowElement(l), index = vmap[l] || 0;
    return row ? Math.max(LH, row.offsetHeight) : Math.max(LH, (rowOffsets[index + 1] || 0) - (rowOffsets[index] || 0));
  }
  function textNodes(code) {
    const out = [], walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement && node.parentElement.closest(".bdg")) continue;
      out.push(node);
    }
    return out;
  }
  function domPointAt(code, characterOffset) {
    const nodes = textNodes(code);
    if (!nodes.length) return null;
    let remain = Math.max(0, characterOffset);
    for (const node of nodes) {
      if (remain <= node.nodeValue.length) return { node, offset: remain };
      remain -= node.nodeValue.length;
    }
    const last = nodes[nodes.length - 1];
    return { node: last, offset: last.nodeValue.length };
  }
  function sourceOffsetAtDomPoint(code, node, offset) {
    const nodes = textNodes(code);
    let total = 0;
    for (const textNode of nodes) {
      if (textNode === node) return total + Math.max(0, Math.min(offset, textNode.nodeValue.length));
      total += textNode.nodeValue.length;
    }
    if (node && node.nodeType === Node.ELEMENT_NODE && code.contains(node)) {
      try {
        const range = document.createRange();
        range.setStart(code, 0); range.setEnd(node, offset);
        return range.toString().length;
      } catch (_) {}
    }
    return total;
  }
  function caretPosition(l, c) {
    const row = rowElement(l), code = row && row.querySelector(".code");
    if (!wordWrap || !code) return { x: GW + PAD + c * CW, y: rowTop(l) };
    const boxRect = box.getBoundingClientRect();
    const point = domPointAt(code, c);
    if (!point) {
      const r = code.getBoundingClientRect();
      return { x: r.left - boxRect.left, y: r.top - boxRect.top };
    }
    const range = document.createRange();
    range.setStart(point.node, point.offset); range.collapse(true);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.height && !rect.width)) {
      const r = code.getBoundingClientRect();
      return { x: r.left - boxRect.left + Math.min(c, lines[l].length) * CW, y: r.top - boxRect.top };
    }
    return { x: rect.left - boxRect.left, y: rect.top - boxRect.top };
  }
  function lineSelectionRects(l, start, end) {
    const row = rowElement(l), code = row && row.querySelector(".code");
    if (!wordWrap || !code) return [{ x: GW + PAD + start * CW, y: rowTop(l), w: Math.max(0, end - start) * CW, h: rowHeight(l) }];
    const a = domPointAt(code, start), b = domPointAt(code, Math.min(end, lines[l].length));
    if (!a || !b) return [];
    const range = document.createRange();
    range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset);
    const boxRect = box.getBoundingClientRect();
    const rects = [...range.getClientRects()].map(r => ({
      x: r.left - boxRect.left, y: r.top - boxRect.top,
      w: Math.max(2, r.width), h: Math.max(LH, r.height)
    }));
    if (end > lines[l].length) {
      const caret = caretPosition(l, lines[l].length);
      rects.push({ x: caret.x, y: caret.y, w: CW, h: LH });
    }
    return rects;
  }
  function rowMarkup(l) {
    const mark = ranges.has(l) ? (folded.has(l) ? "▸" : "▾") : " ";
    const lineStart = diagStarts[l] || 0, lineEnd = lineStart + lines[l].length;
    const lineDead = lineIsDead(lineStart, lineEnd);
    const hasError = !!liveDiagnostic && liveDiagnostic.line === l;
    const rowClass = (lineDead ? " deadline" : "") + (hasError ? " errorline" : "");
    const errorMark = hasError
      ? '<button class="diag-dot" type="button" data-error-line="' + (l + 1) + '" title="Show error" aria-label="Show error on line ' + (l + 1) + '">●</button>'
      : '<span class="diag-space"></span>';
    return '<div class="ln' + rowClass + '" data-line="' + l + '"><span class="gut">' +
      '<span class="gut-num">' + String(l + 1).padStart(digits) + '</span>' + errorMark + ' ' + mark + ' </span><span class="code">' +
      lineHtml(l) + (folded.has(l) ? '<span class="bdg">⋯</span>' : "") + "</span></div>";
  }
  function indexAtY(y) {
    if (!vis.length) return 0;
    let lo = 0, hi = vis.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowOffsets[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(vis.length - 1, lo);
  }
  function renderWindow(force = false) {
    if (!vis.length) {
      renderedRows = new Map();
      rowsEl.replaceChildren();
      virtualStart = virtualEnd = 0;
      return true;
    }
    const viewTop = Math.max(0, ed.scrollTop - VIRTUAL_OVERSCAN * LH);
    const viewBottom = Math.max(viewTop + LH, ed.scrollTop + (ed.clientHeight || 500) + VIRTUAL_OVERSCAN * LH);
    const start = Math.max(0, indexAtY(viewTop));
    const end = Math.min(vis.length, indexAtY(viewBottom) + 1);
    if (!force && start === virtualStart && end === virtualEnd) return false;

    const fragment = document.createDocumentFragment();
    const topSpace = document.createElement("div");
    topSpace.className = "virtual-spacer";
    topSpace.style.height = (rowOffsets[start] || 0) + "px";
    topSpace.style.width = "1px";
    fragment.appendChild(topSpace);

    const nextRows = new Map();
    for (let i = start; i < end; i++) {
      const l = vis[i];
      const holder = document.createElement("div");
      holder.innerHTML = rowMarkup(l);
      const row = holder.firstElementChild;
      if (wordWrap) row.style.height = ((rowOffsets[i + 1] || 0) - (rowOffsets[i] || 0)) + "px";
      fragment.appendChild(row);
      nextRows.set(l, row);
    }

    const bottomSpace = document.createElement("div");
    bottomSpace.className = "virtual-spacer";
    bottomSpace.style.height = Math.max(0, (rowOffsets[vis.length] || 0) - (rowOffsets[end] || 0)) + "px";
    bottomSpace.style.width = "1px";
    fragment.appendChild(bottomSpace);
    rowsEl.replaceChildren(fragment);
    renderedRows = nextRows;
    virtualStart = start;
    virtualEnd = end;
    return true;
  }
  function render() {
    if (!measure()) return;
    box.classList.toggle("word-wrap", wordWrap);
    if (wordWrap) {
      box.style.width = Math.max(1, ed.clientWidth) + "px";
      box.style.minWidth = "100%";
    } else {
      box.style.minWidth = "100%";
    }
    for (const f of [...folded]) if (!ranges.has(f)) folded.delete(f);
    ed.classList.toggle("has-folds", folded.size > 0);
    vis = []; vmap = new Array(lines.length);
    for (let l = 0; l < lines.length;) {
      vis.push(l);
      const to = folded.has(l) ? ranges.get(l).to : l;
      for (let j = l; j <= to; j++) vmap[j] = vis.length - 1;
      l = to + 1;
    }
    digits = Math.max(2, String(lines.length).length); GW = (digits + 3) * CW;
    box.style.setProperty("--gw", GW + "px");

    // Only a small window of rows is kept in the DOM. The spacer rows preserve
    // the full document's scroll height without forcing the browser to lay out
    // thousands of syntax-highlighted elements on every keystroke.
    rowOffsets = new Array(vis.length + 1);
    rowOffsets[0] = 0;
    maxLineColumns = 0;
    const wrapWidth = Math.max(1, ed.clientWidth - GW - PAD - 6);
    const wrapColumns = Math.max(1, Math.floor(wrapWidth / CW));
    for (let i = 0; i < vis.length; i++) {
      const line = lines[vis[i]];
      maxLineColumns = Math.max(maxLineColumns, line.length);
      const rowHeightValue = wordWrap ? Math.max(1, Math.ceil(Math.max(1, line.length) / wrapColumns)) * LH : LH;
      rowOffsets[i + 1] = rowOffsets[i] + rowHeightValue;
    }
    editorContentWidth = wordWrap ? Math.max(1, ed.clientWidth) : Math.max(ed.clientWidth, GW + 6 + maxLineColumns * CW);
    editorContentHeight = Math.max(ed.clientHeight, (rowOffsets[vis.length] || 0) + 60);
    if (wordWrap) {
      box.style.width = Math.max(1, ed.clientWidth) + "px";
      rowsEl.style.width = "100%";
    } else {
      box.style.width = editorContentWidth + "px";
      rowsEl.style.width = editorContentWidth + "px";
    }
    virtualStart = virtualEnd = -1;
    renderWindow(true);
  }
  const visible = l => vis[vmap[l]] === l;
  function renderSelectionHighlight() {
    let h = "";
    if (hasSel()) {
      const [a, b] = order();
      for (const l of renderedRows.keys()) {
        if (l < a.l || l > b.l) continue;
        const start = l === a.l ? a.c : 0;
        const end = l === b.l ? b.c : lines[l].length + 1;
        if (end <= start && l === b.l) continue;
        for (const rect of lineSelectionRects(l, start, end)) {
          if (rect.w > 0) h += '<div style="left:' + rect.x + 'px;top:' + rect.y + 'px;width:' + rect.w + 'px;height:' + rect.h + 'px"></div>';
        }
      }
    }
    selBox.innerHTML = h;
  }

  function overlays(preserveViewport = false) {
    const caret = caretPosition(cur.l, cur.c), x = caret.x, y = caret.y;
    curEl.style.left = x + "px"; curEl.style.top = y + "px";
    clEl.style.top = rowTop(cur.l) + "px";
    clEl.style.height = rowHeight(cur.l) + "px";
    clEl.style.display = hasSel() ? "none" : "block";
    taEl.style.left = x + "px"; taEl.style.top = y + "px";
    renderSelectionHighlight();
    let multiHtml = "";
    for (const p of extra) {
      if (p.a && (p.a.l !== p.l || p.a.c !== p.c)) {
        const xPoint = { l: p.l, c: p.c }, [a, b] = before(p.a, xPoint) ? [p.a, xPoint] : [xPoint, p.a];
        for (const l of renderedRows.keys()) {
          if (l < a.l || l > b.l) continue;
          const from = l === a.l ? a.c : 0, to = l === b.l ? b.c : lines[l].length + 1;
          if (to > from) for (const rect of lineSelectionRects(l, from, to)) {
            if (rect.w > 0) multiHtml += '<div class="mcselection" style="left:' + rect.x + 'px;top:' + rect.y + 'px;width:' + rect.w + 'px;height:' + rect.h + 'px"></div>';
          }
        }
      }
      if (visible(p.l)) {
        const point = caretPosition(p.l, p.c);
        multiHtml += '<div class="mcursor" style="left:' + point.x + 'px;top:' + point.y + 'px"></div>';
      }
    }
    multiEl.innerHTML = multiHtml;
    const caretOffset = offsetAt(cur), candidates = [caretOffset, caretOffset - 1];
    const bracketAt = candidates.find(p => diagPairs.has(p));
    let pairHtml = "";
    if (bracketAt !== undefined) {
      const mate = diagPairs.get(bracketAt);
      for (const off of [bracketAt, mate]) {
        const p = pointForOffset(off);
        if (p.l >= 0 && p.l < vmap.length && visible(p.l)) {
          const point = caretPosition(p.l, p.c);
          pairHtml += '<div class="pairhighlight" style="left:' + point.x + 'px;top:' + point.y + 'px;width:' + CW + 'px"></div>';
        }
      }
    }
    pairEl.innerHTML = pairHtml;
    if (lastOn) lastOn.classList.remove("on");
    const r = rowElement(cur.l);
    if (r) { lastOn = r.firstChild; lastOn.classList.add("on"); }
    posEl.textContent = "Ln " + (cur.l + 1) + ", Col " + (cur.c + 1) + "  |  " + lines.length + " lines";

    if (!preserveViewport) {
      if (y < ed.scrollTop) ed.scrollTop = y;
      else if (y + LH > ed.scrollTop + ed.clientHeight) ed.scrollTop = y + LH - ed.clientHeight;
      if (x - ed.scrollLeft < GW + PAD) ed.scrollLeft = Math.max(0, x - GW - PAD - 20);
      else if (x - ed.scrollLeft + CW > ed.clientWidth) ed.scrollLeft = x + CW - ed.clientWidth + 20;
    }

    updateNativeTextarea(x, y);
    updateSig();
  }
  function closeDiagnostic() {
    if (diagnosticPopupEl) diagnosticPopupEl.hidden = true;
  }
  function showDiagnostic(line, anchor) {
    if (!liveDiagnostic || liveDiagnostic.line !== line || !diagnosticPopupEl) return;
    diagnosticMessageEl.textContent = `Compilation error at ${liveDiagnostic.line + 1}:${liveDiagnostic.col}: ${liveDiagnostic.message}`;
    diagnosticPopupEl.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = diagnosticPopupEl.offsetWidth || 290;
    const h = diagnosticPopupEl.offsetHeight || 70;
    const left = clamp(r.right + 8, 6, window.innerWidth - w - 6);
    const below = r.bottom + 5;
    const top = below + h <= window.innerHeight - 6 ? below : Math.max(6, r.top - h - 5);
    diagnosticPopupEl.style.left = left + "px";
    diagnosticPopupEl.style.top = top + "px";
  }
  function updateLiveDiagnostics() {
    diagnosticTimer = 0;
    if (!window.GridLanguage || typeof window.GridLanguage.compile !== "function") return;
    try {
      window.GridLanguage.compile(source());
      liveDiagnostic = null;
      closeDiagnostic();
    } catch (error) {
      const line = clamp((Number(error && error.line) || 1) - 1, 0, Math.max(0, lines.length - 1));
      liveDiagnostic = {
        line,
        col: Math.max(1, Number(error && error.col) || 1),
        message: String(error && error.message ? error.message : error)
      };
      if (!diagnosticPopupEl.hidden) closeDiagnostic();
    }
    renderWindow(true);
    overlays(true);
  }
  function scheduleLiveDiagnostics() {
    clearTimeout(diagnosticTimer);
    diagnosticTimer = setTimeout(updateLiveDiagnostics, 320);
  }

  function sync(full) {
    if (dirty) { tokenize(); dirty = false; full = true; }
    if (full) render();
    overlays();
  }

  
  function hiddenBy(l) {
    // Fold ranges can be nested. The outermost closed range determines the
    // visible row for any source line hidden inside it.
    let outer = -1;
    for (const f of folded) {
      const r = ranges.get(f);
      if (r && l >= r.from && l <= r.to && (outer < 0 || f < outer)) outer = f;
    }
    return outer;
  }
  function reveal(l) {
    let changed = false;
    // Open every folded ancestor containing this source line, not merely the
    // first range found. This also handles several nested folds at once.
    for (const f of [...folded]) {
      const r = ranges.get(f);
      if (r && l >= r.from && l <= r.to) {
        folded.delete(f);
        changed = true;
      }
    }
    return changed;
  }
  function revealSelection(a, b) {
    const first = Math.min(a.l, b.l), last = Math.max(a.l, b.l);
    let changed = false;
    for (const f of [...folded]) {
      const r = ranges.get(f);
      if (r && first <= r.to && last >= r.from) {
        folded.delete(f);
        changed = true;
      }
    }
    return changed;
  }
  function foldFix() {
    // Neither end of a selection may remain inside invisible source rows.
    // Move a hidden endpoint to the end of its outermost visible opening line.
    function visiblePoint(point) {
      let next = { ...point }, f, guard = 0;
      while ((f = hiddenBy(next.l)) >= 0 && guard++ <= folded.size) {
        next = { l: f, c: lines[f].length };
      }
      return next;
    }
    anc = visiblePoint(anc);
    cur = visiblePoint(cur);
  }
  function refocusAfterFold() {
    // Rebuilding the visible row window can make mobile WebViews drop focus
    // from the transparent source textarea. Restore it after layout settles,
    // but do not steal focus from Find/Replace, Go To, or toolbar controls.
    const restore = () => {
      if (document.hidden) return;
      const active = document.activeElement;
      if (active !== taEl && active !== document.body && active !== document.documentElement && !ed.contains(active)) return;
      try { taEl.focus({ preventScroll: true }); } catch (_) { taEl.focus(); }
      writeNativeSelection();
    };
    requestAnimationFrame(() => {
      restore();
      setTimeout(restore, 32);
    });
  }
  function toggleFold(l) {
    if (folded.has(l)) folded.delete(l); else if (ranges.has(l)) folded.add(l);
    foldFix(); sync(true); writeNativeSelection(); refocusAfterFold();
  }
  function foldCurrent(fold) {
    let best = -1;
    for (const [s, r] of ranges) if (s <= cur.l && cur.l <= r.to + 1 && s > best && (fold ? !folded.has(s) : folded.has(s) && s === cur.l)) best = s;
    if (best >= 0) { if (fold) folded.add(best); else folded.delete(best); foldFix(); sync(true); writeNativeSelection(); refocusAfterFold(); }
  }

  
  function setSel(a, b, preserveExtra = false) {
    anc = { ...a }; cur = { ...b }; if (!preserveExtra) extra = []; want = -1; sigHide = false; closePop();
    const opened = hasSel() ? revealSelection(anc, cur) : reveal(cur.l);
    sync(opened);
    writeNativeSelection();
  }
  function moveTo(l, c, ext, keepWant, preserveExtra = false) {
    l = clamp(l, 0, lines.length - 1); c = clamp(c, 0, lines[l].length);
    setSel(ext ? anc : { l, c }, { l, c }, preserveExtra);
    if (keepWant !== undefined) want = keepWant;
  }
  function wrappedVerticalPoint(point, rows) {
    const caret = caretPosition(point.l, point.c), boxRect = box.getBoundingClientRect();
    const target = {
      clientX: boxRect.left + caret.x,
      clientY: boxRect.top + caret.y + rows * LH + LH / 2
    };
    const mapped = hit(target);
    return { l: mapped.l, c: mapped.c };
  }
  function nextPoint(p, key, ctrl) {
    const l = p.l, c = p.c;
    if (key === "ArrowLeft") return ctrl ? wordLeft(l, c) : c > 0 ? { l, c: c - 1 } : l > 0 ? { l: l - 1, c: lines[l - 1].length } : { l, c };
    if (key === "ArrowRight") return ctrl ? wordRight(l, c) : c < lines[l].length ? { l, c: c + 1 } : l < lines.length - 1 ? { l: l + 1, c: 0 } : { l, c };
    if (key === "Home") return { l: ctrl ? 0 : l, c: ctrl ? 0 : (c !== /^ */.exec(lines[l])[0].length ? /^ */.exec(lines[l])[0].length : 0) };
    if (key === "End") return ctrl ? { l: lines.length - 1, c: lines[lines.length - 1].length } : { l, c: lines[l].length };
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(key)) {
      const amount = key.startsWith("Page") ? Math.max(1, Math.floor(ed.clientHeight / LH) - 1) : 1;
      if (wordWrap && !ctrl) return wrappedVerticalPoint(p, key.endsWith("Up") ? -amount : amount);
      const idx = (vmap[l] || 0) + (key.endsWith("Up") ? -amount : amount);
      if (idx < 0) return { l: vis[0], c: Math.min(c, lines[vis[0]].length) };
      if (idx >= vis.length) { const last = vis[vis.length - 1]; return { l: last, c: Math.min(c, lines[last].length) }; }
      const targetL = vis[idx]; return { l: targetL, c: Math.min(c, lines[targetL].length) };
    }
    return { l, c };
  }
  function moveExtraCursors(key, ctrl, shift) {
    for (const p of extra) {
      const old = { l: p.l, c: p.c };
      if (shift && !p.a) p.a = { ...old };
      if (!shift) p.a = null;
      const n = nextPoint(old, key, ctrl);
      p.l = n.l; p.c = n.c;
    }
  }
  function wordLeft(l, c) {
    const s = lines[l];
    if (c === 0) return l > 0 ? { l: l - 1, c: lines[l - 1].length } : { l, c };
    while (c > 0 && s[c - 1] === " ") c--;
    if (c > 0) { const w = isW(s[c - 1]); while (c > 0 && s[c - 1] !== " " && isW(s[c - 1]) === w) c--; }
    return { l, c };
  }
  function wordRight(l, c) {
    const s = lines[l];
    if (c >= s.length) return l < lines.length - 1 ? { l: l + 1, c: 0 } : { l, c };
    while (c < s.length && s[c] === " ") c++;
    if (c < s.length) { const w = isW(s[c]); while (c < s.length && s[c] !== " " && isW(s[c]) === w) c++; }
    return { l, c };
  }

  
  const snapshot = () => ({ lines: lines.slice(), cur: { ...cur }, anc: { ...anc }, extra: extra.map(p => ({ ...p, a: p.a ? { ...p.a } : null })), folded: new Set(folded) });
  function snap(kind) {
    const now = Date.now();
    if (kind === "type" && lastKind === "type" && now - lastT < 800) { lastT = now; return; }
    undoS.push(snapshot()); if (undoS.length > 300) undoS.shift();
    redoS = []; lastKind = kind; lastT = now;
  }
  function restore(s) {
    lines = s.lines.slice(); invalidateSource(); cur = { ...s.cur }; anc = { ...s.anc }; extra = (s.extra || []).map(p => ({ ...p, a: p.a ? { ...p.a } : null })); folded = new Set(s.folded);
    dirty = true; lastKind = ""; want = -1; closePop(); sync(true); writeNativeSelection(); scheduleLiveDiagnostics(); onChange();
  }
  const undo = () => { if (!readOnly && undoS.length) { redoS.push(snapshot()); restore(undoS.pop()); } };
  const redo = () => { if (!readOnly && redoS.length) { undoS.push(snapshot()); restore(redoS.pop()); } };

  function replaceRange(sl, sc, el, ec, text, nativeAlreadyApplied = false) {
    const startOffset = lineOffsetsValid ? offsetAt({ l: sl, c: sc }) : NaN;
    const endOffset = lineOffsetsValid ? offsetAt({ l: el, c: ec }) : NaN;
    const oldLineCount = lines.length;
    const oldLine = sl === el ? lines[sl] : null;
    sourceVersion++;
    const pre = lines[sl].slice(0, sc), post = lines[el].slice(ec), parts = text.split("\n");
    const nl = parts.length === 1 ? [pre + parts[0] + post]
      : [pre + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + post];
    if (pendingSimpleMutation) pendingSimpleMutation = { multiple: true };
    else if (sl === el && parts.length === 1 && Number.isFinite(startOffset) && Number.isFinite(endOffset)) {
      pendingSimpleMutation = { sl, el, oldLine, oldLineCount, startOffset, endOffset, text, nativeAlreadyApplied };
    } else pendingSimpleMutation = { multiple: true };

    lines.splice(sl, el - sl + 1, ...nl);
    const delta = parts.length - 1 - (el - sl);
    if (delta !== 0 || el !== sl) {
      const nf = new Set();
      for (const f of folded) { if (f <= sl) nf.add(f); else if (f > el) nf.add(f + delta); }
      folded = nf;
    }
    cur = { l: sl + parts.length - 1, c: (parts.length === 1 ? sc : 0) + parts[parts.length - 1].length };
    anc = { ...cur };
  }
  // Replace the current editor selection (or insert at the caret when there
  // is no selection). Keep all editor mutations routed through replaceRange so
  // line offsets, folding state, the native textarea, and undo history stay in
  // sync. Normalize pasted/programmatic text to the editor's LF + spaces format.
  function replaceSelectionText(text) {
    const [a, b] = order();
    replaceRange(a.l, a.c, b.l, b.c, norm(String(text)));
  }

  function refreshLine(l) {
    const row = rowElement(l);
    if (!row) return;
    const lineStart = diagStarts[l] || 0;
    row.classList.toggle("deadline", lineIsDead(lineStart, lineStart + lines[l].length));
    const code = row.querySelector(".code");
    if (code) code.innerHTML = lineHtml(l);
  }
  function restoreTypingFocus(wasFocused) {
    if (!wasFocused) return;
    requestAnimationFrame(() => {
      // Don't steal focus from a Find/Replace/Go To field or toolbar control.
      if (document.activeElement === document.body || document.activeElement === document.documentElement) {
        try { taEl.focus({ preventScroll: true }); } catch (_) { taEl.focus(); }
      }
    });
  }

  function commitSimpleMutation(mutation, pushNativeSelection) {
    if (!mutation || mutation.multiple || mutation.sl !== mutation.el || mutation.oldLineCount !== lines.length || !lineOffsetsValid) return false;
    const l = mutation.sl;
    const oldTrimmed = mutation.oldLine.trim();
    if (/^#<([^\/>\r\n][^>\r\n]*)>#$/.test(oldTrimmed) || /^#<\/([^>\r\n]+)>#$/.test(oldTrimmed)) return false;
    // Bracket folds can open or close on this line and affect other lines.
    // Force a full token/fold pass whenever either the old or new line has
    // square brackets instead of taking the fast single-line update path.
    if (/[\[\]]/.test(mutation.oldLine) || /[\[\]]/.test(lines[l])) return false;
    const state = tokenizeSingleLine(l);
    if (state.marker || state.inComment !== commentStateAfterLine[l] || state.commentStartLine !== commentStartAfterLine[l]) return false;

    const oldRows = wordWrap ? Math.max(1, Math.ceil(Math.max(1, mutation.oldLine.length) /
      Math.max(1, Math.floor(Math.max(1, ed.clientWidth - GW - PAD - 6) / CW)))) : 1;
    const newRows = wordWrap ? Math.max(1, Math.ceil(Math.max(1, lines[l].length) /
      Math.max(1, Math.floor(Math.max(1, ed.clientWidth - GW - PAD - 6) / CW)))) : 1;

    toks[l] = state.tokens;
    commentStateAfterLine[l] = state.inComment;
    commentStartAfterLine[l] = state.commentStartLine;
    if (lines[l].length !== mutation.oldLine.length) {
      lineOffsetsDirtyFrom = Math.min(lineOffsetsDirtyFrom, l + 1);
    }

    if (!mutation.nativeAlreadyApplied) {
      try { taEl.setRangeText(mutation.text, mutation.startOffset, mutation.endOffset, "end"); }
      catch (_) { return false; }
    }
    sourceCache = taEl.value;
    textareaMatchesSource = true;
    dirty = false;
    want = -1;
    sigHide = false;
    closePop();

    if (wordWrap && oldRows !== newRows) {
      render();
    } else {
      if (!wordWrap && lines[l].length > maxLineColumns) {
        maxLineColumns = lines[l].length;
        editorContentWidth = Math.max(ed.clientWidth, GW + 6 + maxLineColumns * CW);
        box.style.width = editorContentWidth + "px";
        rowsEl.style.width = editorContentWidth + "px";
      }
      if (wordWrap) {
        const row = rowElement(l);
        if (row) row.style.height = (newRows * LH) + "px";
      }
      refreshLine(l);
    }

    sync(false);
    if (pushNativeSelection) writeNativeSelection();
    scheduleLiveDiagnostics();
    onChange();
    if (!searchBar.hidden && findInput.value) queueSearchRefresh();
    return true;
  }
  function commit(pushNativeSelection = true) {
    const hadEditorFocus = document.activeElement === taEl;
    const mutation = pendingSimpleMutation;
    pendingSimpleMutation = null;
    if (commitSimpleMutation(mutation, pushNativeSelection)) {
      restoreTypingFocus(hadEditorFocus);
      return;
    }
    invalidateSource();
    want = -1; sigHide = false; dirty = true;
    if (hasSel()) revealSelection(anc, cur); else reveal(cur.l);
    sync(true);
    if (pushNativeSelection) writeNativeSelection();
    scheduleLiveDiagnostics();
    onChange();
    if (!searchBar.hidden && findInput.value) queueSearchRefresh();
    restoreTypingFocus(hadEditorFocus);
  }

  const OPEN = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
  const CLOSE = new Set([")", "]", "}", '"', "'", "`"]);

  function typeChar(ch) {
    const s = lines[cur.l], nx = s[cur.c] || "", pv = s[cur.c - 1] || "";
    if (hasSel() && OPEN[ch]) {
      snap("wrap"); const t = selText(), [a] = order();
      replaceSelectionText(ch + t + OPEN[ch]);
      anc = { l: a.l, c: a.c + 1 }; cur = { l: cur.l, c: cur.c - 1 };
      commit(); closePop(); return;
    }
    if (!hasSel() && CLOSE.has(ch) && nx === ch) { cur.c++; anc = { ...cur }; sync(); closePop(); return; }
    snap("type");
    if (OPEN[ch] && !hasSel()) {
      const q = ch === OPEN[ch];
      const ok = q ? !isW(pv) && !isW(nx) && nx !== ch && pv !== "\\" : (nx === "" || /[\s)\]};,]/.test(nx));
      if (ok) { replaceSelectionText(ch + OPEN[ch]); cur.c--; anc = { ...cur }; commit(); closePop(); return; }
    }
    if ((ch === "}" || ch === ")" || ch === "]") && !hasSel() && cur.c >= 2 && /^ +$/.test(s.slice(0, cur.c))) {
      replaceRange(cur.l, cur.c - 2, cur.l, cur.c, ch); commit(); closePop(); return;
    }
    replaceSelectionText(ch); commit();
    if (isW(ch) || ch === ".") suggest(); else closePop();
  }
  function enter() {
    if (extra.length) return applyMulti("\n");
    snap("enter");
    if (hasSel()) replaceSelectionText("");
    const s = lines[cur.l], pre = s.slice(0, cur.c), post = s.slice(cur.c);
    const ind = /^ */.exec(pre)[0], open = /[{\[(]$/.test(pre.trimEnd());
    if (open && /^\s*[}\])]/.test(post)) {
      replaceRange(cur.l, cur.c, cur.l, cur.c, "\n" + ind + "  \n" + ind);
      cur = { l: cur.l - 1, c: ind.length + 2 }; anc = { ...cur };
    } else replaceRange(cur.l, cur.c, cur.l, cur.c, "\n" + ind + (open ? "  " : ""));
    commit(); closePop();
  }
  function backspace(word) {
    if (extra.length) return applyMulti("", -1, word);
    if (hasSel()) { snap("del"); replaceSelectionText(""); commit(); return; }
    const { l, c } = cur, s = lines[l];
    if (c === 0) { if (l === 0) return; snap("del"); replaceRange(l - 1, lines[l - 1].length, l, 0, ""); }
    else if (word) { const p = wordLeft(l, c); snap("del"); replaceRange(p.l, p.c, l, c, ""); }
    else {
      snap("type");
      if (OPEN[s[c - 1]] && OPEN[s[c - 1]] === s[c]) replaceRange(l, c - 1, l, c + 1, "");
      else if (c >= 2 && /^ +$/.test(s.slice(0, c))) replaceRange(l, c - (c % 2 || 2), l, c, "");
      else replaceRange(l, c - 1, l, c, "");
    }
    commit(); if (popOpen) suggest();
  }
  function del(word) {
    if (extra.length) return applyMulti("", 1, word);
    if (hasSel()) { snap("del"); replaceSelectionText(""); commit(); return; }
    const { l, c } = cur;
    if (c < lines[l].length) { const p = word ? wordRight(l, c) : { l, c: c + 1 }; snap("del"); replaceRange(l, c, p.l, p.c, ""); }
    else if (l < lines.length - 1) { snap("del"); replaceRange(l, c, l + 1, 0, ""); }
    else return;
    commit(); closePop();
  }
  function lineRange() { const [a, b] = order(); let e = b.l; if (hasSel() && b.c === 0 && b.l > a.l) e--; return [a.l, e]; }
  const adj = (l, d) => { for (const p of [cur, anc]) if (p.l === l) p.c = Math.max(0, p.c + d); };
  function indent(dir) {
    snap("indent"); const [s, e] = lineRange();
    for (let l = s; l <= e; l++) {
      if (dir > 0) { if (lines[l].length || s === e) { lines[l] = "  " + lines[l]; adj(l, 2); } }
      else { const m = /^ {1,2}/.exec(lines[l]); if (m) { lines[l] = lines[l].slice(m[0].length); adj(l, -m[0].length); } }
    }
    commit(); closePop();
  }
  function toggleComment() {
    const [s, e] = lineRange();
    const ls = [];
    for (let l = s; l <= e; l++) if (lines[l].trim()) ls.push(l);
    if (!ls.length) return;
    snap("comment");
    for (const l of ls) {
      const text = lines[l];
      const indent = /^\s*/.exec(text)[0].length;
      const lastHash = text.lastIndexOf("#");
      if (text[indent] === "#" && lastHash > indent && !text.slice(lastHash + 1).trim()) {
        const left = indent + 1 + (text[indent + 1] === " " ? 1 : 0);
        const right = lastHash > left && text[lastHash - 1] === " " ? 2 : 1;
        lines[l] = text.slice(0, indent) + text.slice(left, lastHash - (right - 1));
        adj(l, -(left - indent + right));
      } else {
        lines[l] = text.slice(0, indent) + "# " + text.slice(indent) + " #";
        adj(l, 4);
      }
    }
    commit(); closePop();
  }
  function applyMulti(insert, delDir = 0, word = false) {
    if (readOnly) return;
    const text = source();
    const points = [{ p: { ...cur }, a: hasSel() ? { ...anc } : null, primary: true },
      ...extra.map(p => ({ p: { l: p.l, c: p.c }, a: p.a ? { ...p.a } : null, primary: false }))];
    const seen = new Set(), ops = [];
    for (const item of points) {
      const at = offsetAt(item.p), anchorAt = item.a ? offsetAt(item.a) : at;
      const key = Math.min(at, anchorAt) + ":" + Math.max(at, anchorAt);
      if (seen.has(key)) continue; seen.add(key);
      let a = Math.min(at, anchorAt), b = Math.max(at, anchorAt), rep = insert;
      if (a === b && delDir < 0) { a = word ? offsetAt(wordLeft(item.p.l, item.p.c)) : Math.max(0, at - 1); b = at; rep = ""; }
      else if (a === b && delDir > 0) { b = word ? offsetAt(wordRight(item.p.l, item.p.c)) : Math.min(text.length, at + 1); a = at; rep = ""; }
      ops.push({ a, b, rep, primary: item.primary, at });
    }
    if (!ops.length) return;
    
    const ordered = ops.slice().sort((a, b) => a.a - b.a || a.b - b.b);
    const valid = [];
    for (const op of ordered) {
      const prev = valid[valid.length - 1];
      if (prev && (op.a < prev.b || (op.a === prev.a && op.b === prev.b))) {
        if (op.primary) { valid[valid.length - 1] = op; }
        continue;
      }
      valid.push(op);
    }
    if (!valid.length) return;
    snap("multi");
    let result = text;
    for (const op of [...valid].sort((a, b) => b.a - a.a || b.b - a.b)) result = result.slice(0, op.a) + op.rep + result.slice(op.b);
    const finalPoint = op => {
      const shift = valid.reduce((n, x) => n + (x.a < op.a ? x.rep.length - (x.b - x.a) : 0), 0);
      return pointAt(Math.max(0, Math.min(result.length, op.a + shift + op.rep.length)), result);
    };
    const primary = valid.find(o => o.primary) || valid[0];
    const p = finalPoint(primary);
    lines = result.split("\n"); cur = p; anc = { ...p };
    extra = valid.filter(o => !o.primary).map(o => finalPoint(o));
    folded.clear(); commit(); closePop();
  }
  function relativeIndentPaste(rawText) {
    const text = norm(String(rawText));
    if (!text.includes("\n")) return text;
    const [start] = order();
    const baseIndent = (/^ */.exec(lines[start.l] || "") || [""])[0];
    const parts = text.split("\n");
    const nonemptyIndents = parts.filter(line => line.trim()).map(line => (/^ */.exec(line) || [""])[0].length);
    const commonIndent = nonemptyIndents.length ? Math.min(...nonemptyIndents) : 0;
    return parts.map((line, index) => {
      const relative = line.slice(Math.min(commonIndent, (/^ */.exec(line) || [""])[0].length));
      if (index === 0) return relative;
      return relative.trim() ? baseIndent + relative : "";
    }).join("\n");
  }
  function insertPastedText(rawText) {
    if (readOnly) return;
    const text = relativeIndentPaste(rawText);
    if (extra.length) { applyMulti(text); closeContextMenu(); return; }
    snap("paste");
    replaceSelectionText(text);
    commit();
    closePop();
    closeContextMenu();
  }
  function closeContextMenu() {
    if (contextMenuEl) contextMenuEl.hidden = true;
  }
  function selectionContextBounds() {
    const [a, b] = order();
    const first = caretPosition(a.l, a.c), last = caretPosition(b.l, b.c);
    const r = box.getBoundingClientRect();
    return {
      left: r.left + Math.min(first.x, last.x),
      top: r.top + Math.min(first.y, last.y),
      bottom: r.top + Math.max(first.y, last.y) + LH
    };
  }
  function showContextMenu(clientX, clientY, preferSelection = hasSel()) {
    if (!contextMenuEl) return;
    contextNoticeEl.textContent = "";
    const selected = hasSel();
    const cut = contextMenuEl.querySelector('[data-context="cut"]');
    const copy = contextMenuEl.querySelector('[data-context="copy"]');
    const paste = contextMenuEl.querySelector('[data-context="paste"]');
    if (cut) cut.disabled = readOnly || !selected;
    if (copy) copy.disabled = !selected;
    if (paste) paste.disabled = readOnly;
    contextMenuEl.hidden = false;
    const w = contextMenuEl.offsetWidth || 190;
    const h = contextMenuEl.offsetHeight || 250;
    let x = clientX, top = clientY + 4;
    if (selected && preferSelection) {
      const bounds = selectionContextBounds();
      x = bounds.left;
      const below = bounds.bottom + 6;
      top = below + h <= window.innerHeight - 6 ? below : bounds.top - h - 6;
    } else if (top + h > window.innerHeight - 6) {
      top = clientY - h - 6;
    }
    contextMenuEl.style.left = clamp(x, 6, Math.max(6, window.innerWidth - w - 6)) + "px";
    contextMenuEl.style.top = clamp(top, 6, Math.max(6, window.innerHeight - h - 6)) + "px";
  }
  async function copySelectionToClipboard(cutAfter = false) {
    if (!hasSel()) { contextNoticeEl.textContent = "Select code first."; return; }
    const text = selText();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const temp = document.createElement("textarea");
        temp.value = text;
        temp.setAttribute("readonly", "");
        temp.style.position = "fixed";
        temp.style.opacity = "0";
        temp.style.left = "-9999px";
        document.body.appendChild(temp);
        temp.select();
        const copied = document.execCommand && document.execCommand("copy");
        temp.remove();
        if (!copied) throw new Error("Copy command was blocked.");
      }
      if (cutAfter && !readOnly) {
        snap("cut");
        replaceSelectionText("");
        commit();
      }
      closeContextMenu();
      taEl.focus({ preventScroll: true });
    } catch (error) {
      contextNoticeEl.textContent = "Clipboard access was blocked. Use your device's copy/cut controls.";
    }
  }
  async function pasteFromClipboard() {
    if (readOnly) return;
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error("Clipboard read is unavailable.");
      const text = await navigator.clipboard.readText();
      if (text) insertPastedText(text);
      else closeContextMenu();
      taEl.focus({ preventScroll: true });
    } catch (error) {
      contextNoticeEl.textContent = "Clipboard read was blocked. Use your device's Paste command or Ctrl+V.";
    }
  }
  function typeText(v) {
    if (readOnly) return;
    v = norm(v);
    if (extra.length) return applyMulti(v);
    if (v === "\n") return enter();
    if (v.length === 1) return typeChar(v);
    snap("paste"); replaceSelectionText(v); commit(); closePop();
  }


  
  function performFindMatch(back = false, returnToEditor = true) {
    if (findInput.classList.contains("invalid")) return;
    if (!findInput.value) { findStatus.textContent = "Enter text to find"; return; }
    if (!findMatches.length) { findStatus.textContent = "No matches"; renderWindow(true); overlays(); return; }
    const text = source();
    const pos = back ? offsetAt(order()[0]) : (hasSel() ? offsetAt(order()[1]) : offsetAt(cur));
    let idx = -1;
    if (back) {
      for (let i = findMatches.length - 1; i >= 0; i--) if (findMatches[i].start < pos) { idx = i; break; }
      if (idx < 0) idx = findMatches.length - 1;
    } else {
      const active = activeFindIndex >= 0 ? findMatches[activeFindIndex] : null;
      const activeZeroAtCaret = active && active.start === active.end && active.start === pos && !hasSel();
      if (activeZeroAtCaret) idx = (activeFindIndex + 1) % findMatches.length;
      else idx = findMatches.findIndex(m => m.start >= pos);
      if (idx < 0) idx = 0;
    }
    activeFindIndex = idx;
    const match = findMatches[idx];
    const a = pointAt(match.start, text), b = pointAt(match.end, text);
    setSel(a, b);
    findStatus.classList.remove("error");
    findStatus.textContent = "Match " + (idx + 1) + " of " + findMatches.length + " · line " + (a.l + 1);
    renderWindow(true);
    overlays();
    if (returnToEditor) focusEditor();
  }
  function findMatch(back = false, returnToEditor = true) {
    const key = currentSearchKey();
    if (searchReadyKey !== key) {
      pendingFindNavigation = { back, returnToEditor, key };
      if (findInput.value && findStatus.textContent !== "Searching…") queueSearchRefresh();
      else if (!findInput.value) findStatus.textContent = "Enter text to find";
      return;
    }
    pendingFindNavigation = null;
    performFindMatch(back, returnToEditor);
  }

  function focusEditor() { try { taEl.focus({ preventScroll: true }); } catch (_) { taEl.focus(); } overlays(); }
  function showGoToLine() {
    gotoBar.hidden = false;
    gotoInput.value = String(cur.l + 1);
    gotoStatus.textContent = lines.length + " lines";
    gotoInput.focus();
    gotoInput.select();
  }
  function hideGoToLine(returnToEditor = true) {
    gotoBar.hidden = true;
    if (returnToEditor) focusEditor();
  }
  function commitGoToLine() {
    const value = gotoInput.value.trim();
    const parsed = Number.parseInt(value, 10);
    if (!/^\d+$/.test(value) || !Number.isFinite(parsed)) {
      gotoStatus.textContent = "Enter a line number";
      gotoInput.focus();
      gotoInput.select();
      return;
    }
    const line = clamp(parsed, 1, lines.length) - 1;
    const point = { l: line, c: Math.min(cur.c, lines[line].length) };
    gotoBar.hidden = true;
    setSel(point, point);
    focusEditor();
  }
  function showSearch(replace, prefillSelection = false) {
    const selected = prefillSelection && hasSel() ? selText() : "";
    const selectedRange = selected ? [offsetAt(order()[0]), offsetAt(order()[1])] : null;
    searchBar.hidden = false; replaceRow.hidden = !replace;
    if (selected && selected.length <= 10000) findInput.value = selected;
    cancelQueuedSearch();
    activeFindIndex = -1;
    findMatches = [];
    pendingFindNavigation = null;
    pendingFindSelection = selectedRange && selected.length <= 10000
      ? { range: selectedRange, key: currentSearchKey() } : null;
    renderWindow(true);
    overlays();
    if (findInput.value) queueSearchRefresh();
    else findStatus.textContent = "Enter text to find";
    findInput.focus(); findInput.select();
  }

  function hideSearch() {
    cancelQueuedSearch();
    searchBar.hidden = true; findMatches = []; activeFindIndex = -1;
    findInput.classList.remove("invalid"); findStatus.classList.remove("error"); findStatus.textContent = "";
    renderWindow(true); overlays(); focusEditor();
  }
  function replaceOneMatch() {
    cancelQueuedSearch();
    if (readOnly) { findStatus.textContent = "Read only mode"; return; }
    const q = findInput.value; if (!q) return;
    rebuildFindMatches(false);
    if (findInput.classList.contains("invalid")) return;
    const [a, b] = order(), start = offsetAt(a), end = offsetAt(b);
    const idx = findMatches.findIndex(m => m.start === start && m.end === end);
    if (idx < 0) { findMatch(false); return; }
    const selected = selText(); let replacement = replaceInput.value;
    if (findRegex.checked) {
      try { replacement = selected.replace(new RegExp(q, findCase.checked ? "" : "i"), replaceInput.value); }
      catch (err) { findInput.classList.add("invalid"); findStatus.classList.add("error"); findStatus.textContent = "Invalid regex: " + err.message; return; }
    }
    snap("replace"); replaceSelectionText(replacement); commit(); activeFindIndex = -1; rebuildFindMatches(false); findMatch(false);
  }
  function replaceAllMatches() {
    cancelQueuedSearch();
    if (readOnly) { findStatus.textContent = "Read only mode"; return; }
    const q = findInput.value; if (!q) return;
    rebuildFindMatches(false);
    if (findInput.classList.contains("invalid")) return;
    if (!findMatches.length) { findStatus.textContent = "No matches"; return; }
    const text = source();
    const count = findMatches.length, beforeOffset = offsetAt(cur);
    let result = "";
    if (findRegex.checked) {
      let re;
      try { re = makeSearchRegex(true); } catch (err) { findInput.classList.add("invalid"); findStatus.classList.add("error"); findStatus.textContent = "Invalid regex: " + err.message; return; }
      result = text.replace(re, replaceInput.value);
    } else {
      let cursor = 0;
      for (const match of findMatches) {
        result += text.slice(cursor, match.start) + replaceInput.value;
        cursor = match.end;
      }
      result += text.slice(cursor);
    }
    snap("replace all"); lines = result.split("\n"); cur = pointAt(Math.min(beforeOffset, result.length), result); anc = { ...cur }; extra = []; folded.clear(); activeFindIndex = -1; commit();
    rebuildFindMatches(true); findStatus.textContent = "Replaced " + count + " occurrence(s)";
  }
  
  function closePop() { popOpen = false; pop.style.display = "none"; }
  function docWords() {
    const seen = new Set(), re = /[A-Za-z_$][\w$]*/g;
    for (let l = 0; l < lines.length; l++) {
      let m; re.lastIndex = 0;
      while ((m = re.exec(lines[l]))) {
        if (l === cur.l && m.index <= cur.c && m.index + m[0].length >= cur.c) continue;
        if (!KW.has(m[0]) && !LIT.has(m[0]) && !BI.has(m[0])) seen.add(m[0]);
      }
    }
    return [...seen].map(m => defs.has(m) ? { m, k: "f", fn: 1, p: defs.get(m) } : { m, k: "w" });
  }
  function suggest(force) {
    if (readOnly || hasSel()) return closePop();
    const s = lines[cur.l]; let a = cur.c;
    while (a > 0 && isW(s[a - 1])) a--;
    const w = s.slice(a, cur.c), dot = a > 0 && s[a - 1] === ".";
    if (/^\d/.test(w) || (!w && !dot && !force)) return closePop();
    if (!force && cur.c > 0 && inStrCom(cur.l, cur.c - 1)) return closePop();
    let cands;
    if (dot) { const m = /([\w$]+)\s*$/.exec(s.slice(0, a - 1)); cands = (m && MEMI[m[1]]) || GENI; }
    else cands = [...GLOBALS, ...docWords()];
    const lw = w.toLowerCase(), KO = { f: 0, v: 1, w: 2, k: 3, s: 4 }, seen = new Set(), out = [];
    for (const c of cands) {
      const ml = c.m.toLowerCase();
      const sc = !w ? 0 : c.m.startsWith(w) ? 0 : ml.startsWith(lw) ? 1 : (w.length >= 2 && ml.includes(lw)) ? 2 : -1;
      const key = c.m + c.k;
      if (sc < 0 || seen.has(key)) continue;
      seen.add(key); out.push({ ...c, sc });
    }
    out.sort((x, y) => x.sc - y.sc || KO[x.k] - KO[y.k] || x.m.length - y.m.length || (x.m < y.m ? -1 : 1));
    if (!out.length || (out.length === 1 && out[0].m === w && out[0].k !== "s")) return closePop();
    items = out.slice(0, 60); sel = 0; plen = w.length; popOpen = true; drawPop();
  }
  function drawPop() {
    pop.innerHTML = items.map((it, i) => '<div class="it' + (i === sel ? " sel" : "") + '" data-i="' + i + '"><b>' + it.k + "</b>" +
      esc(it.m) + (it.p !== undefined ? " <i>(" + esc(it.p) + ")</i>" : "") + (it.d ? " <i>" + esc(it.d) + "</i>" : "") + "</div>").join("");
    pop.style.display = "block";
    const t = sel * LH;
    if (t < pop.scrollTop) pop.scrollTop = t; else if (t + LH > pop.scrollTop + pop.clientHeight) pop.scrollTop = t + LH - pop.clientHeight;
    const ph = Math.min(items.length, 8) * LH + 2, point = caretPosition(cur.l, cur.c);
    let y = point.y + LH;
    if (y - ed.scrollTop + ph > ed.clientHeight && point.y - ed.scrollTop > ph) y = point.y - ph;
    pop.style.left = Math.max(GW + PAD, point.x - plen * CW) + "px"; pop.style.top = y + "px";
    updateSig();
  }
  function accept() {
    const it = items[sel]; closePop();
    if (readOnly) return;
    if (!it) return;
    snap("complete");
    const l = cur.l, a = cur.c - plen;
    if (it.t) {
      let template = it.t;
      if (a > 0 && lines[l][a - 1] === "@" && template.startsWith("@")) template = template.slice(1);
      const ind = /^ */.exec(lines[l])[0], txt = template.replace(/\n/g, "\n" + ind), i0 = txt.indexOf("$0");
      replaceRange(l, a, l, cur.c, txt.replace("$0", ""));
      if (i0 >= 0) {
        const parts = txt.slice(0, i0).split("\n");
        cur = { l: l + parts.length - 1, c: (parts.length === 1 ? a : 0) + parts[parts.length - 1].length }; anc = { ...cur };
      }
    } else if (it.fn) {
      const hasP = lines[l][cur.c] === "(";
      replaceRange(l, a, l, cur.c, it.m + (hasP ? "" : "()"));
      if (!hasP) { cur.c--; anc = { ...cur }; }
    } else replaceRange(l, a, l, cur.c, it.m);
    commit();
  }
  pop.addEventListener("mousedown", e => {
    e.preventDefault(); e.stopPropagation();
    const it = e.target.closest(".it");
    if (it) { sel = +it.dataset.i; accept(); }
  });

  
  taEl.addEventListener("keydown", e => {
    const k = e.key, ctrl = e.ctrlKey || e.metaKey, sh = e.shiftKey;
    if (readOnly) {
      const lk = k.toLowerCase();
      const navigation = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Escape"];
      const allowedShortcut = ctrl && ["f", "r", "g", "a", "c", "enter"].includes(lk);
      if (!navigation.includes(k) && !allowedShortcut) { e.preventDefault(); return; }
    }
    if (popOpen) {
      if (k === "ArrowDown" || k === "ArrowUp") { e.preventDefault(); sel = (sel + (k === "ArrowDown" ? 1 : items.length - 1)) % items.length; drawPop(); return; }
      if (k === "Enter" || k === "Tab") { e.preventDefault(); accept(); return; }
      if (k === "Escape") { e.preventDefault(); closePop(); return; }
    }
    if (ctrl) {
      const lk = k.toLowerCase();
      if (k === "Enter") { e.preventDefault(); onRun(); return; }
      if (lk === "f") { e.preventDefault(); showSearch(false, true); return; }
      if (lk === "r") { e.preventDefault(); showSearch(true, true); return; }
      if (lk === "g") { e.preventDefault(); showGoToLine(); return; }
      if (lk === "z") { e.preventDefault(); sh ? redo() : undo(); return; }
      if (lk === "y") { e.preventDefault(); redo(); return; }
      if (lk === "a") { e.preventDefault(); setSel({ l: 0, c: 0 }, { l: lines.length - 1, c: lines[lines.length - 1].length }); return; }
      if (k === " ") { e.preventDefault(); suggest(true); return; }
      if (k === "/") { e.preventDefault(); toggleComment(); return; }
      if (sh && e.code === "BracketLeft") { e.preventDefault(); foldCurrent(true); return; }
      if (sh && e.code === "BracketRight") { e.preventDefault(); foldCurrent(false); return; }
      if (lk === "c" || lk === "x" || lk === "v") return;         
    }
    switch (k) {
      case "ArrowLeft": {
        e.preventDefault();
        if (e.altKey && extra.length) moveExtraCursors(k, ctrl, sh);
        if (hasSel() && !sh && !ctrl && !e.altKey) { const [a] = order(); moveTo(a.l, a.c, false, undefined, e.altKey); break; }
        const p = ctrl ? wordLeft(cur.l, cur.c) : cur.c > 0 ? { l: cur.l, c: cur.c - 1 }
          : cur.l > 0 ? { l: cur.l - 1, c: lines[cur.l - 1].length } : cur;
        moveTo(p.l, p.c, sh, undefined, e.altKey); break;
      }
      case "ArrowRight": {
        e.preventDefault();
        if (e.altKey && extra.length) moveExtraCursors(k, ctrl, sh);
        if (hasSel() && !sh && !ctrl && !e.altKey) { const [, b] = order(); moveTo(b.l, b.c, false, undefined, e.altKey); break; }
        const p = ctrl ? wordRight(cur.l, cur.c) : cur.c < lines[cur.l].length ? { l: cur.l, c: cur.c + 1 }
          : cur.l < lines.length - 1 ? { l: cur.l + 1, c: 0 } : cur;
        moveTo(p.l, p.c, sh, undefined, e.altKey); break;
      }
      case "ArrowUp": case "ArrowDown": case "PageUp": case "PageDown": {
        e.preventDefault();
        if (e.altKey && extra.length) moveExtraCursors(k, ctrl, sh);
        if (wordWrap && !ctrl) {
          const n = k.startsWith("Page") ? Math.max(1, Math.floor(ed.clientHeight / LH) - 1) : 1;
          const point = wrappedVerticalPoint(cur, k.endsWith("Up") ? -n : n);
          moveTo(point.l, point.c, sh, undefined, e.altKey);
          break;
        }
        const n = k.startsWith("Page") ? Math.max(1, Math.floor(ed.clientHeight / LH) - 1) : 1;
        const vi = vmap[cur.l] + (k.endsWith("Up") ? -n : n), w = want < 0 ? cur.c : want;
        if (vi < 0) moveTo(0, 0, sh, undefined, e.altKey);
        else if (vi >= vis.length) moveTo(vis[vis.length - 1], lines[vis[vis.length - 1]].length, sh, undefined, e.altKey);
        else moveTo(vis[vi], Math.min(w, lines[vis[vi]].length), sh, w, e.altKey);
        break;
      }
      case "Home": {
        e.preventDefault();
        if (e.altKey && extra.length) moveExtraCursors(k, ctrl, sh);
        if (ctrl) { moveTo(0, 0, sh, undefined, e.altKey); break; }
        const ind = /^ */.exec(lines[cur.l])[0].length;
        moveTo(cur.l, cur.c !== ind ? ind : 0, sh, undefined, e.altKey); break;
      }
      case "End": {
        e.preventDefault(); if (e.altKey && extra.length) moveExtraCursors(k, ctrl, sh);
        ctrl ? moveTo(lines.length - 1, 1e9, sh, undefined, e.altKey) : moveTo(cur.l, 1e9, sh, undefined, e.altKey); break;
      }
      case "Backspace": e.preventDefault(); backspace(ctrl); break;
      case "Delete": e.preventDefault(); del(ctrl); break;
      case "Enter": e.preventDefault(); enter(); break;
      case "Escape": closePop(); sigHide = true; updateSig(); break;
      case "Tab":
        e.preventDefault();
        if (sh || (hasSel() && cur.l !== anc.l)) indent(sh ? -1 : 1);
        else { snap("type"); replaceSelectionText(" ".repeat(2 - (cur.c % 2))); commit(); closePop(); }
        break;
    }
  });
  taEl.addEventListener("keydown", e => {
    if (readOnly) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === ":" || e.key === ";")) {
      e.preventDefault();
      insertLiteralPunctuation(e.key);
    }
  }, { capture: true });
  taEl.addEventListener("beforeinput", e => {
    if (readOnly) { e.preventDefault(); return; }
    if (comp || e.isComposing) { pendingNativeEdit = null; return; }
    pendingNativeEdit = {
      start: taEl.selectionStart ?? offsetAt(cur),
      end: taEl.selectionEnd ?? offsetAt(cur),
      inputType: e.inputType || "",
      data: typeof e.data === "string" ? e.data : null
    };
    if (e.inputType !== "insertText") return;
    if (e.data === ":" || e.data === ";") {
      e.preventDefault();
      pendingNativeEdit = null;
      insertLiteralPunctuation(e.data);
    }
  });
  taEl.addEventListener("input", e => {
    if (comp) return;
    applyNativeTextareaInput(e);
  });
  taEl.addEventListener("compositionstart", () => {
    comp = true;
    pendingNativeEdit = null;
  });
  taEl.addEventListener("compositionend", () => {
    comp = false;
    pendingNativeEdit = null;
    applyNativeTextareaInput();
  });
  taEl.addEventListener("select", () => requestAnimationFrame(readNativeSelection));
  document.addEventListener("selectionchange", readNativeSelection);
  taEl.addEventListener("copy", e => {
    const selections = [];
    if (hasSel()) selections.push(selText());
    for (const p of extra) if (extraHasSel(p)) selections.push(extraSelText(p));
    if (!selections.length) return;
    e.clipboardData.setData("text/plain", selections.join("\n")); e.preventDefault();
  });
  taEl.addEventListener("cut", e => {
    if (readOnly) { e.preventDefault(); return; }
    const selections = [];
    if (hasSel()) selections.push(selText());
    for (const p of extra) if (extraHasSel(p)) selections.push(extraSelText(p));
    if (!selections.length) return;
    e.clipboardData.setData("text/plain", selections.join("\n")); e.preventDefault();
    if (extra.length) applyMulti("", 0);
    else { snap("cut"); replaceSelectionText(""); commit(); }
  });
  taEl.addEventListener("paste", e => {
    e.preventDefault();
    if (readOnly) return;
    const t = e.clipboardData.getData("text");
    if (t) {
      insertPastedText(t);
    }
  });
  taEl.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement !== taEl) closePop();
      if (!folded.size || document.hidden) return;
      const active = document.activeElement;
      if (active === document.body || active === document.documentElement || ed.contains(active)) {
        refocusAfterFold();
      }
    }, 0);
  });

  window.addEventListener("resize", () => {
    if (!box.offsetParent) return;
    const top = ed.scrollTop, left = ed.scrollLeft;
    measured = false;
    dirty = true;
    sync(true);
    ed.scrollTop = top;
    ed.scrollLeft = wordWrap ? 0 : left;
  });

  function hit(e) {
    const r = box.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (wordWrap) {
      let position = null;
      if (document.caretPositionFromPoint) position = document.caretPositionFromPoint(e.clientX, e.clientY);
      else if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (range) position = { offsetNode: range.startContainer, offset: range.startOffset };
      }
      if (position) {
        const node = position.offsetNode || position.node;
        const element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
        const row = element && element.closest ? element.closest(".ln") : null;
        if (row && rowsEl.contains(row)) {
          const l = clamp(Number(row.dataset.line), 0, lines.length - 1);
          const code = row.querySelector(".code");
          const c = code && code.contains(element) ? sourceOffsetAtDomPoint(code, node, position.offset) : 0;
          return { x, l, c: clamp(c, 0, lines[l].length) };
        }
      }
      let row = null;
      for (const item of renderedRows.values()) {
        const rr = item.getBoundingClientRect();
        if (e.clientY >= rr.top && e.clientY <= rr.bottom) { row = item; break; }
      }
      if (!row) {
        const ordered = [...renderedRows.values()];
        row = ordered.reduce((best, item) => {
          if (!best) return item;
          const a = best.getBoundingClientRect(), b = item.getBoundingClientRect();
          return Math.abs(e.clientY - b.top) < Math.abs(e.clientY - a.top) ? item : best;
        }, null);
      }
      const l = row ? clamp(Number(row.dataset.line), 0, lines.length - 1) : vis[0];
      const code = row && row.querySelector(".code"), cr = code && code.getBoundingClientRect();
      if (!cr || e.clientX <= cr.left) return { x, l, c: 0 };
      const columns = Math.max(1, Math.floor(cr.width / CW));
      const visualRow = clamp(Math.floor((e.clientY - cr.top) / LH), 0, Math.ceil(Math.max(1, row.offsetHeight) / LH) - 1);
      const column = Math.max(0, Math.round((e.clientX - cr.left) / CW));
      return { x, l, c: clamp(visualRow * columns + column, 0, lines[l].length) };
    }
    const l = vis[indexAtY(y)];
    return { x, l, c: clamp(Math.round((x - GW - PAD) / CW), 0, lines[l].length) };
  }
  // Touch placement and word selection are always mapped through the editor's
  // source model because the visible rows are virtualized.
  let touchPress = null;
  let lastTouchAt = -Infinity;
  ed.addEventListener("pointerdown", e => {
    if (e.target.closest && e.target.closest(".diag-dot")) return;
    if (e.pointerType !== "touch") return;
    lastTouchAt = performance.now();
    touchPress = { id: e.pointerId, x: e.clientX, y: e.clientY, time: lastTouchAt, moved: false, selectionStart: taEl.selectionStart, selectionEnd: taEl.selectionEnd };
  }, { passive: true });
  ed.addEventListener("pointermove", e => {
    if (!touchPress || e.pointerId !== touchPress.id) return;
    if (Math.hypot(e.clientX - touchPress.x, e.clientY - touchPress.y) > 9) touchPress.moved = true;
  }, { passive: true });
  window.addEventListener("pointerup", e => {
    if (!touchPress || e.pointerId !== touchPress.id) return;
    const press = touchPress;
    touchPress = null;
    const releasedAt = performance.now();
    lastTouchAt = releasedAt;
    const duration = releasedAt - press.time;
    if (press.moved) {
      // Let Android finish its native selection/handle gesture. Synchronize
      // the resulting range, but never open a popup here: doing so can cover
      // the range and dismiss the native draggable selection handles.
      requestAnimationFrame(() => {
        readNativeSelection();
        requestAnimationFrame(readNativeSelection);
      });
      return;
    }
    if (!ed.contains(e.target)) return;
    const h = hit(e);
    if (duration >= 420) {
      // Always use the editor's own source model for long-press selection.
      // The rendered code is virtualized, so native DOM selection would only
      // select visible rows (and can accidentally include page UI).
      if (e.cancelable) e.preventDefault();
      if (h.x < GW) {
        taEl.focus({ preventScroll: true });
        setSel({ l: h.l, c: 0 }, { l: h.l, c: lines[h.l].length });
        overlays();
        return;
      }
      const line = lines[h.l];
      let at = Math.min(h.c, Math.max(0, line.length - 1));
      if (at > 0 && !isW(line[at]) && isW(line[at - 1])) at--;
      let a = at, b = Math.min(line.length, at + 1);
      if (isW(line[at] || "")) {
        while (a > 0 && isW(line[a - 1])) a--;
        while (b < line.length && isW(line[b])) b++;
      }
      if (a === b && line.length) { a = Math.max(0, Math.min(h.c, line.length - 1)); b = a + 1; }
      taEl.focus({ preventScroll: true });
      setSel({ l: h.l, c: a }, { l: h.l, c: b });
      overlays();
      return;
    }
    if (h.x < GW) {
      if (Math.floor(h.x / CW) > digits && ranges.has(h.l)) toggleFold(h.l);
      else setSel({ l: h.l, c: 0 }, { l: h.l, c: lines[h.l].length });
      taEl.focus({ preventScroll: true });
      overlays();
    } else if (e.target.classList.contains("bdg")) {
      folded.delete(h.l);
      sync(true);
      taEl.focus({ preventScroll: true });
      writeNativeSelection();
      overlays();
    } else {
      moveTo(h.l, h.c, e.shiftKey);
      taEl.focus({ preventScroll: true });
      overlays();
    }
  }, { passive: false });
  ed.addEventListener("contextmenu", e => {
    e.preventDefault();
    // Android/WebView can raise contextmenu during a held touch. Suppress it
    // throughout the active touch and briefly after release. On touch devices,
    // the explicit toolbar action opens our menu without interrupting selection.
    if (touchPress || performance.now() - lastTouchAt < 1200) return;
    const h = hit(e);
    if (!hasSel()) {
      moveTo(h.l, h.c, false);
    } else {
      const [a, b] = order();
      const at = offsetAt({ l: h.l, c: h.c });
      const lo = offsetAt(a), hi = offsetAt(b);
      if (at < lo || at > hi) moveTo(h.l, h.c, false);
    }
    if (!hasSel()) taEl.focus({ preventScroll: true });
    showContextMenu(e.clientX, e.clientY, hasSel());
  });
  rowsEl.addEventListener("click", e => {
    const marker = e.target.closest && e.target.closest(".diag-dot");
    if (!marker) return;
    e.preventDefault(); e.stopPropagation();
    showDiagnostic(Number(marker.dataset.errorLine) - 1, marker);
  });
  if (g("diagnosticClose")) g("diagnosticClose").addEventListener("click", closeDiagnostic);
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (contextMenuEl && !contextMenuEl.hidden) {
      closeContextMenu();
      e.preventDefault();
    }
    if (diagnosticPopupEl && !diagnosticPopupEl.hidden) closeDiagnostic();
  }, true);
  const contextMenuButton = g("contextMenuBtn");
  if (contextMenuButton) {
    contextMenuButton.addEventListener("mousedown", e => e.preventDefault());
    contextMenuButton.addEventListener("click", e => {
      if (contextMenuEl && !contextMenuEl.hidden) {
        closeContextMenu();
        return;
      }
      const r = contextMenuButton.getBoundingClientRect();
      showContextMenu(r.left, r.bottom, false);
    });
  }
  if (contextMenuEl) contextMenuEl.addEventListener("click", async e => {
    const button = e.target.closest && e.target.closest("[data-context]");
    if (!button || button.disabled) return;
    const action = button.dataset.context;
    if (action === "cut") { await copySelectionToClipboard(true); return; }
    if (action === "copy") { await copySelectionToClipboard(false); return; }
    if (action === "paste") { await pasteFromClipboard(); return; }
    closeContextMenu();
    if (action === "find") showSearch(false, true);
    else if (action === "replace") showSearch(true, true);
    else if (action === "goto") showGoToLine();
    else if (action === "comment") { toggleComment(); taEl.focus({ preventScroll: true }); }
  });
  document.addEventListener("pointerdown", e => {
    if (contextMenuEl && !contextMenuEl.hidden && !contextMenuEl.contains(e.target) && e.target !== contextMenuButton) closeContextMenu();
    if (diagnosticPopupEl && !diagnosticPopupEl.hidden && !diagnosticPopupEl.contains(e.target) && !e.target.closest(".diag-dot")) closeDiagnostic();
  }, true);
  ed.addEventListener("pointercancel", () => { touchPress = null; }, { passive: true });

  ed.addEventListener("mousedown", e => {
    if (e.target.closest && e.target.closest(".diag-dot")) return;
    if (e.button !== 0) return;
    // Chrome emits compatibility mouse events after touch. Ignore them so the
    // pointer path remains the single source of touch caret placement.
    if ((e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) || performance.now() - lastTouchAt < 1200) return;
    if (e.target === ed && (e.offsetX > ed.clientWidth || e.offsetY > ed.clientHeight)) return;
    e.preventDefault(); taEl.focus({ preventScroll: true });
    const h = hit(e);
    if (e.altKey && e.shiftKey) {
      let i = extra.findIndex(p => p.l === h.l && p.c === h.c);
      if (i < 0) { extra.push({ l: h.l, c: h.c, a: { l: h.l, c: h.c } }); i = extra.length - 1; }
      else extra[i].a = { l: extra[i].l, c: extra[i].c };
      draggingExtra = i; dragging = false; closePop(); sync(false); return;
    }
    if (e.altKey) {
      const i = extra.findIndex(p => p.l === h.l && p.c === h.c);
      if (i >= 0) extra.splice(i, 1);
      else if (!(cur.l === h.l && cur.c === h.c)) extra.push({ l: h.l, c: h.c, a: null });
      closePop(); sync(false); return;
    }
    if (h.x < GW) {
      if (Math.floor(h.x / CW) > digits && ranges.has(h.l)) toggleFold(h.l);
      else setSel({ l: h.l, c: 0 }, { l: h.l, c: lines[h.l].length });
      return;
    }
    if (e.target.classList.contains("bdg")) { folded.delete(h.l); sync(true); return; }
    if (e.detail === 2) {
      const s = lines[h.l]; let a = h.c, b = h.c;
      while (a > 0 && isW(s[a - 1])) a--;
      while (b < s.length && isW(s[b])) b++;
      setSel({ l: h.l, c: a }, { l: h.l, c: b });
    } else if (e.detail >= 3) setSel({ l: h.l, c: 0 }, { l: h.l, c: lines[h.l].length });
    else { moveTo(h.l, h.c, e.shiftKey); dragging = true; }
  });
  window.addEventListener("mousemove", e => {
    if (draggingExtra >= 0) {
      const r = ed.getBoundingClientRect();
      if (e.clientY < r.top) ed.scrollTop = Math.max(0, ed.scrollTop - LH);
      else if (e.clientY > r.bottom) ed.scrollTop += LH;
      if (e.clientX < r.left + GW) ed.scrollLeft = Math.max(0, ed.scrollLeft - CW * 2);
      else if (e.clientX > r.right) ed.scrollLeft += CW * 2;
      const h = hit(e), p = extra[draggingExtra];
      if (p) { p.l = h.l; p.c = h.c; sync(false); }
      return;
    }
    if (!dragging) return;
    const r = ed.getBoundingClientRect();
    if (e.clientY < r.top) ed.scrollTop = Math.max(0, ed.scrollTop - LH);
    else if (e.clientY > r.bottom) ed.scrollTop += LH;
    if (e.clientX < r.left + GW) ed.scrollLeft = Math.max(0, ed.scrollLeft - CW * 2);
    else if (e.clientX > r.right) ed.scrollLeft += CW * 2;
    const h = hit(e); moveTo(h.l, h.c, true, undefined, e.altKey);
  });
  window.addEventListener("mouseup", () => { dragging = false; draggingExtra = -1; });
  g("findNext").onclick = () => findMatch();
  g("findPrev").onclick = () => findMatch(true);
  g("replaceOne").onclick = replaceOneMatch;
  g("replaceAll").onclick = replaceAllMatches;
  g("closeSearch").onclick = hideSearch;
  const refreshSearch = () => queueSearchRefresh();
  findInput.addEventListener("input", refreshSearch);
  findCase.addEventListener("change", refreshSearch);
  findRegex.addEventListener("change", refreshSearch);
  searchBar.addEventListener("keydown", e => { if (e.ctrlKey || e.metaKey) { const k = e.key.toLowerCase(); if (k === "f" || k === "r") { e.preventDefault(); showSearch(k === "r"); } } });
  findInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); findMatch(e.shiftKey); } if (e.key === "Escape") hideSearch(); });
  replaceInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); replaceOneMatch(); } if (e.key === "Escape") hideSearch(); });
  g("gotoGo").addEventListener("click", commitGoToLine);
  g("gotoClose").addEventListener("click", () => hideGoToLine(true));
  gotoInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); commitGoToLine(); }
    if (e.key === "Escape") { e.preventDefault(); hideGoToLine(true); }
  });


  let editorShortcutTarget = false;
  taEl.addEventListener("focus", () => { editorShortcutTarget = true; });
  document.addEventListener("pointerdown", e => {
    if (!ed.contains(e.target)) editorShortcutTarget = false;
  }, true);
  document.addEventListener("focusin", e => {
    if (!ed.contains(e.target)) editorShortcutTarget = false;
  }, true);
  document.addEventListener("keydown", e => {
    const ctrl = e.ctrlKey || e.metaKey;
    const targetIsUnfocusedPage = document.activeElement === document.body ||
      document.activeElement === document.documentElement;
    if (!ctrl || e.key.toLowerCase() !== "a" || !editorShortcutTarget || !targetIsUnfocusedPage) return;
    e.preventDefault();
    setSel({ l: 0, c: 0 }, { l: lines.length - 1, c: lines[lines.length - 1].length });
    try { taEl.focus({ preventScroll: true }); } catch (_) { taEl.focus(); }
    writeNativeSelection();
  }, true);

  ed.addEventListener("scroll", () => {
    if (scrollRenderPending) return;
    scrollRenderPending = true;
    requestAnimationFrame(() => {
      scrollRenderPending = false;
      if (renderWindow(false)) overlays(true);
    });
  }, { passive: true });

  return {
    init(o) { onRun = o.onRun || onRun; onChange = o.onChange || onChange; },
    getValue: () => lines.join("\n"),
    getFoldableLines() { return [...ranges.keys()].sort((a, b) => a - b); },
    setValue(t) {
      lines = norm(t).split("\n"); invalidateSource(); cur = { l: 0, c: 0 }; anc = { l: 0, c: 0 }; extra = [];
      folded.clear(); undoS = []; redoS = []; closePop(); dirty = true; sync(true); writeNativeSelection(); scheduleLiveDiagnostics();
    },
    focus() { taEl.focus({ preventScroll: true }); overlays(); writeNativeSelection(); },
    selectAll() {
      setSel({ l: 0, c: 0 }, { l: lines.length - 1, c: lines[lines.length - 1].length });
      try { taEl.focus({ preventScroll: true }); } catch (_) { taEl.focus(); }
      writeNativeSelection();
    },
    insertText(text) {
      if (readOnly) return;
      // Toolbar buttons take focus briefly on mobile. Keep using the editor's
      // last synchronized selection, insert once, then restore the native
      // textarea caret to the resulting source position.
      closePop();
      snap("type");
      if (hasSel()) replaceSelectionText(String(text));
      else replaceRange(cur.l, cur.c, cur.l, cur.c, String(text));
      commit();
      try { taEl.focus({ preventScroll: true }); } catch (_) { taEl.focus(); }
      updateNativeTextarea();
    },
    replaceSelection(text) {
      if (readOnly) return;
      closePop();
      snap("type");
      replaceSelectionText(String(text));
      commit();
      try { taEl.focus({ preventScroll: true }); } catch (_) { taEl.focus(); }
      updateNativeTextarea();
    },
    openFind() { showSearch(false, true); },
    openReplace() { showSearch(true, true); },
    openGoToLine() { showGoToLine(); },
    isWordWrap() { return wordWrap; },
    isReadOnly() { return readOnly; },
    setWordWrap(value) {
      const next = !!value;
      if (wordWrap === next) return;
      const top = ed.scrollTop;
      wordWrap = next;
      try { localStorage.setItem("cpl.editor.wordWrap", String(wordWrap)); } catch (_) {}
      ed.classList.toggle("word-wrap", wordWrap);
      dirty = true; sync(true);
      ed.scrollTop = top;
      if (wordWrap) ed.scrollLeft = 0;
    },
    setReadOnly(value) {
      readOnly = !!value;
      try { localStorage.setItem("cpl.editor.readOnly", String(readOnly)); } catch (_) {}
      if (readOnly) closePop();
      taEl.readOnly = readOnly;
      ed.classList.toggle("read-only", readOnly);
      for (const button of document.querySelectorAll(".mobile-tools button")) button.disabled = readOnly;
      for (const id of ["replaceOne", "replaceAll"]) { const button = g(id); if (button) button.disabled = readOnly; }
      sync(false);
    },
    refresh() { dirty = true; sync(true); },
    foldAll() { for (const s of ranges.keys()) folded.add(s); foldFix(); sync(true); writeNativeSelection(); refocusAfterFold(); },
    unfoldAll() { folded.clear(); sync(true); writeNativeSelection(); refocusAfterFold(); }
  };
})();

// Global compatibility function for editor integrations and legacy hooks.
// A top-level function declaration creates both a callable global binding and
// a window property in a classic browser script. Keep the window assignment as
// an explicit bridge for code that calls window.replaceSel(...).
function replaceSel(text) {
  const api = window.CPLEditor;
  if (!api || typeof api.replaceSelection !== "function") {
    console.error("replaceSel() called before the CPL editor API is ready.");
    return false;
  }
  return api.replaceSelection(String(text == null ? "" : text));
}
window.CPLEditor = Editor;
window.replaceSel = replaceSel;
