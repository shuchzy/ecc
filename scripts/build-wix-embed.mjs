import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "wix");
const outputPath = path.join(outputDir, "hardware-cms-wix-embed.html");
const logoPath = path.join(root, "public", "easx-logo.png");
const apiUrl = process.env.CATALOG_URL || "http://localhost:4177/api/hardware/catalog";

async function main() {
  const catalogResponse = await fetch(apiUrl);
  if (!catalogResponse.ok) {
    throw new Error(`Catalog fetch failed: ${catalogResponse.status} ${catalogResponse.statusText}`);
  }
  const catalog = await catalogResponse.json();
  const logoBase64 = await fs.readFile(logoPath, "base64");

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, buildHtml(catalog, logoBase64), "utf8");
  console.log(outputPath);
}

function buildHtml(catalog, logoBase64) {
  const catalogJson = JSON.stringify(catalog).replace(/</g, "\\u003c");
  const logoDataUrl = `data:image/png;base64,${logoBase64}`;
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>איסטרוניקס - בדיקת תאימות חומרה</title>
  <style>
    :root { color-scheme: dark; font-family: "Segoe UI", Arial, sans-serif; background:#0c1117; color:#f4f7fb; }
    * { box-sizing: border-box; }
    body { margin: 0; background:#0c1117; }
    button,input,select { font: inherit; }
    .easx-cms { min-height: 100vh; padding: 22px; background:#0c1117; color:#f4f7fb; }
    .topbar { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; margin-bottom:18px; }
    .brand { width:min(360px, 100%); margin-bottom:12px; }
    .brand img { display:block; width:100%; height:auto; object-fit:contain; }
    h1,h2,p { margin:0; }
    h1 { font-size:30px; line-height:1.18; letter-spacing:0; }
    h2 { font-size:19px; letter-spacing:0; }
    .subtitle { margin-top:7px; max-width:880px; color:#9fb1bf; line-height:1.5; }
    .rights { min-height:48px; display:inline-flex; align-items:center; padding:0 12px; border:1px solid #263642; border-radius:8px; color:#c9d8dd; background:#101820; line-height:1.45; text-align:center; white-space:nowrap; }
    .selector-grid { display:grid; grid-template-columns:repeat(4, minmax(210px, 1fr)); gap:14px; margin-bottom:14px; }
    .panel { min-width:0; display:grid; align-content:start; gap:14px; padding:16px; border:1px solid #263642; border-radius:8px; background:#141e28; }
    .panel-title { display:flex; align-items:center; gap:9px; }
    label { display:grid; gap:7px; color:#c9d8dd; }
    input,select { width:100%; min-height:44px; padding:0 12px; border:1px solid #334454; border-radius:8px; color:#f8fafc; background:#101820; }
    .mini-specs { display:grid; gap:7px; }
    .mini-specs span { min-height:34px; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px; border-radius:8px; background:#0f1720; color:#d8e7ed; }
    .mini-specs b { color:#9fb1bf; font-weight:600; }
    .result-panel { margin-bottom:14px; background:#132019; border-color:rgba(88,214,166,.35); }
    .compat-grid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; }
    .compat-item { display:flex; gap:10px; min-width:0; padding:12px; border-radius:8px; background:#0f1720; }
    .compat-item strong,.compat-item span { display:block; }
    .compat-item span { margin-top:4px; color:#9fb1bf; line-height:1.45; }
    .compat-item.ok .status-dot { background:#58d6a6; }
    .compat-item.warn .status-dot { background:#f2bf4b; }
    .compat-item.bad .status-dot { background:#ff6b6b; }
    .status-dot { flex:0 0 auto; width:14px; height:14px; margin-top:4px; border-radius:50%; }
    .compare-table { display:grid; grid-template-columns:minmax(120px,.78fr) repeat(4,minmax(170px,1fr)); overflow:auto; border:1px solid #263642; border-radius:8px; }
    .compare-head,.compare-key,.compare-cell { min-height:46px; padding:11px 12px; border-bottom:1px solid #263642; border-left:1px solid #263642; line-height:1.45; }
    .compare-head { color:#06100c; background:#58d6a6; font-weight:800; }
    .compare-key { color:#c9d8dd; background:#101820; font-weight:700; }
    .compare-cell { color:#edf5f8; background:#141e28; }
    .empty { padding:12px; border-radius:8px; background:#0f1720; color:#9fb1bf; }
    .source-note { margin-top:14px; color:#9fb1bf; line-height:1.5; }
    @media (max-width:1180px) { .selector-grid,.compat-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:760px) { .easx-cms { padding:14px; } .topbar { display:grid; } .rights { width:100%; justify-content:center; white-space:normal; } h1 { font-size:24px; } .selector-grid,.compat-grid { grid-template-columns:1fr; } .compare-table { grid-template-columns:minmax(110px,.8fr) repeat(4,minmax(145px,1fr)); } }
  </style>
</head>
<body>
  <div class="easx-cms" id="easxHardwareCms"></div>
  <script>
    const catalog = ${catalogJson};
    const logoSrc = ${JSON.stringify(logoDataUrl)};
    const typeMeta = {
      motherboard: { label: "לוח אם ASUS" },
      cpu: { label: "מעבד Intel" },
      gpu: { label: "כרטיס מסך ASUS" },
      memory: { label: "זיכרון Kingston" }
    };
    const state = {
      selected: {
        motherboard: "mb-asus-rog-strix-z890-e-gaming-wifi",
        cpu: "cpu-intel-core-ultra-7-265k",
        gpu: "gpu-asus-prime-rtx-5070-ti",
        memory: "ram-kingston-fury-beast-ddr5-6000-32"
      },
      queries: { motherboard: "", cpu: "", gpu: "", memory: "" }
    };
    const root = document.getElementById("easxHardwareCms");

    function render() {
      const build = currentBuild();
      const report = compatibilityReport(build);
      root.innerHTML = \`
        <header class="topbar">
          <div>
            <div class="brand"><img src="\${logoSrc}" alt="איסטרוניקס" /></div>
            <h1>השוואת לוח אם, מעבד, כרטיס מסך וזיכרון</h1>
            <p class="subtitle">בחר ארבעה רכיבים או חפש לפי שם/מק״ט. המערכת מציגה מפרט ובודקת Socket, סוג זיכרון, PCIe והמלצת ספק כוח.</p>
          </div>
          <div class="rights">כל הזכויות שמורות לשחף כץ<br />לשאלות נא להתקשר 0523030191</div>
        </header>
        <section class="selector-grid">\${Object.keys(typeMeta).map(renderPicker).join("")}</section>
        <section class="panel result-panel">
          <div class="panel-title"><h2>\${report.title}</h2></div>
          <div class="compat-grid">\${report.messages.map(renderCompat).join("")}</div>
        </section>
        <section class="panel">
          <div class="panel-title"><h2>השוואה טכנית מלאה</h2></div>
          <div class="compare-table">\${renderComparison(build)}</div>
        </section>
        <p class="source-note">גרסת Wix סטטית: הנתונים מוטמעים בקובץ. לעדכון קטלוג יש ליצור מחדש את קובץ ה-Embed ולהדביק אותו ב-Wix.</p>
      \`;
      bindEvents();
    }

    function renderPicker(type) {
      const items = filteredItems(type);
      const selected = itemById(state.selected[type]);
      return \`
        <section class="panel">
          <div class="panel-title"><h2>\${typeMeta[type].label}</h2></div>
          <label>חיפוש מהיר
            <input data-search="\${type}" value="\${escapeAttr(state.queries[type])}" placeholder="כתוב דגם או מק״ט ולחץ Enter" />
          </label>
          <label>בחירה מתוך \${items.length} דגמים
            <select data-select="\${type}">
              <option value="">בחר דגם</option>
              \${items.map((item) => \`<option value="\${item.id}" \${item.id === state.selected[type] ? "selected" : ""}>\${escapeHtml(item.brand)} \${escapeHtml(item.model)} | מק״ט: \${escapeHtml(item.partNumber || "לא ידוע")}</option>\`).join("")}
            </select>
          </label>
          \${renderMiniSpecs(selected)}
        </section>
      \`;
    }

    function renderMiniSpecs(item) {
      if (!item) return '<p class="empty">לא נבחר דגם.</p>';
      const specs = [
        ["מק״ט", item.partNumber],
        ["סדרה", item.series],
        ["Socket", item.socket],
        ["Chipset", item.chipset],
        ["זיכרון", item.memoryTypes?.join(" / ") || item.memoryType],
        ["PCIe", item.pcieGpuSlot || item.bus],
        ["הספק", item.recommendedPsuW ? item.recommendedPsuW + "W PSU" : item.turboPowerW ? item.turboPowerW + "W Turbo" : ""]
      ].filter(([, value]) => value);
      return \`<div class="mini-specs">\${specs.map(([label, value]) => \`<span><b>\${escapeHtml(label)}</b>\${escapeHtml(value)}</span>\`).join("")}</div>\`;
    }

    function renderCompat(message) {
      return \`<article class="compat-item \${message.level}"><span class="status-dot"></span><div><strong>\${escapeHtml(message.title)}</strong><span>\${escapeHtml(message.text)}</span></div></article>\`;
    }

    function renderComparison(build) {
      const rows = buildComparisonRows(build);
      const types = Object.keys(typeMeta);
      return \`
        <div class="compare-head">פרמטר</div>
        \${types.map((type) => \`<div class="compare-head">\${typeMeta[type].label}</div>\`).join("")}
        \${rows.map((row) => \`<div class="compare-key">\${row.label}</div>\${types.map((type) => \`<div class="compare-cell">\${escapeHtml(formatValue(row.values[type]))}</div>\`).join("")}\`).join("")}
      \`;
    }

    function bindEvents() {
      root.querySelectorAll("[data-search]").forEach((input) => {
        input.addEventListener("input", (event) => {
          state.queries[event.target.dataset.search] = event.target.value;
          render();
          const nextInput = root.querySelector(\`[data-search="\${event.target.dataset.search}"]\`);
          nextInput?.focus();
          nextInput?.setSelectionRange(event.target.value.length, event.target.value.length);
        });
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          const type = event.target.dataset.search;
          const first = filteredItems(type)[0];
          if (first) {
            state.selected[type] = first.id;
            render();
          }
        });
      });
      root.querySelectorAll("[data-select]").forEach((select) => {
        select.addEventListener("change", (event) => {
          state.selected[event.target.dataset.select] = event.target.value;
          render();
        });
      });
    }

    function currentBuild() {
      return Object.fromEntries(Object.keys(typeMeta).map((type) => [type, itemById(state.selected[type])]));
    }

    function itemById(id) {
      return catalog.items.find((item) => item.id === id);
    }

    function filteredItems(type) {
      const query = state.queries[type].trim().toLowerCase();
      return catalog.items
        .filter((item) => item.type === type)
        .filter((item) => !query || \`\${item.brand} \${item.model} \${item.series || ""} \${item.partNumber || ""} \${item.gpuChip || ""}\`.toLowerCase().includes(query));
    }

    function compatibilityReport({ motherboard, cpu, gpu, memory }) {
      const messages = [];
      if ([motherboard, cpu, gpu, memory].some((item) => !item)) messages.push({ id:"missing", level:"bad", title:"חסרה בחירה", text:"בחר את כל ארבעת הרכיבים כדי לקבל אישור תאימות מלא." });
      if (motherboard && cpu) {
        const ok = motherboard.socket === cpu.socket;
        messages.push({ id:"socket", level: ok ? "ok" : "bad", title:"תאימות מעבד ולוח", text: ok ? \`שניהם משתמשים ב-\${cpu.socket}.\` : \`המעבד הוא \${cpu.socket || "לא ידוע"} והלוח הוא \${motherboard.socket || "לא ידוע"}.\` });
      }
      if (motherboard && memory) {
        const supported = (motherboard.memoryTypes || []).includes(memory.memoryType);
        const desktopModule = !String(memory.moduleType || "").toUpperCase().includes("SODIMM");
        const serverModule = /RDIMM|ECC/i.test(memory.moduleType || memory.memoryType || "");
        messages.push({ id:"memory", level: supported && desktopModule && !serverModule ? "ok" : "bad", title:"תאימות זיכרון", text: supported && desktopModule && !serverModule ? \`\${memory.memoryType} \${memory.kit || ""} נתמך עקרונית בלוח. בדוק QVL למהירות \${memory.speedMt || ""}MT/s.\` : \`הלוח תומך ב-\${(motherboard.memoryTypes || []).join(" / ") || "לא ידוע"} מסוג דסקטופ, והזיכרון הוא \${memory.memoryType || "לא ידוע"} \${memory.moduleType || ""}.\` });
      }
      if (motherboard && gpu) {
        const hasSlot = Boolean(motherboard.pcieGpuSlot);
        const slotVersion = pcieVersion(motherboard.pcieGpuSlot);
        const gpuVersion = pcieVersion(gpu.bus);
        const level = hasSlot ? (slotVersion && gpuVersion && slotVersion < gpuVersion ? "warn" : "ok") : "bad";
        messages.push({ id:"gpu", level, title:"תאימות כרטיס מסך", text: level === "ok" ? \`\${gpu.bus} יעבוד בחריץ \${motherboard.pcieGpuSlot}.\` : level === "warn" ? \`הכרטיס יעבוד, אבל ירד למהירות החריץ: \${motherboard.pcieGpuSlot}.\` : "לא נמצא חריץ PCIe x16 בלוח." });
      }
      if (cpu && gpu) {
        const recommended = Math.max(Number(gpu.recommendedPsuW || 0), Math.ceil((Number(cpu.turboPowerW || cpu.basePowerW || 0) + 250) / 50) * 50);
        messages.push({ id:"psu", level: recommended >= 850 ? "warn" : "ok", title:"המלצת ספק כוח", text:\`מומלץ ספק איכותי של לפחות \${recommended || gpu.recommendedPsuW || 650}W, בהתאם למארז, קירור וכמות כוננים.\` });
      }
      const bad = messages.some((message) => message.level === "bad");
      const warn = messages.some((message) => message.level === "warn");
      return { title: bad ? "לא מאושר כרגע" : warn ? "תואם עם הערות" : "תואם", messages };
    }

    function buildComparisonRows(build) {
      const rows = [
        ["model", "דגם", (item) => item ? \`\${item.brand} \${item.model}\` : ""],
        ["partNumber", "מק״ט", (item) => item?.partNumber],
        ["series", "סדרה", (item) => item?.series],
        ["socket", "Socket", (item) => item?.socket],
        ["chipset", "Chipset", (item) => item?.chipset],
        ["memory", "זיכרון נתמך/סוג", (item) => item?.memoryTypes?.join(" / ") || item?.memoryType || item?.memory],
        ["capacity", "נפח/חריצים", (item) => item?.capacityGb ? \`\${item.capacityGb}GB \${item.kit || ""}\` : item?.memorySlots ? \`\${item.memorySlots} חריצים, עד \${item.maxMemoryGb}GB\` : ""],
        ["speed", "מהירות", (item) => item?.speedMt ? \`\${item.speedMt}MT/s\` : item?.maxBoostGhz ? \`עד \${item.maxBoostGhz}GHz\` : ""],
        ["cores", "ליבות/תהליכונים", (item) => item?.cores ? \`\${item.cores}, \${item.threads} threads\` : ""],
        ["power", "הספק", (item) => item?.recommendedPsuW ? \`ספק מומלץ \${item.recommendedPsuW}W\` : item?.turboPowerW ? \`\${item.basePowerW}W בסיס, \${item.turboPowerW}W טורבו\` : ""],
        ["pcie", "PCIe", (item) => item?.pcieGpuSlot || item?.bus],
        ["size", "מידות/תצורה", (item) => item?.formFactor || (item?.lengthMm ? \`\${item.lengthMm}mm, \${item.slots} slots\` : item?.moduleType)],
        ["notes", "הערות", (item) => item?.notes]
      ];
      return rows.map(([key, label, getter]) => ({ key, label, values: Object.fromEntries(Object.keys(typeMeta).map((type) => [type, getter(build[type])])) }));
    }

    function pcieVersion(value = "") {
      const match = String(value).match(/PCIe\\s*([0-9.]+)/i);
      return match ? Number(match[1]) : 0;
    }
    function formatValue(value) { return Array.isArray(value) ? value.join(" / ") : value || "—"; }
    function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[char])); }
    function escapeAttr(value) { return escapeHtml(value); }
    render();
  </script>
</body>
</html>
`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
