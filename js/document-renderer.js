/* Documentation content data lives in ../Document.js. This file only renders it. */
(function () {
  "use strict";

  const host = document.getElementById("docsContent");
  const data = window.CPL_DOCUMENT_DATA;
  if (!host || !data || !Array.isArray(data.sections)) return;

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[ch]);
  }

  function inline(value) {
    const source = String(value);
    const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
    let result = "", last = 0, match;
    while ((match = pattern.exec(source))) {
      result += escapeHTML(source.slice(last, match.index));
      if (match[1] !== undefined) result += '<code class="doc-syntax">' + escapeHTML(match[1]) + '</code>';
      else result += "<b>" + escapeHTML(match[2]) + "</b>";
      last = pattern.lastIndex;
    }
    result += escapeHTML(source.slice(last));
    return result;
  }

  function renderEntry(block) {
    let html = '<div class="syntax-entry"><p><code class="doc-syntax">' + escapeHTML(block.term || "") + "</code></p>";
    for (const paragraph of (block.paragraphs || [])) html += "<p>" + inline(paragraph) + "</p>";
    if (Array.isArray(block.items) && block.items.length) {
      html += "<ul>" + block.items.map(item => "<li>" + inline(item) + "</li>").join("") + "</ul>";
    }
    if (block.code) html += '<pre class="doc-example"><code>' + escapeHTML(block.code) + "</code></pre>";
    return html + "</div>";
  }

  function renderBlock(block) {
    switch (block.type) {
      case "p": return "<p>" + inline(block.text || "") + "</p>";
      case "h4": return "<h4>" + escapeHTML(block.text || "") + "</h4>";
      case "list": return "<ul>" + (block.items || []).map(item => "<li>" + inline(item) + "</li>").join("") + "</ul>";
      case "code": return '<pre class="doc-example"><code>' + escapeHTML(block.text || "") + "</code></pre>";
      case "entry": return renderEntry(block);
      default: return "";
    }
  }

  host.innerHTML = data.sections.map(section => {
    const className = section.className ? " " + escapeHTML(section.className) : "";
    const heading = section.title ? "<h3>" + escapeHTML(section.title) + "</h3>" : "";
    const content = (section.blocks || []).map(renderBlock).join("");
    return '<section class="popup-section' + className + '">' + heading + content + "</section>";
  }).join('<hr class="popup-sep" />');
})();
