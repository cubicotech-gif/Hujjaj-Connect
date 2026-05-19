"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { normPhone, fillTemplate } from "@/lib/phone";
import { parseBilooText, parseBilooSheets, type ParsedRow } from "@/lib/parse";
import type { Pilgrim, Template } from "@/lib/types";

const supabase = createClient();

export default function HujjajApp() {
  const [loading, setLoading] = useState(true);
  const [pilgrims, setPilgrims] = useState<Pilgrim[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [cc, setCc] = useState("92");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [sheet, setSheet] = useState<null | "add" | "set" | "wa" | "bulk" | "bulkedit">(null);
  const [waTarget, setWaTarget] = useState<Pilgrim | null>(null);
  const [tab, setTab] = useState<"paste" | "file" | "one">("paste");
  const [bulk, setBulk] = useState("");
  const [parsed, setParsed] = useState<ParsedRow[]>([]);
  const [parsedBus, setParsedBus] = useState("");
  const [fileStatus, setFileStatus] = useState("");
  const [one, setOne] = useState({ name: "", phone: "", bus: "", grp: "" });
  const [waCustom, setWaCustom] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkQueue, setBulkQueue] = useState<{ p: Pilgrim; msg: string }[]>([]);
  const [bulkIdx, setBulkIdx] = useState(0);
  const [bulkEdit, setBulkEdit] = useState({
    hotel: "",
    room: "",
    bus: "",
    grp: "",
    checkin_at: "",
    checkout_at: "",
  });
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((m: string) => {
    setToast(m);
    if (toastT.current) clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToast(""), 2200);
  }, []);

  const loadAll = useCallback(async () => {
    const [p, t, c] = await Promise.all([
      supabase.from("pilgrims").select("*").order("created_at", { ascending: true }),
      supabase.from("templates").select("*").order("sort", { ascending: true }),
      supabase.from("app_config").select("country_code").eq("id", 1).single(),
    ]);
    if (p.data) setPilgrims(p.data as Pilgrim[]);
    if (t.data) setTemplates(t.data as Template[]);
    if (c.data?.country_code) setCc(c.data.country_code);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
    let t: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (t) clearTimeout(t);
      t = setTimeout(loadAll, 250);
    };
    const ch = supabase
      .channel("hujjaj")
      .on("postgres_changes", { event: "*", schema: "public", table: "pilgrims" }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "templates" }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "app_config" }, bump)
      .subscribe();
    return () => {
      if (t) clearTimeout(t);
      supabase.removeChannel(ch);
    };
  }, [loadAll]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return pilgrims;
    return pilgrims.filter((p) =>
      [p.name, p.phone, p.bus, p.hotel, p.room, p.grp, p.notes].some((v) =>
        (v || "").toLowerCase().includes(s)
      )
    );
  }, [pilgrims, q]);

  const isDateField = (f: keyof Pilgrim) => f === "checkin_at" || f === "checkout_at";

  async function patch(id: string, field: keyof Pilgrim, value: string) {
    const dbValue = isDateField(field) ? (value || null) : value;
    setPilgrims((cur) => cur.map((p) => (p.id === id ? { ...p, [field]: dbValue } : p)));
    await supabase.from("pilgrims").update({ [field]: dbValue }).eq("id", id);
  }
  async function del(p: Pilgrim) {
    if (!confirm("Delete " + (p.name || "this person") + "?")) return;
    await supabase.from("pilgrims").delete().eq("id", p.id);
    setPilgrims((cur) => cur.filter((x) => x.id !== p.id));
    flash("Deleted");
  }

  async function bulkDelete() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} hujji? This cannot be undone.`)) return;
    setPilgrims((cur) => cur.filter((p) => !selected.has(p.id)));
    const { error } = await supabase.from("pilgrims").delete().in("id", ids);
    if (error) return flash("Delete failed");
    setSelected(new Set());
    setSelectMode(false);
    flash(`Deleted ${ids.length}`);
  }

  async function applyBulkEdit() {
    const ids = [...selected];
    if (!ids.length) return flash("Pick people first");
    const updates: Record<string, string | null> = {};
    (Object.keys(bulkEdit) as (keyof typeof bulkEdit)[]).forEach((k) => {
      const v = bulkEdit[k].trim();
      if (!v) return;
      if (k === "checkin_at" || k === "checkout_at") updates[k] = v;
      else updates[k] = v;
    });
    if (!Object.keys(updates).length) return flash("Fill at least one field");
    setPilgrims((cur) => cur.map((p) => (selected.has(p.id) ? { ...p, ...updates } : p)));
    const { error } = await supabase.from("pilgrims").update(updates).in("id", ids);
    if (error) return flash("Update failed");
    setBulkEdit({ hotel: "", room: "", bus: "", grp: "", checkin_at: "", checkout_at: "" });
    setSheet(null);
    setSelected(new Set());
    setSelectMode(false);
    flash(`Updated ${ids.length}`);
  }

  function fmtDate(s?: string | null): string {
    if (!s) return "";
    const d = new Date(s);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  const today = () => new Date().toISOString().slice(0, 10);

  async function commitParsed() {
    const picked = parsed.filter((r) => r.sel && r.phone.trim());
    if (!picked.length) return flash("Nothing selected");
    const have = new Set(pilgrims.map((p) => normPhone(p.phone, cc)));
    const seen = new Set<string>();
    const rows: Omit<Pilgrim, "id">[] = [];
    for (const r of picked) {
      const n = normPhone(r.phone, cc);
      if (!n || have.has(n) || seen.has(n)) continue;
      seen.add(n);
      rows.push({
        name: r.name.trim(),
        phone: r.phone.trim(),
        bus: (r.bus || "").trim(),
        hotel: (r.hotel || "").trim(),
        room: "",
        grp: (r.grp || "").trim(),
        notes: (r.notes || "").trim(),
      });
    }
    if (!rows.length) return flash("All already exist");
    const { error } = await supabase.from("pilgrims").insert(rows);
    if (error) return flash("Import failed");
    setParsed([]);
    setParsedBus("");
    setBulk("");
    setSheet(null);
    const dupes = picked.length - rows.length;
    flash(rows.length + " added" + (dupes ? ` · ${dupes} duplicates skipped` : ""));
  }

  async function addOne() {
    if (!one.phone.trim()) return flash("Phone is required");
    const { error } = await supabase.from("pilgrims").insert({
      name: one.name.trim(),
      phone: one.phone.trim(),
      bus: one.bus.trim(),
      grp: one.grp.trim(),
      hotel: "",
      room: "",
      notes: "",
    });
    if (error) return flash("Failed");
    setOne({ name: "", phone: "", bus: "", grp: "" });
    setSheet(null);
    flash("Added");
  }

  function applyParsedText(text: string) {
    const { rows, bus } = parseBilooText(text);
    setParsed(rows);
    setParsedBus(bus);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const ext = f.name.toLowerCase().split(".").pop() || "";
    try {
      if (ext === "xlsx" || ext === "xls" || f.type.includes("spreadsheet")) {
        setFileStatus("Reading spreadsheet…");
        const mod: any = await import("read-excel-file/browser");
        const readXlsx = mod.default;
        const readSheetNames = mod.readSheetNames;
        const names: string[] = await readSheetNames(f);
        const sheets: { name: string; rows: any[][] }[] = [];
        for (const n of names) {
          const rows = await readXlsx(f, { sheet: n });
          sheets.push({ name: n, rows: rows as any[][] });
        }
        const { rows, bus } = parseBilooSheets(sheets);
        if (!rows.length) {
          setFileStatus("No rows found. Make sure the sheet has 'Passenger Name' and 'MOBIL NO' columns.");
          return;
        }
        setParsed(rows);
        setParsedBus(bus);
        setTab("paste");
        setFileStatus(`Extracted ${rows.length} rows from ${names.length} sheet(s)${bus ? ` · Bus ${bus}` : ""}.`);
      } else if (f.type === "application/pdf" || ext === "pdf") {
        setFileStatus("Reading PDF…");
        const pdfjs: any = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;
        const buf = await f.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: buf }).promise;
        let txt = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const pg = await pdf.getPage(i);
          const c = await pg.getTextContent();
          let last: number | null = null;
          c.items.forEach((it: any) => {
            if (last !== null && Math.abs(it.transform[5] - last) > 3) txt += "\n";
            txt += it.str + " ";
            last = it.transform[5];
          });
          txt += "\n";
        }
        if (!txt.trim()) {
          setFileStatus("This PDF has no selectable text (scanned). Screenshot it and upload as an image.");
          return;
        }
        setBulk(txt.trim());
        applyParsedText(txt);
        setTab("paste");
        setFileStatus("Extracted — review below.");
      } else if (f.type.startsWith("image/")) {
        setFileStatus("Loading OCR engine…");
        const Tesseract: any = await import("tesseract.js");
        setFileStatus("Reading image (can take a moment)…");
        const { data } = await Tesseract.recognize(f, "eng");
        const text = data.text || "";
        setBulk(text.trim());
        applyParsedText(text);
        setTab("paste");
        setFileStatus("OCR done — check it carefully, it is not perfect.");
      } else {
        setFileStatus("Unsupported file type. Upload Excel, PDF, or an image.");
      }
    } catch {
      setFileStatus("Could not read that file. Paste the text manually.");
    }
    e.target.value = "";
  }

  function go(p: Pilgrim, msg: string) {
    const n = normPhone(p.phone, cc);
    if (!n) return flash("No valid number");
    window.open("https://wa.me/" + n + "?text=" + encodeURIComponent(msg), "_blank");
    setSheet(null);
  }

  // ---- settings: templates + country code ----
  async function saveCc(v: string) {
    const code = v.replace(/\D/g, "") || "92";
    setCc(code);
    await supabase.from("app_config").update({ country_code: code }).eq("id", 1);
  }
  async function tplPatch(id: string, field: "title" | "body", value: string) {
    setTemplates((cur) => cur.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
    await supabase.from("templates").update({ [field]: value }).eq("id", id);
  }
  async function tplAdd() {
    await supabase
      .from("templates")
      .insert({ title: "New template", body: "Assalam o Alaikum {name}, ", sort: templates.length });
  }
  async function tplDel(id: string) {
    await supabase.from("templates").delete().eq("id", id);
    setTemplates((cur) => cur.filter((t) => t.id !== id));
  }

  function dl(name: string, content: string, type: string) {
    const b = new Blob([content], { type });
    const u = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = u;
    a.download = name;
    a.click();
    URL.revokeObjectURL(u);
  }
  function expJson() {
    dl(
      "hujjaj-" + new Date().toISOString().slice(0, 10) + ".json",
      JSON.stringify({ pilgrims, templates, cc }, null, 2),
      "application/json"
    );
    flash("Backup downloaded");
  }
  function expCsv() {
    const head = ["name", "phone", "intl", "bus", "hotel", "room", "group", "notes", "checkin", "checkout"];
    const rows = pilgrims.map((p) =>
      [p.name, p.phone, "+" + normPhone(p.phone, cc), p.bus, p.hotel, p.room, p.grp, p.notes, p.checkin_at || "", p.checkout_at || ""]
        .map((v) => '"' + String(v || "").replace(/"/g, '""') + '"')
        .join(",")
    );
    dl("hujjaj-" + new Date().toISOString().slice(0, 10) + ".csv", [head.join(","), ...rows].join("\n"), "text/csv");
    flash("CSV downloaded");
  }
  async function impJson(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (Array.isArray(d.pilgrims)) {
        const have = new Set(pilgrims.map((p) => normPhone(p.phone, cc)));
        const rows = d.pilgrims
          .filter((p: Pilgrim) => !have.has(normPhone(p.phone, cc)))
          .map((p: Pilgrim) => ({
            name: p.name || "",
            phone: p.phone || "",
            bus: p.bus || "",
            hotel: p.hotel || "",
            room: p.room || "",
            grp: p.grp || "",
            notes: p.notes || "",
            checkin_at: p.checkin_at || null,
            checkout_at: p.checkout_at || null,
          }));
        if (rows.length) await supabase.from("pilgrims").insert(rows);
        flash(rows.length + " new hujjaj imported");
      } else flash("Not a valid backup file");
    } catch {
      flash("Could not read that file");
    }
    e.target.value = "";
  }

  if (loading)
    return (
      <div className="wrap">
        <div className="loading">
          <div className="spin" />
          Loading your hujjaj…
        </div>
      </div>
    );

  return (
    <>
      <div className="wrap">
        <header>
          <div className="logo">ح</div>
          <div>
            <h1>Hujjaj Connect</h1>
            <div className="sub">Billoo Travels · field ops</div>
          </div>
          <button
            className="icbtn"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              setSelectMode((v) => !v);
              setSelected(new Set());
            }}
            title={selectMode ? "Exit select mode" : "Select multiple"}
          >
            {selectMode ? "✕" : "☑"}
          </button>
          <button className="icbtn" onClick={() => setSheet("set")} title="Settings">
            ⚙
          </button>
        </header>

        <div className="bar">
          <div className="search">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              placeholder="Search name, number, bus, hotel…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
        <div className="stat">
          <span>
            <b>{pilgrims.length}</b> hujjaj
          </span>
          {q && (
            <span>
              <b>{list.length}</b> shown
            </span>
          )}
        </div>

        {pilgrims.length === 0 ? (
          <div className="card pad empty">
            <div className="big">٤</div>
            <p>
              No hujjaj yet.
              <br />
              Tap <b>Add hujjaj</b> to import your list.
            </p>
          </div>
        ) : list.length === 0 ? (
          <div className="card pad empty">
            <p>Nothing matches “{q}”.</p>
          </div>
        ) : (
          list.map((p) => {
            const intl = normPhone(p.phone, cc);
            const ini = (p.name || "?").trim().charAt(0).toUpperCase() || "?";
            const meta =
              [
                p.bus && "Bus " + p.bus,
                p.hotel,
                p.room && "Rm " + p.room,
                p.grp,
                p.checkin_at && "✓ In " + fmtDate(p.checkin_at),
                p.checkout_at && "Out " + fmtDate(p.checkout_at),
              ]
                .filter(Boolean)
                .join(" · ") || p.phone || "no details";
            const open = openId === p.id;
            const checked = selected.has(p.id);
            return (
              <div className={"row" + (open ? " open" : "")} key={p.id}>
                <div
                  className="rhead"
                  onClick={() => {
                    if (selectMode) {
                      setSelected((cur) => {
                        const n = new Set(cur);
                        if (n.has(p.id)) n.delete(p.id);
                        else n.add(p.id);
                        return n;
                      });
                    } else {
                      setOpenId(open ? null : p.id);
                    }
                  }}
                >
                  {selectMode ? (
                    <input
                      type="checkbox"
                      checked={checked}
                      readOnly
                      style={{ width: 22, height: 22, accentColor: "var(--green)", flex: "none" }}
                    />
                  ) : (
                    <div className="av">{ini}</div>
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="rname">{p.name || "Unnamed"}</div>
                    <div className="rmeta">{meta}</div>
                  </div>
                  {!selectMode && (
                    <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  )}
                </div>
                {open && (
                  <div className="body">
                    <div className="grid">
                      {(["name", "phone"] as const).map((f) => (
                        <div className="fld col2" key={f}>
                          <label>{f}</label>
                          <input
                            defaultValue={p[f]}
                            inputMode={f === "phone" ? "tel" : undefined}
                            onBlur={(e) => e.target.value !== p[f] && patch(p.id, f, e.target.value)}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="resolved">
                      WhatsApp: <b>+{intl || "—"}</b>
                    </div>
                    <div className="grid">
                      {(["hotel", "room", "bus", "grp"] as const).map((f) => (
                        <div className="fld" key={f}>
                          <label>{f === "grp" ? "Group" : f}</label>
                          <input
                            defaultValue={p[f]}
                            onBlur={(e) => e.target.value !== p[f] && patch(p.id, f, e.target.value)}
                          />
                        </div>
                      ))}
                      <div className="fld col2">
                        <label>Notes</label>
                        <input
                          defaultValue={p.notes}
                          onBlur={(e) => e.target.value !== p.notes && patch(p.id, "notes", e.target.value)}
                        />
                      </div>
                      <div className="fld">
                        <label>Check-in</label>
                        <input
                          type="date"
                          key={"in-" + p.id + "-" + (p.checkin_at || "")}
                          defaultValue={p.checkin_at || ""}
                          onBlur={(e) =>
                            (e.target.value || null) !== (p.checkin_at || null) &&
                            patch(p.id, "checkin_at", e.target.value)
                          }
                        />
                        <button
                          className="btn g sm"
                          style={{ width: "100%", marginTop: 6, fontSize: 12 }}
                          onClick={() => patch(p.id, "checkin_at", today())}
                        >
                          Check in today
                        </button>
                      </div>
                      <div className="fld">
                        <label>Check-out</label>
                        <input
                          type="date"
                          key={"out-" + p.id + "-" + (p.checkout_at || "")}
                          defaultValue={p.checkout_at || ""}
                          onBlur={(e) =>
                            (e.target.value || null) !== (p.checkout_at || null) &&
                            patch(p.id, "checkout_at", e.target.value)
                          }
                        />
                        <button
                          className="btn g sm"
                          style={{ width: "100%", marginTop: 6, fontSize: 12 }}
                          onClick={() => patch(p.id, "checkout_at", today())}
                        >
                          Check out today
                        </button>
                      </div>
                    </div>
                    <button
                      className="btn wa"
                      onClick={() => {
                        setWaTarget(p);
                        setWaCustom("");
                        setSheet("wa");
                      }}
                    >
                      Message on WhatsApp
                    </button>
                    <div className="acts">
                      {intl ? (
                        <a className="btn g sm" href={"tel:+" + intl}>
                          Call
                        </a>
                      ) : (
                        <button className="btn g sm" onClick={() => flash("No valid number")}>
                          Call
                        </button>
                      )}
                      <button
                        className="btn g sm"
                        onClick={() =>
                          intl ? window.open("https://wa.me/" + intl, "_blank") : flash("No valid number")
                        }
                      >
                        Open chat
                      </button>
                    </div>
                    <button className="danger" onClick={() => del(p)}>
                      Delete this hujji
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {selectMode ? (
        <div className="selbar">
          <button
            className="btn g sm"
            onClick={() => {
              const ids = new Set(list.map((p) => p.id));
              const same = selected.size === ids.size && [...ids].every((i) => selected.has(i));
              setSelected(same ? new Set() : ids);
            }}
          >
            {selected.size === list.length && list.length > 0 ? "Clear" : "All"}
          </button>
          <div className="selcount">
            <b>{selected.size}</b>
          </div>
          <button
            className="btn p sm"
            disabled={selected.size === 0}
            onClick={() => {
              if (selected.size === 0) return flash("Pick at least one");
              setSheet("bulk");
            }}
          >
            Send
          </button>
          <button
            className="btn g sm"
            disabled={selected.size === 0}
            onClick={() => {
              if (selected.size === 0) return flash("Pick at least one");
              setBulkEdit({ hotel: "", room: "", bus: "", grp: "", checkin_at: "", checkout_at: "" });
              setSheet("bulkedit");
            }}
          >
            Edit
          </button>
          <button
            className="btn sm"
            style={{ background: "#fdecec", color: "var(--warn)", border: "1px solid #f3cfcf" }}
            disabled={selected.size === 0}
            onClick={bulkDelete}
          >
            Delete
          </button>
        </div>
      ) : (
        <button className="fab" onClick={() => { setParsed([]); setParsedBus(""); setSheet("add"); }}>
          ＋ Add hujjaj
        </button>
      )}

      {/* ADD SHEET */}
      {sheet === "add" && (
        <div className="ov" onClick={(e) => e.target === e.currentTarget && setSheet(null)}>
          <div className="sheet">
            <div className="shead">
              <h2>Add hujjaj</h2>
              <button className="x" onClick={() => setSheet(null)}>
                ✕
              </button>
            </div>
            <div className="sbody">
              <div className="seg">
                {(["paste", "file", "one"] as const).map((t) => (
                  <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                    {t === "paste" ? "Paste / type" : t === "file" ? "PDF / image" : "Single"}
                  </button>
                ))}
              </div>

              {tab === "paste" && (
                <>
                  <div className="hint">
                    Paste lines in any format — one person per line, e.g.
                    <br />
                    <code>Muhammad Aslam 03001234567 Bus 5</code>
                  </div>
                  <textarea
                    value={bulk}
                    onChange={(e) => setBulk(e.target.value)}
                    placeholder={"Ahmed Ali  0300 1234567  Bus 3\nFatima Bibi, +92 321 1234567, Group A"}
                  />
                  <button className="btn p sm" style={{ marginTop: 10 }} onClick={() => applyParsedText(bulk)}>
                    Parse list
                  </button>
                </>
              )}

              {tab === "file" && (
                <>
                  <div className="hint">
                    <b>Excel (.xlsx)</b> is the cleanest — columns map directly. <b>PDF</b> with real text is next best. <b>Photo / scan</b> uses on-device OCR (slower, review carefully).
                  </div>
                  <input
                    type="file"
                    accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/pdf,image/*"
                    onChange={onFile}
                    style={{ fontSize: 13, width: "100%" }}
                  />
                  {fileStatus && <div className="hint" style={{ marginTop: 10 }}>{fileStatus}</div>}
                </>
              )}

              {tab === "one" && (
                <>
                  {(["name", "phone"] as const).map((k) => (
                    <div className="fld" style={{ marginBottom: 10 }} key={k}>
                      <label>{k}</label>
                      <input
                        value={one[k]}
                        inputMode={k === "phone" ? "tel" : undefined}
                        onChange={(e) => setOne({ ...one, [k]: e.target.value })}
                      />
                    </div>
                  ))}
                  <div className="grid">
                    <div className="fld">
                      <label>Bus</label>
                      <input value={one.bus} onChange={(e) => setOne({ ...one, bus: e.target.value })} />
                    </div>
                    <div className="fld">
                      <label>Group</label>
                      <input value={one.grp} onChange={(e) => setOne({ ...one, grp: e.target.value })} />
                    </div>
                  </div>
                  <button className="btn p sm" style={{ width: "100%" }} onClick={addOne}>
                    Add this person
                  </button>
                </>
              )}

              {parsed.length > 0 && (
                <>
                  <div className="prev">
                    <div className="ph">
                      <input
                        type="checkbox"
                        checked={parsed.every((r) => r.sel)}
                        onChange={(e) => setParsed(parsed.map((r) => ({ ...r, sel: e.target.checked })))}
                        style={{ width: 17, height: 17, accentColor: "var(--green)" }}
                      />
                      Found {parsed.length} — review &amp; edit, then import
                    </div>
                    {parsed.map((r, i) => (
                      <div className="pitem" key={i} style={{ flexWrap: "wrap" }}>
                        <input
                          type="checkbox"
                          checked={r.sel}
                          onChange={(e) =>
                            setParsed(parsed.map((x, j) => (j === i ? { ...x, sel: e.target.checked } : x)))
                          }
                        />
                        <input
                          type="text"
                          className="nm"
                          placeholder="Name"
                          value={r.name}
                          onChange={(e) =>
                            setParsed(parsed.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                          }
                        />
                        <input
                          type="text"
                          placeholder="Phone"
                          value={r.phone}
                          inputMode="tel"
                          style={{ maxWidth: 140 }}
                          onChange={(e) =>
                            setParsed(parsed.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))
                          }
                        />
                        <input
                          type="text"
                          placeholder="Hotel"
                          value={r.hotel}
                          style={{ flex: "1 1 100%", marginLeft: 28 }}
                          onChange={(e) =>
                            setParsed(parsed.map((x, j) => (j === i ? { ...x, hotel: e.target.value } : x)))
                          }
                        />
                        <input
                          type="text"
                          placeholder="Group (PKG)"
                          value={r.grp}
                          style={{ flex: 1, marginLeft: 28 }}
                          onChange={(e) =>
                            setParsed(parsed.map((x, j) => (j === i ? { ...x, grp: e.target.value } : x)))
                          }
                        />
                        <input
                          type="text"
                          placeholder="Bus"
                          value={r.bus}
                          style={{ maxWidth: 80 }}
                          onChange={(e) =>
                            setParsed(parsed.map((x, j) => (j === i ? { ...x, bus: e.target.value } : x)))
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <div className="fld" style={{ marginTop: 12 }}>
                    <label>Apply bus number to all (optional)</label>
                    <input
                      type="text"
                      value={parsedBus}
                      placeholder="e.g. 01"
                      onChange={(e) => {
                        const v = e.target.value;
                        setParsedBus(v);
                        setParsed(parsed.map((r) => ({ ...r, bus: v })));
                      }}
                      style={{ maxWidth: 140 }}
                    />
                  </div>
                  <button className="btn p" style={{ width: "100%", marginTop: 14 }} onClick={commitParsed}>
                    Import selected
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* BULK SEND SHEET */}
      {sheet === "bulk" && (
        <div className="ov" onClick={(e) => e.target === e.currentTarget && (bulkQueue.length === 0 && setSheet(null))}>
          <div className="sheet">
            <div className="shead">
              <h2>
                {bulkQueue.length === 0
                  ? `Send to ${selected.size}`
                  : `Sending ${Math.min(bulkIdx + 1, bulkQueue.length)} / ${bulkQueue.length}`}
              </h2>
              <button
                className="x"
                onClick={() => {
                  setSheet(null);
                  setBulkQueue([]);
                  setBulkIdx(0);
                }}
              >
                ✕
              </button>
            </div>
            <div className="sbody">
              {bulkQueue.length === 0 ? (
                <>
                  <div className="hint" style={{ marginTop: 0 }}>
                    WhatsApp opens one chat at a time. Pick a template — each chat opens pre-filled, you tap Send, then come back here for the next person.
                  </div>
                  {templates.map((t) => (
                    <div
                      className="tplpick"
                      key={t.id}
                      onClick={() => {
                        const targets = pilgrims.filter((p) => selected.has(p.id));
                        const queue = targets
                          .map((p) => ({
                            p,
                            msg: fillTemplate(t.body, {
                              name: p.name,
                              hotel: p.hotel,
                              room: p.room,
                              bus: p.bus,
                              group: p.grp,
                              notes: p.notes,
                            }),
                          }))
                          .filter((x) => normPhone(x.p.phone, cc));
                        if (!queue.length) return flash("No valid numbers in selection");
                        setBulkQueue(queue);
                        setBulkIdx(0);
                      }}
                    >
                      <div className="tt">{t.title}</div>
                      <div className="tx">{t.body.slice(0, 160)}</div>
                    </div>
                  ))}
                  <div className="fld" style={{ marginTop: 8 }}>
                    <label>Or write a custom message (same for everyone — placeholders fill per person)</label>
                    <textarea
                      style={{ minHeight: 90 }}
                      value={waCustom}
                      onChange={(e) => setWaCustom(e.target.value)}
                      placeholder="Assalam o Alaikum {name}, ..."
                    />
                  </div>
                  <button
                    className="btn wa"
                    style={{ marginTop: 10 }}
                    onClick={() => {
                      if (!waCustom.trim()) return flash("Write a message first");
                      const targets = pilgrims.filter((p) => selected.has(p.id));
                      const queue = targets
                        .map((p) => ({
                          p,
                          msg: fillTemplate(waCustom.trim(), {
                            name: p.name,
                            hotel: p.hotel,
                            room: p.room,
                            bus: p.bus,
                            group: p.grp,
                            notes: p.notes,
                          }),
                        }))
                        .filter((x) => normPhone(x.p.phone, cc));
                      if (!queue.length) return flash("No valid numbers in selection");
                      setBulkQueue(queue);
                      setBulkIdx(0);
                    }}
                  >
                    Start with custom message →
                  </button>
                </>
              ) : bulkIdx >= bulkQueue.length ? (
                <>
                  <div className="note" style={{ background: "#e8f5ee", borderColor: "#b9dec7", color: "#164e36" }}>
                    All {bulkQueue.length} chats opened. Done.
                  </div>
                  <button
                    className="btn p"
                    style={{ width: "100%" }}
                    onClick={() => {
                      setSheet(null);
                      setBulkQueue([]);
                      setBulkIdx(0);
                      setSelected(new Set());
                      setSelectMode(false);
                    }}
                  >
                    Close
                  </button>
                </>
              ) : (
                <>
                  <div className="tpl">
                    <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
                      {bulkQueue[bulkIdx].p.name || "Unnamed"}
                    </div>
                    <div className="sub" style={{ marginBottom: 8 }}>
                      +{normPhone(bulkQueue[bulkIdx].p.phone, cc)}
                    </div>
                    <textarea
                      value={bulkQueue[bulkIdx].msg}
                      readOnly
                      style={{ minHeight: 110, background: "var(--paper)" }}
                    />
                  </div>
                  <button
                    className="btn wa"
                    onClick={() => {
                      const cur = bulkQueue[bulkIdx];
                      const n = normPhone(cur.p.phone, cc);
                      window.open("https://wa.me/" + n + "?text=" + encodeURIComponent(cur.msg), "_blank");
                      setBulkIdx((i) => i + 1);
                    }}
                  >
                    Open WhatsApp → Next
                  </button>
                  <div className="acts" style={{ marginTop: 8 }}>
                    <button className="btn g sm" onClick={() => setBulkIdx((i) => i + 1)}>
                      Skip
                    </button>
                    <button
                      className="btn g sm"
                      onClick={() => {
                        setBulkQueue([]);
                        setBulkIdx(0);
                        setSheet(null);
                      }}
                    >
                      Stop
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* BULK EDIT SHEET */}
      {sheet === "bulkedit" && (
        <div className="ov" onClick={(e) => e.target === e.currentTarget && setSheet(null)}>
          <div className="sheet">
            <div className="shead">
              <h2>Edit {selected.size}</h2>
              <button className="x" onClick={() => setSheet(null)}>
                ✕
              </button>
            </div>
            <div className="sbody">
              <div className="hint" style={{ marginTop: 0 }}>
                Fill any field to apply to all selected. <b>Blank fields are left alone.</b>
              </div>
              <div className="grid">
                <div className="fld">
                  <label>Hotel</label>
                  <input
                    value={bulkEdit.hotel}
                    placeholder="e.g. Swissotel Makkah"
                    onChange={(e) => setBulkEdit({ ...bulkEdit, hotel: e.target.value })}
                  />
                </div>
                <div className="fld">
                  <label>Room</label>
                  <input
                    value={bulkEdit.room}
                    onChange={(e) => setBulkEdit({ ...bulkEdit, room: e.target.value })}
                  />
                </div>
                <div className="fld">
                  <label>Bus</label>
                  <input
                    value={bulkEdit.bus}
                    onChange={(e) => setBulkEdit({ ...bulkEdit, bus: e.target.value })}
                  />
                </div>
                <div className="fld">
                  <label>Group</label>
                  <input
                    value={bulkEdit.grp}
                    onChange={(e) => setBulkEdit({ ...bulkEdit, grp: e.target.value })}
                  />
                </div>
                <div className="fld">
                  <label>Check-in</label>
                  <input
                    type="date"
                    value={bulkEdit.checkin_at}
                    onChange={(e) => setBulkEdit({ ...bulkEdit, checkin_at: e.target.value })}
                  />
                  <button
                    className="btn g sm"
                    style={{ width: "100%", marginTop: 6, fontSize: 12 }}
                    onClick={() => setBulkEdit({ ...bulkEdit, checkin_at: today() })}
                  >
                    Today
                  </button>
                </div>
                <div className="fld">
                  <label>Check-out</label>
                  <input
                    type="date"
                    value={bulkEdit.checkout_at}
                    onChange={(e) => setBulkEdit({ ...bulkEdit, checkout_at: e.target.value })}
                  />
                  <button
                    className="btn g sm"
                    style={{ width: "100%", marginTop: 6, fontSize: 12 }}
                    onClick={() => setBulkEdit({ ...bulkEdit, checkout_at: today() })}
                  >
                    Today
                  </button>
                </div>
              </div>
              <button className="btn p" style={{ width: "100%", marginTop: 14 }} onClick={applyBulkEdit}>
                Apply to {selected.size}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* WHATSAPP SHEET */}
      {sheet === "wa" && waTarget && (
        <div className="ov" onClick={(e) => e.target === e.currentTarget && setSheet(null)}>
          <div className="sheet">
            <div className="shead">
              <h2>Message {waTarget.name}</h2>
              <button className="x" onClick={() => setSheet(null)}>
                ✕
              </button>
            </div>
            <div className="sbody">
              <div className="hint" style={{ marginTop: 0 }}>
                Pick a quick message (auto-filled for this person):
              </div>
              {templates.map((t) => (
                <div
                  className="tplpick"
                  key={t.id}
                  onClick={() =>
                    go(
                      waTarget,
                      fillTemplate(t.body, {
                        name: waTarget.name,
                        hotel: waTarget.hotel,
                        room: waTarget.room,
                        bus: waTarget.bus,
                        group: waTarget.grp,
                        notes: waTarget.notes,
                      })
                    )
                  }
                >
                  <div className="tt">{t.title}</div>
                  <div className="tx">
                    {fillTemplate(t.body, {
                      name: waTarget.name,
                      hotel: waTarget.hotel,
                      room: waTarget.room,
                      bus: waTarget.bus,
                      group: waTarget.grp,
                      notes: waTarget.notes,
                    }).slice(0, 160)}
                  </div>
                </div>
              ))}
              <div className="fld" style={{ marginTop: 6 }}>
                <label>Or write a custom message</label>
                <textarea
                  style={{ minHeight: 90 }}
                  value={waCustom}
                  onChange={(e) => setWaCustom(e.target.value)}
                  placeholder="Type a message…"
                />
              </div>
              <button
                className="btn wa"
                style={{ marginTop: 10 }}
                onClick={() => (waCustom.trim() ? go(waTarget, waCustom.trim()) : flash("Write a message first"))}
              >
                Open in WhatsApp →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SETTINGS SHEET */}
      {sheet === "set" && (
        <div className="ov" onClick={(e) => e.target === e.currentTarget && setSheet(null)}>
          <div className="sheet">
            <div className="shead">
              <h2>Settings &amp; data</h2>
              <button className="x" onClick={() => setSheet(null)}>
                ✕
              </button>
            </div>
            <div className="sbody">
              <div className="fld" style={{ marginBottom: 6 }}>
                <label>Default country code (no +)</label>
                <input
                  inputMode="numeric"
                  defaultValue={cc}
                  style={{ maxWidth: 140 }}
                  onBlur={(e) => saveCc(e.target.value)}
                />
              </div>
              <div className="hint">
                Local numbers like <code>0300…</code> become <code>+&lt;code&gt; 300…</code>. Pakistan = 92, Saudi = 966.
              </div>

              <h2 style={{ fontFamily: "Fraunces", fontSize: 16, margin: "18px 0 4px" }}>Message templates</h2>
              <div className="hint">Placeholders auto-fill per person:</div>
              <div className="chips">
                {["{name}", "{hotel}", "{room}", "{bus}", "{group}", "{notes}"].map((c) => (
                  <span className="chip" key={c}>
                    {c}
                  </span>
                ))}
              </div>
              {templates.map((t) => (
                <div className="tpl" key={t.id}>
                  <input defaultValue={t.title} onBlur={(e) => e.target.value !== t.title && tplPatch(t.id, "title", e.target.value)} />
                  <textarea defaultValue={t.body} onBlur={(e) => e.target.value !== t.body && tplPatch(t.id, "body", e.target.value)} />
                  <button className="danger" style={{ marginTop: 2 }} onClick={() => tplDel(t.id)}>
                    Remove
                  </button>
                </div>
              ))}
              <button className="btn g sm" style={{ width: "100%", marginTop: 4 }} onClick={tplAdd}>
                ＋ Add template
              </button>

              <h2 style={{ fontFamily: "Fraunces", fontSize: 16, margin: "22px 0 8px" }}>Backup</h2>
              <div className="note">
                Data lives in Supabase (synced for your whole team). Export a snapshot before big changes.
              </div>
              <div className="acts">
                <button className="btn g sm" onClick={expJson}>
                  Export backup
                </button>
                <button className="btn g sm" onClick={expCsv}>
                  Export CSV
                </button>
              </div>
              <input type="file" accept="application/json" onChange={impJson} style={{ fontSize: 13, marginTop: 12, width: "100%" }} />
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast show">{toast}</div>}
    </>
  );
}
