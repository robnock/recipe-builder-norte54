import { useState, useEffect, useCallback, useRef } from "react";
import { loadData, saveData, subscribeToData, loadPassword, savePassword } from "./storage.js";

// ═══════════════════════════════════════════
//  UNITS & CONVERSION
// ═══════════════════════════════════════════
const VOLUME = ["tsp","tbsp","fl_oz","cup","pint","quart","gallon","mL","L"];
const WEIGHT = ["oz","lb","g","kg"];
const COUNT  = ["count"];
const ALL_UNITS = [...VOLUME, ...WEIGHT, ...COUNT];

const UNIT_LABELS = {
  tsp:"tsp", tbsp:"tbsp", fl_oz:"fl oz", cup:"cup", pint:"pint",
  quart:"quart", gallon:"gallon", mL:"mL", L:"L",
  oz:"oz", lb:"lb", g:"g", kg:"kg", count:"count"
};

const TO_BASE = {
  tsp:4.92892, tbsp:14.7868, fl_oz:29.5735, cup:236.588,
  pint:473.176, quart:946.353, gallon:3785.41, mL:1, L:1000,
  oz:28.3495, lb:453.592, g:1, kg:1000, count:1
};

const unitType = u => VOLUME.includes(u) ? "volume" : WEIGHT.includes(u) ? "weight" : "count";
const compatible = (a,b) => a && b && unitType(a) === unitType(b);
const convert = (v, from, to) => compatible(from,to) ? v * TO_BASE[from] / TO_BASE[to] : null;

// ═══════════════════════════════════════════
//  COST HELPERS
// ═══════════════════════════════════════════
const ingredientUnitCost = (ing, qty, unit) => {
  if (!unit || !compatible(unit, ing.purchaseUnit)) return null;
  const inPurchaseUnits = convert(qty, unit, ing.purchaseUnit);
  return (inPurchaseUnits / ing.purchaseQuantity) * ing.purchasePrice;
};

const recipeTotalCost = (recipe, ingredients) => {
  let total = 0, warn = false;
  for (const ri of recipe.items) {
    const ing = ingredients.find(i => i.id === ri.ingredientId);
    if (!ing) { warn = true; continue; }
    if (!ri.unit) { warn = true; continue; }
    const c = ingredientUnitCost(ing, ri.quantity, ri.unit);
    if (c === null) { warn = true; continue; }
    total += c;
  }
  return { cost: total, hasWarning: warn };
};

// Given a recipe and a target unit, find the matching yield (A or B)
const resolveRecipeYield = (rec, targetUnit) => {
  if (!targetUnit) return null;
  // Try primary yield
  if (rec.yieldUnit && compatible(targetUnit, rec.yieldUnit)) {
    return { quantity: rec.yieldQuantity, unit: rec.yieldUnit };
  }
  // Try secondary yield
  if (rec.yieldUnitB && rec.yieldQuantityB && compatible(targetUnit, rec.yieldUnitB)) {
    return { quantity: rec.yieldQuantityB, unit: rec.yieldUnitB };
  }
  return null;
};

const dishTotalCost = (dish, ingredients, recipes) => {
  let total = 0, warn = false;
  for (const comp of dish.items) {
    if (!comp.unit) { warn = true; continue; }
    if (comp.type === "ingredient") {
      const ing = ingredients.find(i => i.id === comp.refId);
      if (!ing) { warn = true; continue; }
      const c = ingredientUnitCost(ing, comp.quantity, comp.unit);
      if (c === null) { warn = true; continue; }
      total += c;
    } else {
      const rec = recipes.find(r => r.id === comp.refId);
      if (!rec) { warn = true; continue; }
      const rc = recipeTotalCost(rec, ingredients);
      if (rc.hasWarning) warn = true;
      const yld = resolveRecipeYield(rec, comp.unit);
      if (!yld) { warn = true; continue; }
      const inYieldUnits = convert(comp.quantity, comp.unit, yld.unit);
      total += (inYieldUnits / yld.quantity) * rc.cost;
    }
  }
  return { cost: total, hasWarning: warn };
};

// ═══════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const fmt = n => n == null ? "\u2014" : "$" + n.toFixed(2);
const fmtQty = n => {
  if (n == null) return "\u2014";
  if (Number.isInteger(n)) return n.toString();
  return n < 0.01 ? n.toFixed(3) : n.toFixed(2);
};

// ═══════════════════════════════════════════
//  PDF DOWNLOAD (self-contained, no deps)
// ═══════════════════════════════════════════
const buildPDF = (() => {
  // Minimal PDF builder using raw PDF format
  const enc = s => {
    // Encode string to PDF literal, escaping special chars
    return s.replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)");
  };

  const wordWrap = (text, maxChars) => {
    const result = [];
    const paragraphs = text.split("\n");
    for (const para of paragraphs) {
      if (para.trim() === "") { result.push(""); continue; }
      const words = para.split(/\s+/);
      let line = "";
      for (const w of words) {
        if (line.length + w.length + 1 > maxChars && line) { result.push(line); line = w; }
        else { line = line ? line + " " + w : w; }
      }
      if (line) result.push(line);
    }
    return result;
  };

  return (title, meta, items, instructions, yields, customScale) => {
    const PAGE_W = 612; // letter width in points
    const PAGE_H = 792; // letter height
    const M = 50; // margin
    const USABLE = PAGE_W - M * 2;
    const baseScales = [1, 2, 3, 5];
    const scales = customScale && customScale > 0 && !baseScales.includes(customScale)
      ? [...baseScales, customScale].sort((a, b) => a - b)
      : baseScales;

    // We'll collect drawing commands per page, then assemble PDF
    let pages = [[]]; // array of pages, each page is array of content stream strings
    let y = PAGE_H - M; // PDF y goes up from bottom

    const cur = () => pages[pages.length - 1];
    const needSpace = (pts) => {
      if (y - pts < M) { pages.push([]); y = PAGE_H - M; }
    };

    // Text helpers — using Helvetica (built-in PDF font)
    const setFont = (size, bold, italic, r, g, b) => {
      const fn = bold && italic ? "/F4" : bold ? "/F2" : italic ? "/F3" : "/F1";
      cur().push(`BT ${fn} ${size} Tf ${(r/255).toFixed(3)} ${(g/255).toFixed(3)} ${(b/255).toFixed(3)} rg ET`);
    };

    const drawText = (text, x, yPos, size, bold, italic, r, g, b) => {
      const fn = bold && italic ? "/F4" : bold ? "/F2" : italic ? "/F3" : "/F1";
      const safe = enc(text);
      cur().push(`BT ${fn} ${size} Tf ${(r/255).toFixed(3)} ${(g/255).toFixed(3)} ${(b/255).toFixed(3)} rg ${x} ${yPos} Td (${safe}) Tj ET`);
    };

    const drawTextRight = (text, rightX, yPos, size, bold, italic, r, g, b) => {
      const avgW = size * (bold ? 0.58 : 0.52);
      const textW = text.length * avgW;
      drawText(text, rightX - textW, yPos, size, bold, italic, r, g, b);
    };

    const drawLine = (x1, y1, x2, y2, r, g, b, width) => {
      cur().push(`${(r/255).toFixed(3)} ${(g/255).toFixed(3)} ${(b/255).toFixed(3)} RG ${width} w ${x1} ${y1} m ${x2} ${y1} l S`);
    };

    // Title
    drawText(title, M, y, 22, true, false, 47, 85, 64);
    y -= 26;

    // Meta
    if (meta) {
      drawText(meta, M, y, 11, false, false, 120, 120, 120);
      y -= 22;
    } else {
      y -= 8;
    }

    // Column positions
    const colEnd = M + USABLE;
    const useScales = yields && yields.length > 0;
    const nameColW = USABLE * (useScales ? 0.36 : 0.50);
    const scaleColW = useScales ? (USABLE - nameColW) / scales.length : 0;
    const scaleColRight = (i) => M + nameColW + scaleColW * (i + 1);

    // Table header line
    drawLine(M, y, colEnd, y, 47, 85, 64, 1.5);
    y -= 14;
    if (useScales) {
      drawText("SCALE", M, y, 9, true, false, 120, 120, 120);
      scales.forEach((s, i) => {
        drawTextRight(`${s}x`, scaleColRight(i), y, 9, true, false, 120, 120, 120);
      });
    } else {
      drawText("COMPONENT", M, y, 9, true, false, 120, 120, 120);
      drawTextRight("QUANTITY", colEnd, y, 9, true, false, 120, 120, 120);
    }
    y -= 6;
    drawLine(M, y, colEnd, y, 47, 85, 64, 1.5);
    y -= 16;

    // Yield rows (if provided)
    if (useScales) {
      yields.forEach((yld, yi) => {
        const label = yields.length > 1 ? `YIELD ${String.fromCharCode(65 + yi)}` : "YIELD";
        drawText(label, M, y, 10, true, false, 47, 85, 64);
        scales.forEach((s, i) => {
          const yStr = `${fmtQty(yld.quantity * s)} ${UNIT_LABELS[yld.unit]}`;
          drawTextRight(yStr, scaleColRight(i), y, 9, true, false, 47, 85, 64);
        });
        y -= 6;
        drawLine(M, y, colEnd, y, 47, 85, 64, 0.75);
        y -= 16;
      });
    }

    // Table rows
    items.forEach(it => {
      needSpace(it.note ? 36 : 22);
      drawText(it.name, M, y, 10, false, false, 42, 42, 42);

      if (useScales) {
        scales.forEach((s, i) => {
          const qtyStr = it.unit ? `${fmtQty(it.quantity * s)} ${UNIT_LABELS[it.unit]}` : "-";
          drawTextRight(qtyStr, scaleColRight(i), y, 9, false, false, 42, 42, 42);
        });
      } else {
        const qtyStr = it.unit ? `${fmtQty(it.quantity)} ${UNIT_LABELS[it.unit]}` : "-";
        drawTextRight(qtyStr, colEnd, y, 9, false, false, 42, 42, 42);
      }

      if (it.note) {
        y -= 13;
        needSpace(14);
        drawText(it.note, M + 8, y, 9, false, true, 140, 140, 140);
      }

      y -= 6;
      drawLine(M, y, colEnd, y, 220, 220, 220, 0.5);
      y -= 14;
    });

    // Instructions
    if (instructions) {
      needSpace(36);
      y -= 8;
      drawText("Instructions", M, y, 14, true, false, 47, 85, 64);
      y -= 20;

      const lines = wordWrap(instructions, Math.floor(USABLE / 5.2));
      lines.forEach(line => {
        needSpace(16);
        drawText(line, M, y, 10, false, false, 42, 42, 42);
        y -= 14;
      });
    }

    // === Assemble raw PDF ===
    let objs = [];
    let objOffsets = [];
    let pdf = "";

    const addObj = (content) => {
      objs.push(content);
      return objs.length; // 1-based
    };

    // Obj 1: Catalog
    addObj("<< /Type /Catalog /Pages 2 0 R >>");

    // Obj 2: Pages (placeholder, we'll fill after adding page objs)
    addObj("PLACEHOLDER");

    // Obj 3-6: Fonts (Helvetica family)
    const fontNames = [
      ["Helvetica", "F1"], ["Helvetica-Bold", "F2"],
      ["Helvetica-Oblique", "F3"], ["Helvetica-BoldOblique", "F4"]
    ];
    const fontObjStart = objs.length + 1;
    fontNames.forEach(([name]) => {
      addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} >>`);
    });

    // Font dictionary string
    const fontDict = fontNames.map(([, alias], i) => `/${alias} ${fontObjStart + i} 0 R`).join(" ");

    // Resources dict
    const resourcesId = addObj(`<< /Font << ${fontDict} >> >>`);

    // Build page objects
    const pageIds = [];
    pages.forEach(cmds => {
      const stream = cmds.join("\n");
      const streamId = addObj(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      const pageId = addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${streamId} 0 R /Resources ${resourcesId} 0 R >>`);
      pageIds.push(pageId);
    });

    // Fix Pages object
    const kidRefs = pageIds.map(id => `${id} 0 R`).join(" ");
    objs[1] = `<< /Type /Pages /Kids [${kidRefs}] /Count ${pageIds.length} >>`;

    // Serialize
    pdf = "%PDF-1.4\n";
    objs.forEach((content, i) => {
      objOffsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${content}\nendobj\n`;
    });

    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    objOffsets.forEach(off => {
      pdf += String(off).padStart(10, "0") + " 00000 n \n";
    });
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    return pdf;
  };
})();

const downloadPDF = (title, meta, items, instructions, yields, customScale) => {
  try {
    const pdfStr = buildPDF(title, meta, items, instructions, yields, customScale);
    // Convert string to byte array
    const bytes = new Uint8Array(pdfStr.length);
    for (let i = 0; i < pdfStr.length; i++) bytes[i] = pdfStr.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "_")}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    console.error("PDF generation failed:", e);
    alert("PDF generation failed. See console for details.");
  }
};

// ═══════════════════════════════════════════
//  CSV HELPERS
// ═══════════════════════════════════════════
const CSV_HEADERS = ["name","purveyor","purchaseQuantity","purchaseUnit","purchasePrice","notes"];

const exportCSV = (ingredients) => {
  const escape = v => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const lines = [CSV_HEADERS.join(",")];
  for (const ing of [...ingredients].sort((a,b) => a.name.localeCompare(b.name))) {
    lines.push(CSV_HEADERS.map(h => escape(ing[h])).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "ingredients.csv"; a.click();
  URL.revokeObjectURL(url);
};

const parseCSV = text => {
  const rows = []; let row = []; let cell = ""; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cell.trim()); cell = ""; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i+1] === '\n') i++;
        row.push(cell.trim()); if (row.some(c => c)) rows.push(row); row = []; cell = "";
      } else cell += c;
    }
  }
  row.push(cell.trim()); if (row.some(c => c)) rows.push(row);
  return rows;
};

const importCSV = (text, existing) => {
  const rows = parseCSV(text);
  if (rows.length < 2) return { error: "CSV is empty or has no data rows." };
  const header = rows[0].map(h => h.toLowerCase().trim());
  const nameIdx = header.indexOf("name");
  if (nameIdx < 0) return { error: 'CSV must have a "name" column.' };
  const colMap = {};
  CSV_HEADERS.forEach(h => { const i = header.indexOf(h.toLowerCase()); if (i >= 0) colMap[h] = i; });

  const results = { added: 0, updated: 0, errors: [] };
  const updated = [...existing];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = row[nameIdx]?.trim();
    if (!name) { results.errors.push(`Row ${r+1}: missing name`); continue; }
    const pq = colMap.purchaseQuantity != null ? parseFloat(row[colMap.purchaseQuantity]) : NaN;
    const pp = colMap.purchasePrice != null ? parseFloat(row[colMap.purchasePrice]) : NaN;
    const pu = colMap.purchaseUnit != null ? row[colMap.purchaseUnit]?.trim() : "";
    if (isNaN(pq) || pq <= 0) { results.errors.push(`Row ${r+1} (${name}): invalid purchase quantity`); continue; }
    if (isNaN(pp) || pp < 0) { results.errors.push(`Row ${r+1} (${name}): invalid purchase price`); continue; }
    if (!ALL_UNITS.includes(pu)) { results.errors.push(`Row ${r+1} (${name}): unknown unit "${pu}"`); continue; }

    const existIdx = updated.findIndex(i => i.name.toLowerCase() === name.toLowerCase());
    const purveyor = colMap.purveyor != null ? (row[colMap.purveyor]?.trim() || "") : "";
    const notes = colMap.notes != null ? (row[colMap.notes]?.trim() || "") : "";
    const obj = { name, purveyor, purchaseQuantity: pq, purchaseUnit: pu, purchasePrice: pp, notes };

    if (existIdx >= 0) {
      updated[existIdx] = { ...updated[existIdx], ...obj };
      results.updated++;
    } else {
      updated.push({ ...obj, id: uid() });
      results.added++;
    }
  }
  return { data: updated, ...results };
};

// ═══════════════════════════════════════════
//  STYLES
// ═══════════════════════════════════════════
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=DM+Sans:wght@400;500;600;700&display=swap');
:root {
  --bg:#FAF8F5; --card:#fff; --primary:#3D6B4F; --primary-h:#2F5540;
  --accent:#C4843E; --accent-light:#FDF3E7; --text:#2A2A2A; --muted:#888;
  --border:#E5E0DA; --warn-bg:#FFF3CD; --warn-text:#856404;
  --danger:#C0392B; --danger-bg:#FDEDEB; --radius:10px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
h1,h2,h3{font-family:'Libre Baskerville',serif;font-weight:700}
button{font-family:'DM Sans',sans-serif;cursor:pointer;border:none;border-radius:6px;font-size:14px;font-weight:600;transition:all .15s}
input,select,textarea{font-family:'DM Sans',sans-serif;font-size:14px;border:1.5px solid var(--border);border-radius:6px;padding:8px 12px;outline:none;transition:border .15s;background:#fff;color:var(--text);height:auto}
input:focus,select:focus,textarea:focus{border-color:var(--primary)}
textarea{resize:vertical;height:auto}
select{appearance:auto;min-height:38px}
input[type="number"],input[type="text"],input:not([type]){min-height:38px}

.app{max-width:1100px;margin:0 auto;padding:20px 24px 60px}
.header{display:flex;align-items:baseline;gap:16px;margin-bottom:8px;flex-wrap:wrap}
.header h1{font-size:26px;color:var(--primary)}
.header .sub{font-size:13px;color:var(--muted);font-style:italic}
.tabs{display:flex;gap:4px;margin-bottom:24px;border-bottom:2px solid var(--border);padding-bottom:0}
.tab{padding:10px 20px;font-weight:600;font-size:15px;color:var(--muted);background:none;border-radius:8px 8px 0 0;position:relative;bottom:-2px;border-bottom:2px solid transparent}
.tab:hover{color:var(--text)}
.tab.active{color:var(--primary);border-bottom:2px solid var(--primary);background:var(--card)}

.btn{padding:8px 18px;border-radius:6px;font-weight:600}
.btn-primary{background:var(--primary);color:#fff}
.btn-primary:hover{background:var(--primary-h)}
.btn-accent{background:var(--accent);color:#fff}
.btn-accent:hover{background:#a9702f}
.btn-outline{background:none;border:1.5px solid var(--border);color:var(--text)}
.btn-outline:hover{border-color:var(--primary);color:var(--primary)}
.btn-danger{background:var(--danger-bg);color:var(--danger)}
.btn-danger:hover{background:var(--danger);color:#fff}
.btn-sm{padding:5px 12px;font-size:13px}

.card{background:var(--card);border-radius:var(--radius);border:1px solid var(--border);padding:20px;margin-bottom:16px}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:10px 14px;font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);border-bottom:2px solid var(--border);font-weight:600}
td{padding:10px 14px;border-bottom:1px solid #f0ede8;font-size:14px}
tr:hover td{background:#FDFCFA}

.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px}
.modal{background:var(--card);border-radius:12px;padding:28px;max-width:640px;width:100%;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.2)}
.modal h2{font-size:20px;margin-bottom:20px;color:var(--primary)}
.field{margin-bottom:16px}
.field label{display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:var(--text)}
.field input,.field select,.field textarea{width:100%;box-sizing:border-box}
.field select{padding:8px 12px}
.row{display:flex;gap:12px;align-items:flex-end}
.row > *{flex:1}

.warn-box{background:var(--warn-bg);border:1px solid #f0d78c;border-radius:6px;padding:10px 14px;font-size:13px;color:var(--warn-text);margin:4px 0 8px}
.empty{text-align:center;padding:48px 20px;color:var(--muted);font-size:15px}

.detail-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.detail-title{font-size:22px;color:var(--primary)}
.detail-meta{font-size:14px;color:var(--muted);margin-top:2px}
.cost-badge{display:inline-block;background:var(--accent-light);color:var(--accent);padding:4px 12px;border-radius:20px;font-weight:700;font-size:14px}
.margin-badge{display:inline-block;padding:4px 12px;border-radius:20px;font-weight:700;font-size:14px}

.scale-bar{display:flex;align-items:center;gap:8px;margin:16px 0;flex-wrap:wrap}
.scale-btn{width:40px;height:32px;border-radius:6px;font-size:13px;font-weight:700;background:#f5f2ee;color:var(--text);border:1.5px solid var(--border)}
.scale-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}

.instructions-block{margin-top:20px;white-space:pre-wrap;line-height:1.7;background:#FDFCFA;border-radius:8px;padding:16px;border:1px solid var(--border)}
.instructions-block h3{font-size:16px;color:var(--primary);margin-bottom:8px}

.item-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.item-row input[type="number"]{width:80px;min-height:36px}
.item-row select{width:100px;min-height:36px}
.item-row .item-note-input{min-height:36px}
.remove-btn{width:28px;height:28px;border-radius:50%;background:var(--danger-bg);color:var(--danger);font-size:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.remove-btn:hover{background:var(--danger);color:#fff}
.drag-handle{cursor:grab;color:var(--muted);font-size:16px;user-select:none;padding:0 4px;flex-shrink:0}
.drag-handle:active{cursor:grabbing}
.item-note-input{font-size:13px;padding:8px 12px;color:var(--text);border:1.5px solid var(--border);border-radius:6px;width:120px;min-width:80px;flex-shrink:1;background:#fff}
.item-note-input:focus{border-color:var(--primary)}
.item-note-input::placeholder{color:#aaa;font-size:13px}
.dragging{opacity:0.4}

.list-sidebar{display:grid;grid-template-columns:280px 1fr;gap:20px}
@media(max-width:768px){.list-sidebar{grid-template-columns:1fr}}
.list-panel{border-right:1px solid var(--border);padding-right:20px}
@media(max-width:768px){.list-panel{border-right:none;padding-right:0}}
.list-item{padding:10px 14px;border-radius:8px;cursor:pointer;margin-bottom:4px;transition:all .1s;font-size:14px}
.list-item:hover{background:#f0ede8}
.list-item.active{background:var(--primary);color:#fff}
.list-item .li-cost{font-size:12px;opacity:.7;margin-top:2px}

.loading{display:flex;align-items:center;justify-content:center;height:200px;color:var(--muted);font-size:16px}

.search-bar{width:100%;padding:9px 14px 9px 36px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%23999' viewBox='0 0 24 24'%3E%3Cpath d='M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'/%3E%3C/svg%3E") 12px center no-repeat;outline:none;transition:border .15s}
.search-bar:focus{border-color:var(--primary)}

.ss-wrap{position:relative;min-width:160px}
.ss-input{width:100%;padding:7px 10px;border:1.5px solid var(--border);border-radius:6px;font-size:14px;outline:none;background:#fff;min-height:34px;box-sizing:border-box}
.ss-input:focus{border-color:var(--primary)}
.ss-dropdown{position:absolute;top:100%;left:0;right:0;max-height:200px;overflow-y:auto;background:#fff;border:1.5px solid var(--border);border-top:none;border-radius:0 0 6px 6px;z-index:50;box-shadow:0 8px 24px rgba(0,0,0,.1)}
.ss-option{padding:7px 10px;cursor:pointer;font-size:13px}
.ss-option:hover,.ss-option.highlighted{background:var(--accent-light)}
.ss-option .ss-sub{font-size:11px;color:var(--muted)}
.ss-empty{padding:10px;font-size:13px;color:var(--muted);text-align:center}

.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
.toolbar-right{margin-left:auto;display:flex;gap:8px;align-items:center}

.import-result{margin:12px 0;padding:12px;border-radius:8px;font-size:13px}
.import-result.success{background:#e8f5e9;color:#2e7d32}
.import-result.has-errors{background:var(--warn-bg);color:var(--warn-text)}

.lock-screen{display:flex;align-items:center;justify-content:center;min-height:80vh;padding:20px}
.lock-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:40px;max-width:380px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.lock-card h1{font-size:24px;color:var(--primary);margin-bottom:6px}
.lock-card .lock-sub{color:var(--muted);font-size:14px;margin-bottom:28px}
.lock-card input{width:100%;padding:10px 14px;font-size:15px;margin-bottom:12px;border:1.5px solid var(--border);border-radius:6px;text-align:center}
.lock-card input:focus{border-color:var(--primary);outline:none}
.lock-error{color:var(--danger);font-size:13px;margin-bottom:12px}
.lock-card .btn{width:100%;padding:10px;font-size:15px}
.change-pw-link{font-size:12px;color:var(--muted);cursor:pointer;margin-top:12px;display:inline-block}
.change-pw-link:hover{color:var(--primary)}
`;

// ═══════════════════════════════════════════
//  SHARED COMPONENTS
// ═══════════════════════════════════════════
const Modal = ({ children, onClose }) => (
  <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
    <div className="modal">{children}</div>
  </div>
);

const UnitSelect = ({ value, onChange, style, allowBlank }) => (
  <select value={value || ""} onChange={e => onChange(e.target.value)} style={{...style, color: value ? "var(--text)" : "#aaa"}}>
    {(allowBlank || !value) && <option value="" disabled hidden>Unit</option>}
    {ALL_UNITS.map(u => <option key={u} value={u} style={{color:"var(--text)"}}>{UNIT_LABELS[u]}</option>)}
  </select>
);

const ConfirmDialog = ({ message, onConfirm, onCancel }) => (
  <Modal onClose={onCancel}>
    <p style={{ marginBottom: 20, fontSize: 15 }}>{message}</p>
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <button className="btn btn-outline" onClick={onCancel}>Cancel</button>
      <button className="btn btn-danger" onClick={onConfirm}>Delete</button>
    </div>
  </Modal>
);

// Searchable select dropdown
const SearchSelect = ({ options, value, onChange, placeholder, style }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hlIdx, setHlIdx] = useState(0);
  const ref = useRef(null);

  const selected = options.find(o => o.value === value);
  const filtered = options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => { setHlIdx(0); }, [query]);

  const handleKey = e => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHlIdx(i => Math.min(i+1, filtered.length-1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHlIdx(i => Math.max(i-1, 0)); }
    else if (e.key === "Enter" && filtered[hlIdx]) { onChange(filtered[hlIdx].value); setOpen(false); setQuery(""); }
    else if (e.key === "Escape") { setOpen(false); setQuery(""); }
  };

  return (
    <div className="ss-wrap" ref={ref} style={style}>
      <input
        className="ss-input"
        placeholder={placeholder || "Search..."}
        value={open ? query : (selected ? selected.label : "")}
        onFocus={() => { setOpen(true); setQuery(""); }}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKey}
        readOnly={!open}
      />
      {open && (
        <div className="ss-dropdown">
          {filtered.length === 0 ? (
            <div className="ss-empty">No matches</div>
          ) : filtered.map((o, i) => (
            <div key={o.value}
              className={`ss-option ${i === hlIdx ? "highlighted" : ""}`}
              onMouseEnter={() => setHlIdx(i)}
              onMouseDown={e => { e.preventDefault(); onChange(o.value); setOpen(false); setQuery(""); }}>
              {o.label}
              {o.sub && <div className="ss-sub">{o.sub}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════
//  DRAG & DROP HOOK
// ═══════════════════════════════════════════
const useDragReorder = (items, setItems) => {
  const dragIdx = useRef(null);
  const overIdx = useRef(null);

  const onDragStart = (e, i) => {
    dragIdx.current = i;
    e.dataTransfer.effectAllowed = "move";
    e.currentTarget.classList.add("dragging");
  };
  const onDragEnd = (e) => {
    e.currentTarget.classList.remove("dragging");
    dragIdx.current = null;
  };
  const onDragOver = (e, i) => {
    e.preventDefault();
    overIdx.current = i;
  };
  const onDrop = (e) => {
    e.preventDefault();
    const from = dragIdx.current;
    const to = overIdx.current;
    if (from == null || to == null || from === to) return;
    const copy = [...items];
    const [moved] = copy.splice(from, 1);
    copy.splice(to, 0, moved);
    setItems(copy);
    dragIdx.current = null;
    overIdx.current = null;
  };

  return { onDragStart, onDragEnd, onDragOver, onDrop };
};

// ═══════════════════════════════════════════
//  INGREDIENTS TAB
// ═══════════════════════════════════════════
const IngredientModal = ({ ingredient, ingredients, onSave, onClose }) => {
  const [f, setF] = useState(ingredient || {
    name: "", purveyor: "", purchaseQuantity: "", purchaseUnit: "lb", purchasePrice: "", notes: ""
  });
  const [error, setError] = useState("");
  const set = (k,v) => { setF(p => ({...p, [k]: v})); setError(""); };
  const valid = f.name && f.purchaseQuantity > 0 && f.purchasePrice >= 0;

  const handleSave = () => {
    const dupe = ingredients.find(i => i.id !== f.id && i.name.toLowerCase().trim() === f.name.toLowerCase().trim());
    if (dupe) { setError(`An ingredient named "${dupe.name}" already exists.`); return; }
    onSave({ ...f, purchaseQuantity: parseFloat(f.purchaseQuantity), purchasePrice: parseFloat(f.purchasePrice), id: f.id || uid() });
  };

  return (
    <Modal onClose={onClose}>
      <h2>{ingredient ? "Edit Ingredient" : "Add Ingredient"}</h2>
      <div className="field"><label>Name</label><input value={f.name} onChange={e=>set("name",e.target.value)} placeholder="e.g. Olive Oil" autoFocus/></div>
      <div className="field"><label>Purveyor</label><input value={f.purveyor} onChange={e=>set("purveyor",e.target.value)} placeholder="e.g. Sysco"/></div>
      <div className="row">
        <div className="field"><label>Purchase Qty</label><input type="number" min="0" step="any" value={f.purchaseQuantity} onChange={e=>set("purchaseQuantity",e.target.value)}/></div>
        <div className="field"><label>Unit</label><UnitSelect value={f.purchaseUnit} onChange={v=>set("purchaseUnit",v)}/></div>
        <div className="field"><label>Price ($)</label><input type="number" min="0" step="any" value={f.purchasePrice} onChange={e=>set("purchasePrice",e.target.value)}/></div>
      </div>
      <div className="field"><label>Notes <span style={{fontWeight:400,color:"var(--muted)"}}>(optional)</span></label><input value={f.notes||""} onChange={e=>set("notes",e.target.value)} placeholder="e.g. Keep refrigerated, organic only, seasonal item..."/></div>
      {error && <div className="warn-box">{"\u26A0"} {error}</div>}
      <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:20}}>
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} style={{opacity:valid?1:.5}} onClick={handleSave}>
          {ingredient ? "Save Changes" : "Add Ingredient"}
        </button>
      </div>
    </Modal>
  );
};

const ImportModal = ({ ingredients, onImport, onClose }) => {
  const [result, setResult] = useState(null);
  const [applied, setApplied] = useState(false);

  const handleFile = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setApplied(false);
    const reader = new FileReader();
    reader.onload = ev => {
      const res = importCSV(ev.target.result, ingredients);
      setResult(res);
    };
    reader.readAsText(file);
  };

  const handleConfirm = () => {
    if (result?.data) {
      onImport(result.data);
      setApplied(true);
    }
  };

  const canApply = result && !result.error && result.data && (result.added > 0 || result.updated > 0);

  return (
    <Modal onClose={onClose}>
      <h2>Import Ingredients from CSV</h2>
      <p style={{fontSize:14,color:"var(--muted)",marginBottom:16}}>
        Upload a CSV with columns: <b>name</b>, <b>purveyor</b>, <b>purchaseQuantity</b>, <b>purchaseUnit</b>, <b>purchasePrice</b>, <b>notes</b>. Matching names will be updated; new names will be added.
      </p>
      <p style={{fontSize:13,color:"var(--muted)",marginBottom:16}}>
        Valid units: {ALL_UNITS.map(u => UNIT_LABELS[u]).join(", ")}
      </p>
      <input type="file" accept=".csv" onChange={handleFile} style={{marginBottom:16}}/>

      {result && !applied && (
        result.error ? (
          <div className="import-result has-errors">Error: {result.error}</div>
        ) : (
          <div>
            <div className={`import-result ${result.errors?.length ? "has-errors" : "success"}`}>
              <div style={{fontWeight:600,marginBottom:4}}>Preview — no changes applied yet</div>
              <div>Ready to add: {result.added} {"\u00B7"} Ready to update: {result.updated}{result.errors?.length > 0 ? ` \u00B7 Skipped: ${result.errors.length}` : ""}</div>
              {result.errors?.length > 0 && (
                <div style={{marginTop:8}}>
                  <b>The following rows have errors and will be skipped:</b>
                  {result.errors.map((e,i) => <div key={i}>{"\u2022"} {e}</div>)}
                </div>
              )}
            </div>
            {canApply && (
              <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:12}}>
                <button className="btn btn-outline" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={handleConfirm}>Confirm Import</button>
              </div>
            )}
          </div>
        )
      )}

      {applied && (
        <div className="import-result success">
          <div style={{fontWeight:600}}>Import complete!</div>
          <div>Added: {result.added} {"\u00B7"} Updated: {result.updated}</div>
        </div>
      )}

      <div style={{display:"flex",justifyContent:"flex-end",marginTop:16}}>
        {(!result || result.error || applied) && (
          <button className="btn btn-outline" onClick={onClose}>{applied ? "Done" : "Close"}</button>
        )}
      </div>
    </Modal>
  );
};

const IngredientsTab = ({ ingredients, setIngredients, recipes, dishes }) => {
  const [modal, setModal] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [search, setSearch] = useState("");
  const [showImport, setShowImport] = useState(false);

  const sorted = [...ingredients].sort((a,b) => a.name.localeCompare(b.name));
  const filtered = sorted.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase()) ||
    i.purveyor?.toLowerCase().includes(search.toLowerCase())
  );

  const handleSave = ing => {
    setIngredients(prev => {
      const idx = prev.findIndex(i => i.id === ing.id);
      return idx >= 0 ? prev.map((p,i) => i===idx ? ing : p) : [...prev, ing];
    });
    setModal(null);
  };

  const handleDelete = id => {
    const usedR = recipes.some(r => r.items.some(i => i.ingredientId === id));
    const usedD = dishes.some(d => d.items.some(i => i.type === "ingredient" && i.refId === id));
    if (usedR || usedD) { alert("This ingredient is used in a recipe or dish. Remove it there first."); setConfirm(null); return; }
    setIngredients(prev => prev.filter(i => i.id !== id));
    setConfirm(null);
  };

  return (
    <div>
      <div className="toolbar">
        <h2 style={{fontSize:20,color:"var(--primary)",marginRight:8}}>Ingredients</h2>
        <div className="toolbar-right">
          <button className="btn btn-outline btn-sm" onClick={() => exportCSV(ingredients)}>Export CSV</button>
          <button className="btn btn-outline btn-sm" onClick={() => setShowImport(true)}>Import CSV</button>
          <button className="btn btn-primary" onClick={()=>setModal("add")}>+ Add Ingredient</button>
        </div>
      </div>
      {ingredients.length > 0 && (
        <input className="search-bar" placeholder="Search ingredients by name or purveyor..." value={search} onChange={e => setSearch(e.target.value)} style={{marginBottom:16}}/>
      )}
      {ingredients.length === 0 ? (
        <div className="card empty">No ingredients yet. Add your first ingredient or import a CSV to get started.</div>
      ) : filtered.length === 0 ? (
        <div className="card empty">No ingredients match "{search}"</div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Purveyor</th><th>Purchase Qty</th><th>Unit</th><th>Price</th><th>Cost / Unit</th><th>Notes</th><th style={{width:100}}></th></tr></thead>
            <tbody>
              {filtered.map(ing => (
                <tr key={ing.id}>
                  <td style={{fontWeight:600}}>{ing.name}</td>
                  <td>{ing.purveyor || "\u2014"}</td>
                  <td>{fmtQty(ing.purchaseQuantity)}</td>
                  <td>{UNIT_LABELS[ing.purchaseUnit]}</td>
                  <td>{fmt(ing.purchasePrice)}</td>
                  <td style={{color:"var(--accent)",fontWeight:600}}>{fmt(ing.purchasePrice / ing.purchaseQuantity)}/{UNIT_LABELS[ing.purchaseUnit]}</td>
                  <td style={{fontSize:12,color:"var(--muted)",maxWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={ing.notes}>{ing.notes || "\u2014"}</td>
                  <td>
                    <div style={{display:"flex",gap:4}}>
                      <button className="btn btn-outline btn-sm" onClick={()=>setModal(ing)}>Edit</button>
                      <button className="btn btn-danger btn-sm" onClick={()=>setConfirm(ing.id)}>{"\u00D7"}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal && <IngredientModal ingredient={modal === "add" ? null : modal} ingredients={ingredients} onSave={handleSave} onClose={()=>setModal(null)}/>}
      {confirm && <ConfirmDialog message="Delete this ingredient?" onConfirm={()=>handleDelete(confirm)} onCancel={()=>setConfirm(null)}/>}
      {showImport && <ImportModal ingredients={ingredients} onImport={setIngredients} onClose={()=>setShowImport(false)}/>}
    </div>
  );
};

// ═══════════════════════════════════════════
//  RECIPE FORM MODAL
// ═══════════════════════════════════════════
const RecipeFormModal = ({ recipe, ingredients, onSave, onClose }) => {
  const [name, setName] = useState(recipe?.name || "");
  const [yieldQty, setYieldQty] = useState(recipe?.yieldQuantity || "");
  const [yieldUnit, setYieldUnit] = useState(recipe?.yieldUnit || "");
  const [yieldQtyB, setYieldQtyB] = useState(recipe?.yieldQuantityB || "");
  const [yieldUnitB, setYieldUnitB] = useState(recipe?.yieldUnitB || "");
  const [instructions, setInstructions] = useState(recipe?.instructions || "");
  const [items, setItems] = useState(() => (recipe?.items || []).map(it => ({...it, _key: uid()})));

  const addItem = () => setItems(p => [...p, { ingredientId: "", quantity: "", unit: "", note: "", _key: uid() }]);
  const removeItem = i => setItems(p => p.filter((_,idx) => idx !== i));
  const updateItem = (i, k, v) => setItems(p => p.map((item, idx) => idx === i ? {...item, [k]: v} : item));

  const drag = useDragReorder(items, setItems);
  const valid = name && yieldQty > 0 && yieldUnit && items.length > 0 && items.every(it => it.ingredientId && it.quantity > 0);

  // Warn if both yields are the same unit type
  const yieldTypeConflict = yieldUnit && yieldUnitB && unitType(yieldUnit) === unitType(yieldUnitB);

  const ingOptions = [...ingredients].sort((a,b)=>a.name.localeCompare(b.name)).map(x => ({
    value: x.id, label: x.name, sub: `${UNIT_LABELS[x.purchaseUnit]} \u00B7 ${x.purveyor || "no purveyor"}`
  }));

  return (
    <Modal onClose={onClose}>
      <h2>{recipe ? "Edit Recipe" : "New Recipe"}</h2>
      <div className="field"><label>Recipe Name</label><input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Lemon Vinaigrette" autoFocus/></div>
      <div style={{marginBottom:4}}><label style={{fontWeight:600,fontSize:13}}>Yield A</label></div>
      <div className="row">
        <div className="field"><input type="number" min="0" step="any" placeholder="Qty" value={yieldQty} onChange={e=>setYieldQty(e.target.value)}/></div>
        <div className="field"><UnitSelect value={yieldUnit} onChange={setYieldUnit} allowBlank/></div>
      </div>
      <div style={{marginBottom:4}}><label style={{fontWeight:600,fontSize:13}}>Yield B <span style={{fontWeight:400,color:"var(--muted)"}}>(optional — use for a second unit type, e.g. weight + volume)</span></label></div>
      <div className="row" style={{marginBottom:16}}>
        <div className="field"><input type="number" min="0" step="any" placeholder="Qty" value={yieldQtyB} onChange={e=>setYieldQtyB(e.target.value)}/></div>
        <div className="field"><UnitSelect value={yieldUnitB} onChange={setYieldUnitB} allowBlank/></div>
      </div>
      {yieldTypeConflict && <div className="warn-box">{"\u26A0"} Both yields are {unitType(yieldUnit)} units. Yield B is most useful when it covers a different unit type (e.g. volume + weight).</div>}

      <div style={{marginTop:8,marginBottom:8}}>
        <label style={{fontWeight:600,fontSize:13}}>Ingredients</label>
      </div>
      {items.map((it, i) => {
        const ing = ingredients.find(x => x.id === it.ingredientId);
        const warn = ing && it.unit && !compatible(it.unit, ing.purchaseUnit);
        return (
          <div key={it._key}
            draggable onDragStart={e=>drag.onDragStart(e,i)} onDragEnd={drag.onDragEnd}
            onDragOver={e=>drag.onDragOver(e,i)} onDrop={drag.onDrop}>
            <div className="item-row">
              <span className="drag-handle" title="Drag to reorder">{"\u2807"}</span>
              <SearchSelect options={ingOptions} value={it.ingredientId} onChange={v => updateItem(i, "ingredientId", v)} placeholder="Search ingredient..." style={{flex:1}}/>
              <input type="number" min="0" step="any" placeholder="Qty" value={it.quantity} onChange={e => updateItem(i, "quantity", e.target.value)}/>
              <UnitSelect value={it.unit} onChange={v => updateItem(i, "unit", v)} allowBlank style={{width:90}}/>
              <input className="item-note-input" placeholder="Note" title="e.g. finely diced, ice cold" value={it.note||""} onChange={e=>updateItem(i,"note",e.target.value)}/>
              <button className="remove-btn" onClick={()=>removeItem(i)}>{"\u00D7"}</button>
            </div>
            {warn && <div className="warn-box" style={{marginLeft:32}}>{"\u26A0"} Unit mismatch: <b>{UNIT_LABELS[it.unit]}</b> ({unitType(it.unit)}) vs <b>{UNIT_LABELS[ing.purchaseUnit]}</b> ({unitType(ing.purchaseUnit)}). Cost cannot be calculated.</div>}
          </div>
        );
      })}
      <button className="btn btn-outline btn-sm" onClick={addItem} style={{marginTop:4,marginBottom:16}}>+ Add Ingredient</button>

      <div className="field"><label>Instructions</label><textarea rows={5} value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="Step-by-step preparation instructions..."/></div>

      <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:12}}>
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} style={{opacity:valid?1:.5}} onClick={()=>{
          onSave({
            id: recipe?.id || uid(), name, yieldQuantity: parseFloat(yieldQty), yieldUnit,
            yieldQuantityB: yieldQtyB ? parseFloat(yieldQtyB) : null, yieldUnitB: yieldUnitB || null,
            instructions,
            items: items.map(it => ({ ingredientId: it.ingredientId, quantity: parseFloat(it.quantity), unit: it.unit, note: it.note || "" }))
          });
        }}>{recipe ? "Save Changes" : "Create Recipe"}</button>
      </div>
    </Modal>
  );
};

// ═══════════════════════════════════════════
//  RECIPE DETAIL
// ═══════════════════════════════════════════
const RecipeDetail = ({ recipe, ingredients, onEdit, onDelete }) => {
  const [scale, setScale] = useState(1);
  const [customScale, setCustomScale] = useState("");
  const { cost, hasWarning } = recipeTotalCost(recipe, ingredients);
  const scalePresets = [0.5, 1, 2, 3, 5];

  const handlePreset = s => { setScale(s); setCustomScale(""); };
  const handleCustom = e => {
    const val = e.target.value;
    setCustomScale(val);
    const num = parseFloat(val);
    if (num > 0) setScale(num);
  };

  const itemDetails = recipe.items.map(it => {
    const ing = ingredients.find(x => x.id === it.ingredientId);
    const c = ing && it.unit ? ingredientUnitCost(ing, it.quantity, it.unit) : null;
    return { name: ing?.name || "Unknown", quantity: it.quantity, unit: it.unit, cost: c, note: it.note };
  });

  const handlePrint = () => {
    const yields = [{ quantity: recipe.yieldQuantity, unit: recipe.yieldUnit }];
    if (recipe.yieldQuantityB && recipe.yieldUnitB) {
      yields.push({ quantity: recipe.yieldQuantityB, unit: recipe.yieldUnitB });
    }
    const cs = parseFloat(customScale);
    downloadPDF(recipe.name, "", itemDetails, recipe.instructions, yields, cs > 0 ? cs : null);
  };

  return (
    <div>
      <div className="detail-header">
        <div>
          <h2 className="detail-title">{recipe.name}</h2>
          <div className="detail-meta">Yield: {fmtQty(recipe.yieldQuantity * scale)} {UNIT_LABELS[recipe.yieldUnit]}{recipe.yieldQuantityB && recipe.yieldUnitB ? ` / ${fmtQty(recipe.yieldQuantityB * scale)} ${UNIT_LABELS[recipe.yieldUnitB]}` : ""}</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <span className="cost-badge">{fmt(cost * scale)}</span>
          <button className="btn btn-outline btn-sm" onClick={onEdit}>Edit</button>
          <button className="btn btn-accent btn-sm" onClick={handlePrint}>Print PDF</button>
          <button className="btn btn-danger btn-sm" onClick={onDelete}>Delete</button>
        </div>
      </div>
      {hasWarning && <div className="warn-box">{"\u26A0"} Some ingredient costs could not be calculated due to missing or incompatible units.</div>}
      <div className="scale-bar">
        <span style={{fontSize:13,fontWeight:600,color:"var(--muted)"}}>Scale:</span>
        {scalePresets.map(s => (
          <button key={s} className={`scale-btn ${scale===s && !customScale?"active":""}`} onClick={()=>handlePreset(s)}>{s}{"\u00D7"}</button>
        ))}
        <input type="number" min="1" step="1" placeholder="Custom" value={customScale} onChange={handleCustom} style={{width:74,textAlign:"center"}}/>
      </div>
      <div className="card" style={{padding:0,overflow:"hidden"}}>
        <table>
          <thead><tr><th>Ingredient</th><th style={{textAlign:"right"}}>Quantity</th><th style={{textAlign:"right"}}>Cost</th></tr></thead>
          <tbody>
            {itemDetails.map((it, i) => (
              <tr key={i}>
                <td>
                  <span style={{fontWeight:500}}>{it.name}</span>
                  {it.note && <div style={{fontSize:12,color:"var(--muted)",fontStyle:"italic"}}>{it.note}</div>}
                </td>
                <td style={{textAlign:"right"}}>{it.unit ? `${fmtQty(it.quantity * scale)} ${UNIT_LABELS[it.unit]}` : "\u2014"}</td>
                <td style={{textAlign:"right",color:it.cost!=null?"var(--accent)":"var(--danger)",fontWeight:600}}>{it.cost != null ? fmt(it.cost * scale) : "\u26A0"}</td>
              </tr>
            ))}
            <tr style={{background:"#FDFCFA"}}><td colSpan={2} style={{fontWeight:700}}>Total</td><td style={{textAlign:"right",fontWeight:700,color:"var(--accent)"}}>{fmt(cost * scale)}</td></tr>
          </tbody>
        </table>
      </div>
      {recipe.instructions && <div className="instructions-block"><h3>Instructions</h3>{recipe.instructions}</div>}
    </div>
  );
};

// ═══════════════════════════════════════════
//  RECIPES TAB
// ═══════════════════════════════════════════
const RecipesTab = ({ recipes, setRecipes, ingredients, dishes }) => {
  const [modal, setModal] = useState(null);
  const [selected, setSelected] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [search, setSearch] = useState("");

  const sel = recipes.find(r => r.id === selected);
  const sorted = [...recipes].sort((a,b) => a.name.localeCompare(b.name));
  const filtered = sorted.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));

  const handleSave = rec => {
    setRecipes(prev => {
      const idx = prev.findIndex(r => r.id === rec.id);
      return idx >= 0 ? prev.map((p,i) => i===idx ? rec : p) : [...prev, rec];
    });
    setSelected(rec.id);
    setModal(null);
  };

  const handleDelete = () => {
    const used = dishes.some(d => d.items.some(i => i.type === "recipe" && i.refId === selected));
    if (used) { alert("This recipe is used in a dish. Remove it there first."); setConfirm(false); return; }
    setRecipes(prev => prev.filter(r => r.id !== selected));
    setSelected(null);
    setConfirm(false);
  };

  return (
    <div>
      <div className="toolbar">
        <h2 style={{fontSize:20,color:"var(--primary)"}}>Recipes</h2>
        <div className="toolbar-right">
          <button className="btn btn-primary" onClick={()=>setModal("add")}>+ New Recipe</button>
        </div>
      </div>
      {recipes.length === 0 && !modal ? (
        <div className="card empty">No recipes yet. Add ingredients first, then create your first recipe.</div>
      ) : (
        <div className="list-sidebar">
          <div className="list-panel">
            {recipes.length > 0 && <input className="search-bar" placeholder="Search recipes..." value={search} onChange={e => setSearch(e.target.value)} style={{marginBottom:12,fontSize:13,padding:"7px 12px 7px 32px"}}/>}
            {filtered.map(r => {
              const { cost } = recipeTotalCost(r, ingredients);
              return (
                <div key={r.id} className={`list-item ${selected===r.id?"active":""}`} onClick={()=>setSelected(r.id)}>
                  <div>{r.name}</div>
                  <div className="li-cost">{fmt(cost)} {"\u00B7"} {fmtQty(r.yieldQuantity)} {UNIT_LABELS[r.yieldUnit]}{r.yieldQuantityB && r.yieldUnitB ? ` / ${fmtQty(r.yieldQuantityB)} ${UNIT_LABELS[r.yieldUnitB]}` : ""}</div>
                </div>
              );
            })}
            {filtered.length === 0 && search && <div style={{padding:12,fontSize:13,color:"var(--muted)",textAlign:"center"}}>No matches</div>}
          </div>
          <div>
            {sel ? <RecipeDetail recipe={sel} ingredients={ingredients} onEdit={()=>setModal(sel)} onDelete={()=>setConfirm(true)}/> : <div className="card empty">Select a recipe to view details</div>}
          </div>
        </div>
      )}
      {modal && <RecipeFormModal recipe={modal==="add"?null:modal} ingredients={ingredients} onSave={handleSave} onClose={()=>setModal(null)}/>}
      {confirm && <ConfirmDialog message={`Delete "${sel?.name}"?`} onConfirm={handleDelete} onCancel={()=>setConfirm(false)}/>}
    </div>
  );
};

// ═══════════════════════════════════════════
//  DISH FORM MODAL
// ═══════════════════════════════════════════
const DishFormModal = ({ dish, ingredients, recipes, onSave, onClose }) => {
  const [name, setName] = useState(dish?.name || "");
  const [menuPrice, setMenuPrice] = useState(dish?.menuPrice ?? "");
  const [instructions, setInstructions] = useState(dish?.instructions || "");
  const [items, setItems] = useState(() => (dish?.items || []).map(it => ({...it, _key: uid()})));

  const addItem = (type) => setItems(p => [...p, { type, refId: "", quantity: "", unit: "", note: "", _key: uid() }]);
  const removeItem = i => setItems(p => p.filter((_,idx) => idx !== i));
  const updateItem = (i, k, v) => setItems(p => p.map((item, idx) => idx === i ? {...item, [k]: v} : item));

  const drag = useDragReorder(items, setItems);
  const valid = name && items.length > 0 && items.every(it => it.refId && it.quantity > 0);

  const ingOptions = [...ingredients].sort((a,b)=>a.name.localeCompare(b.name)).map(x => ({
    value: x.id, label: x.name, sub: `Ingredient \u00B7 ${UNIT_LABELS[x.purchaseUnit]}`
  }));
  const recOptions = [...recipes].sort((a,b)=>a.name.localeCompare(b.name)).map(x => ({
    value: x.id, label: x.name, sub: `Recipe \u00B7 ${fmtQty(x.yieldQuantity)} ${UNIT_LABELS[x.yieldUnit]}${x.yieldQuantityB && x.yieldUnitB ? ` / ${fmtQty(x.yieldQuantityB)} ${UNIT_LABELS[x.yieldUnitB]}` : ""}`
  }));

  return (
    <Modal onClose={onClose}>
      <h2>{dish ? "Edit Dish" : "New Dish"}</h2>
      <div className="field"><label>Dish Name</label><input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Caesar Salad" autoFocus/></div>
      <div className="field"><label>Menu Price ($)</label><input type="number" min="0" step="any" value={menuPrice} onChange={e=>setMenuPrice(e.target.value)} placeholder="What the customer pays"/></div>

      <div style={{marginTop:8,marginBottom:8}}>
        <label style={{fontWeight:600,fontSize:13}}>Components</label>
      </div>
      {items.map((it, i) => {
        const isRec = it.type === "recipe";
        const ref = isRec ? recipes.find(r => r.id === it.refId) : ingredients.find(x => x.id === it.refId);
        const warn = ref && it.unit && (isRec ? !resolveRecipeYield(ref, it.unit) : !compatible(it.unit, ref.purchaseUnit));
        return (
          <div key={it._key}
            draggable onDragStart={e=>drag.onDragStart(e,i)} onDragEnd={drag.onDragEnd}
            onDragOver={e=>drag.onDragOver(e,i)} onDrop={drag.onDrop}>
            <div className="item-row">
              <span className="drag-handle" title="Drag to reorder">{"\u2807"}</span>
              <SearchSelect
                options={isRec ? recOptions : ingOptions}
                value={it.refId}
                onChange={v => updateItem(i, "refId", v)}
                placeholder={`Search ${isRec ? "recipe" : "ingredient"}...`}
                style={{flex:1}}
              />
              <input type="number" min="0" step="any" placeholder="Qty" value={it.quantity} onChange={e => updateItem(i, "quantity", e.target.value)}/>
              <UnitSelect value={it.unit} onChange={v => updateItem(i, "unit", v)} allowBlank style={{width:90}}/>
              <input className="item-note-input" placeholder="Note" title="e.g. shaved thin, warmed" value={it.note||""} onChange={e=>updateItem(i,"note",e.target.value)}/>
              <button className="remove-btn" onClick={()=>removeItem(i)}>{"\u00D7"}</button>
            </div>
            {warn && <div className="warn-box" style={{marginLeft:32}}>{"\u26A0"} Unit mismatch: <b>{UNIT_LABELS[it.unit]}</b> ({unitType(it.unit)}) does not match {isRec ? "any yield unit" : `purchase unit <b>${UNIT_LABELS[ref.purchaseUnit]}</b> (${unitType(ref.purchaseUnit)})`}. Cost cannot be calculated.</div>}
          </div>
        );
      })}
      <div style={{display:"flex",gap:8,marginTop:4,marginBottom:16}}>
        <button className="btn btn-outline btn-sm" onClick={()=>addItem("ingredient")}>+ Ingredient</button>
        <button className="btn btn-outline btn-sm" style={{borderColor:"var(--accent)",color:"var(--accent)"}} onClick={()=>addItem("recipe")}>+ Recipe</button>
      </div>

      <div className="field"><label>Instructions</label><textarea rows={5} value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="Plating and preparation instructions..."/></div>

      <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:12}}>
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} style={{opacity:valid?1:.5}} onClick={()=>{
          onSave({
            id: dish?.id || uid(), name, menuPrice: menuPrice ? parseFloat(menuPrice) : 0, instructions,
            items: items.map(it => ({ type: it.type, refId: it.refId, quantity: parseFloat(it.quantity), unit: it.unit, note: it.note || "" }))
          });
        }}>{dish ? "Save Changes" : "Create Dish"}</button>
      </div>
    </Modal>
  );
};

// ═══════════════════════════════════════════
//  DISH DETAIL
// ═══════════════════════════════════════════
const DishDetail = ({ dish, ingredients, recipes, onEdit, onDelete }) => {
  const { cost, hasWarning } = dishTotalCost(dish, ingredients, recipes);
  const margin = dish.menuPrice > 0 ? ((dish.menuPrice - cost) / dish.menuPrice * 100) : 0;

  const itemDetails = dish.items.map(it => {
    if (it.type === "ingredient") {
      const ing = ingredients.find(x => x.id === it.refId);
      const c = ing && it.unit ? ingredientUnitCost(ing, it.quantity, it.unit) : null;
      return { name: ing?.name || "Unknown", quantity: it.quantity, unit: it.unit, cost: c, isRecipe: false, note: it.note };
    } else {
      const rec = recipes.find(r => r.id === it.refId);
      if (!rec || !it.unit) return { name: rec?.name || "Unknown", quantity: it.quantity, unit: it.unit, cost: null, isRecipe: true, note: it.note };
      const rc = recipeTotalCost(rec, ingredients);
      const yld = resolveRecipeYield(rec, it.unit);
      if (!yld) return { name: rec.name, quantity: it.quantity, unit: it.unit, cost: null, isRecipe: true, note: it.note };
      const inYield = convert(it.quantity, it.unit, yld.unit);
      const c = (inYield / yld.quantity) * rc.cost;
      return { name: rec.name, quantity: it.quantity, unit: it.unit, cost: c, isRecipe: true, note: it.note };
    }
  });

  const handlePrint = () => {
    downloadPDF(dish.name, "", itemDetails, dish.instructions);
  };

  return (
    <div>
      <div className="detail-header">
        <div>
          <h2 className="detail-title">{dish.name}</h2>
          <div className="detail-meta" style={{display:"flex",gap:12,alignItems:"center",marginTop:6,flexWrap:"wrap"}}>
            <span>Cost: <b style={{color:"var(--accent)"}}>{fmt(cost)}</b></span>
            {dish.menuPrice > 0 && <>
              <span>Price: <b>{fmt(dish.menuPrice)}</b></span>
              <span className="margin-badge" style={{background: margin >= 60 ? "#e8f5e9" : margin >= 30 ? "#FFF3CD" : "#FDEDEB", color: margin >= 60 ? "#2e7d32" : margin >= 30 ? "#856404" : "var(--danger)"}}>
                {margin.toFixed(1)}% margin
              </span>
            </>}
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <button className="btn btn-outline btn-sm" onClick={onEdit}>Edit</button>
          <button className="btn btn-accent btn-sm" onClick={handlePrint}>Print PDF</button>
          <button className="btn btn-danger btn-sm" onClick={onDelete}>Delete</button>
        </div>
      </div>
      {hasWarning && <div className="warn-box">{"\u26A0"} Some costs could not be calculated due to missing or incompatible units.</div>}
      <div className="card" style={{padding:0,overflow:"hidden"}}>
        <table>
          <thead><tr><th>Component</th><th>Type</th><th style={{textAlign:"right"}}>Quantity</th><th style={{textAlign:"right"}}>Cost</th></tr></thead>
          <tbody>
            {itemDetails.map((it, i) => (
              <tr key={i}>
                <td>
                  <span style={{fontWeight:500}}>{it.name}</span>
                  {it.note && <div style={{fontSize:12,color:"var(--muted)",fontStyle:"italic"}}>{it.note}</div>}
                </td>
                <td><span style={{fontSize:11,fontWeight:700,color:it.isRecipe?"var(--accent)":"var(--primary)",textTransform:"uppercase"}}>{it.isRecipe?"Recipe":"Ingredient"}</span></td>
                <td style={{textAlign:"right"}}>{it.unit ? `${fmtQty(it.quantity)} ${UNIT_LABELS[it.unit]}` : "\u2014"}</td>
                <td style={{textAlign:"right",color:it.cost!=null?"var(--accent)":"var(--danger)",fontWeight:600}}>{it.cost != null ? fmt(it.cost) : "\u26A0"}</td>
              </tr>
            ))}
            <tr style={{background:"#FDFCFA"}}><td colSpan={3} style={{fontWeight:700}}>Total Cost</td><td style={{textAlign:"right",fontWeight:700,color:"var(--accent)"}}>{fmt(cost)}</td></tr>
          </tbody>
        </table>
      </div>
      {dish.instructions && <div className="instructions-block"><h3>Instructions</h3>{dish.instructions}</div>}
    </div>
  );
};

// ═══════════════════════════════════════════
//  DISHES TAB
// ═══════════════════════════════════════════
const DishesTab = ({ dishes, setDishes, ingredients, recipes }) => {
  const [modal, setModal] = useState(null);
  const [selected, setSelected] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [search, setSearch] = useState("");

  const sel = dishes.find(d => d.id === selected);
  const sorted = [...dishes].sort((a,b) => a.name.localeCompare(b.name));
  const filtered = sorted.filter(d => d.name.toLowerCase().includes(search.toLowerCase()));

  const handleSave = d => {
    setDishes(prev => {
      const idx = prev.findIndex(x => x.id === d.id);
      return idx >= 0 ? prev.map((p,i) => i===idx ? d : p) : [...prev, d];
    });
    setSelected(d.id);
    setModal(null);
  };

  const handleDelete = () => {
    setDishes(prev => prev.filter(d => d.id !== selected));
    setSelected(null);
    setConfirm(false);
  };

  return (
    <div>
      <div className="toolbar">
        <h2 style={{fontSize:20,color:"var(--primary)"}}>Dishes</h2>
        <div className="toolbar-right">
          <button className="btn btn-primary" onClick={()=>setModal("add")}>+ New Dish</button>
        </div>
      </div>
      {dishes.length === 0 && !modal ? (
        <div className="card empty">No dishes yet. Create ingredients and recipes first, then build your menu items.</div>
      ) : (
        <div className="list-sidebar">
          <div className="list-panel">
            {dishes.length > 0 && <input className="search-bar" placeholder="Search dishes..." value={search} onChange={e => setSearch(e.target.value)} style={{marginBottom:12,fontSize:13,padding:"7px 12px 7px 32px"}}/>}
            {filtered.map(d => {
              const { cost } = dishTotalCost(d, ingredients, recipes);
              const m = d.menuPrice > 0 ? ((d.menuPrice - cost) / d.menuPrice * 100) : null;
              return (
                <div key={d.id} className={`list-item ${selected===d.id?"active":""}`} onClick={()=>setSelected(d.id)}>
                  <div>{d.name}</div>
                  <div className="li-cost">{fmt(cost)} cost{m != null ? ` \u00B7 ${m.toFixed(0)}% margin` : ""}</div>
                </div>
              );
            })}
            {filtered.length === 0 && search && <div style={{padding:12,fontSize:13,color:"var(--muted)",textAlign:"center"}}>No matches</div>}
          </div>
          <div>
            {sel ? <DishDetail dish={sel} ingredients={ingredients} recipes={recipes} onEdit={()=>setModal(sel)} onDelete={()=>setConfirm(true)}/> : <div className="card empty">Select a dish to view details</div>}
          </div>
        </div>
      )}
      {modal && <DishFormModal dish={modal==="add"?null:modal} ingredients={ingredients} recipes={recipes} onSave={handleSave} onClose={()=>setModal(null)}/>}
      {confirm && <ConfirmDialog message={`Delete "${sel?.name}"?`} onConfirm={handleDelete} onCancel={()=>setConfirm(false)}/>}
    </div>
  );
};

// ═══════════════════════════════════════════
//  PASSWORD GATE
// ═══════════════════════════════════════════
const hashPassword = async (pw) => {
  const data = new TextEncoder().encode(pw);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
};

const LockScreen = ({ onUnlock }) => {
  const [storedHash, setStoredHash] = useState(undefined); // undefined = loading, null = no pw set
  const [input, setInput] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [isSetup, setIsSetup] = useState(false);

  useEffect(() => {
    loadPassword().then(h => setStoredHash(h ?? null));
  }, []);

  if (storedHash === undefined) return <div className="app"><style>{CSS}</style><div className="loading">Loading...</div></div>;

  const handleSetPassword = async () => {
    if (input.length < 4) { setError("Password must be at least 4 characters."); return; }
    if (input !== confirm) { setError("Passwords don't match."); return; }
    const h = await hashPassword(input);
    await savePassword(h);
    onUnlock();
  };

  const handleLogin = async () => {
    const h = await hashPassword(input);
    if (h === storedHash) { onUnlock(); }
    else { setError("Incorrect password."); setInput(""); }
  };

  const handleKey = e => { if (e.key === "Enter") storedHash === null || isSetup ? handleSetPassword() : handleLogin(); };

  // First time — set password
  if (storedHash === null || isSetup) {
    return (
      <div className="app">
        <style>{CSS}</style>
        <div className="lock-screen">
          <div className="lock-card">
            <h1>Norte54 Recipe Builder</h1>
            <div className="lock-sub">{isSetup ? "Set a new password" : "Welcome! Set a shared password for your team."}</div>
            <input type="password" placeholder="Choose a password" value={input} onChange={e => { setInput(e.target.value); setError(""); }} onKeyDown={handleKey} autoFocus/>
            <input type="password" placeholder="Confirm password" value={confirm} onChange={e => { setConfirm(e.target.value); setError(""); }} onKeyDown={handleKey}/>
            {error && <div className="lock-error">{error}</div>}
            <button className="btn btn-primary" onClick={handleSetPassword}>Set Password</button>
          </div>
        </div>
      </div>
    );
  }

  // Normal login
  return (
    <div className="app">
      <style>{CSS}</style>
      <div className="lock-screen">
        <div className="lock-card">
          <h1>Norte54 Recipe Builder</h1>
          <div className="lock-sub">Enter the team password to continue</div>
          <input type="password" placeholder="Password" value={input} onChange={e => { setInput(e.target.value); setError(""); }} onKeyDown={handleKey} autoFocus/>
          {error && <div className="lock-error">{error}</div>}
          <button className="btn btn-primary" onClick={handleLogin}>Enter</button>
        </div>
      </div>
    </div>
  );
};

const ChangePasswordModal = ({ onClose }) => {
  const [current, setCurrent] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const handleSave = async () => {
    const currentHash = await hashPassword(current);
    const storedHash = await loadPassword();
    if (currentHash !== storedHash) { setError("Current password is incorrect."); return; }
    if (newPw.length < 4) { setError("New password must be at least 4 characters."); return; }
    if (newPw !== confirmPw) { setError("New passwords don't match."); return; }
    const h = await hashPassword(newPw);
    await savePassword(h);
    setDone(true);
  };

  if (done) return (
    <Modal onClose={onClose}>
      <h2>Password Changed</h2>
      <p style={{marginBottom:20,fontSize:14}}>Your team password has been updated. Share the new password with your chefs.</p>
      <div style={{display:"flex",justifyContent:"flex-end"}}><button className="btn btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );

  return (
    <Modal onClose={onClose}>
      <h2>Change Password</h2>
      <div className="field"><label>Current Password</label><input type="password" value={current} onChange={e => { setCurrent(e.target.value); setError(""); }} autoFocus/></div>
      <div className="field"><label>New Password</label><input type="password" value={newPw} onChange={e => { setNewPw(e.target.value); setError(""); }}/></div>
      <div className="field"><label>Confirm New Password</label><input type="password" value={confirmPw} onChange={e => { setConfirmPw(e.target.value); setError(""); }}/></div>
      {error && <div className="warn-box">{"\u26A0"} {error}</div>}
      <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:12}}>
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSave}>Update Password</button>
      </div>
    </Modal>
  );
};

// ═══════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════
export default function App() {
  const [unlocked, setUnlocked] = useState(false);
  const [tab, setTab] = useState("ingredients");
  const [loading, setLoading] = useState(true);
  const [ingredients, setIngredients] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [dishes, setDishes] = useState([]);
  const [showChangePw, setShowChangePw] = useState(false);
  const saveTimer = useRef(null);
  const skipNextSync = useRef(false);

  // Initial load + real-time sync from Firebase
  useEffect(() => {
    if (!unlocked) return;
    loadData().then(d => {
      setIngredients(d.ingredients || []);
      setRecipes(d.recipes || []);
      setDishes(d.dishes || []);
      setLoading(false);
    });

    // Listen for changes from other devices
    const unsub = subscribeToData(d => {
      if (skipNextSync.current) {
        skipNextSync.current = false;
        return;
      }
      setIngredients(d.ingredients || []);
      setRecipes(d.recipes || []);
      setDishes(d.dishes || []);
    });

    return () => unsub();
  }, [unlocked]);

  // Auto-save on local changes (debounced)
  useEffect(() => {
    if (loading || !unlocked) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      skipNextSync.current = true;
      saveData({ ingredients, recipes, dishes });
    }, 500);
  }, [ingredients, recipes, dishes, loading, unlocked]);

  if (!unlocked) return <LockScreen onUnlock={() => setUnlocked(true)} />;

  if (loading) return <div className="app"><style>{CSS}</style><div className="loading">Loading kitchen data...</div></div>;

  return (
    <div className="app">
      <style>{CSS}</style>
      <div className="header">
        <h1>Norte54 Recipe Builder</h1>
        <span className="change-pw-link" onClick={() => setShowChangePw(true)}>Change password</span>
      </div>
      <div className="tabs">
        {[["ingredients","Ingredients"],["recipes","Recipes"],["dishes","Dishes"]].map(([k,l]) => (
          <button key={k} className={`tab ${tab===k?"active":""}`} onClick={()=>setTab(k)}>{l}
            {k==="ingredients" && ingredients.length > 0 && <span style={{marginLeft:6,fontSize:12,opacity:.6}}>({ingredients.length})</span>}
            {k==="recipes" && recipes.length > 0 && <span style={{marginLeft:6,fontSize:12,opacity:.6}}>({recipes.length})</span>}
            {k==="dishes" && dishes.length > 0 && <span style={{marginLeft:6,fontSize:12,opacity:.6}}>({dishes.length})</span>}
          </button>
        ))}
      </div>
      {tab === "ingredients" && <IngredientsTab ingredients={ingredients} setIngredients={setIngredients} recipes={recipes} dishes={dishes}/>}
      {tab === "recipes" && <RecipesTab recipes={recipes} setRecipes={setRecipes} ingredients={ingredients} dishes={dishes}/>}
      {tab === "dishes" && <DishesTab dishes={dishes} setDishes={setDishes} ingredients={ingredients} recipes={recipes}/>}
      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)}/>}
    </div>
  );
}
