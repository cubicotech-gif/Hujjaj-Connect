"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { normPhone, fillTemplate } from "@/lib/phone";
import type { Pilgrim, Template } from "@/lib/types";

type ParsedRow = { sel: boolean; name: string; phone: string; extra: string };

const supabase = createClient();

function parseLines(txt: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  txt.split(/\r?\n/).forEach((line) => {
    let s = line.trim();
    if (!s) return;
    s = s.replace(/^\s*\d{1,3}[.)\-]\s*/, "");
    const m = s.match(/(\+?\d[\d\s\-()]{6,}\d)/);
    if (!m || m.index == null) return;
    const phone = m[1].trim();
    let name = s.slice(0, m.index).replace(/[,|;\-–]+$/, "").trim();
    let rest = s.slice(m.index + m[0].length).replace(/^[\s,|;\-–]+/, "").trim();
    if (!name && rest) {
      name = rest;
      rest = "";
    }
    out.push({ sel: true, name: name || "(no name)", phone, extra: rest });
  });
  return out;
}

export default function HujjajApp() {
  const [loading, setLoading] = useState(true);
  const [pilgrims, setPilgrims] = useState<Pilgrim[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [cc, setCc] = useState("92");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [sheet, setSheet] = useState<null | "add" | "set" | "wa">(null);
  const [waTarget, setWaTarget] = useState<Pilgrim | null>(null);
  const [tab, setTab] = useState<"paste" | "file" | "one">("paste");
  const [bulk, setBulk] = useState("");
  const [parsed, setParsed] = useState<ParsedRow[]>([]);
  const [fileStatus, setFileStatus] = useState("");
  const [one, setOne] = useState({ name: "", phone: "", bus: "", grp: "" });
  const [waCustom, setWaCustom] = useState("");
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

  async function patch(id: string, field: keyof Pilgrim, value: string) {
    setPilgrims((cur) => cur.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
    await supabase.from("pilgrims").update({ [field]: value }).eq("id", id);
  }
  async function del(p: Pilgrim) {
    if (!confirm("Delete " + (p.name || "this person") + "?")) return;
    await supabase.from("pilgrims").delete().eq("id", p.id);
    setPilgrims((cur) => cur.filter((x) => x.id !== p.id));
    flash("Deleted");
  }

  async function commitParsed() {
    const selected = parsed.filter((r) => r.sel && r.phone.trim());
    if (!selected.length) return flash("Nothing selected");
    const have = new Set(pilgrims.map((p) => normPhone(p.phone, cc)));
    const seen = new Set<string>();
    const rows: Omit<Pilgrim, "id">[] = [];
    for (const r of selected) {
      const n = normPhone(r.phone, cc);
      if (!n || have.has(n) || seen.has(n)) continue;
      seen.add(n);
      rows.push({
        name: r.name.trim(),
        phone: r.phone.trim(),
        notes: r.extra || "",
        bus: "",
        hotel: "",
        room: "",
        grp: "",
      });
    }
    if (!rows.length) return flash("All already exist");
    const { error } = await supabase.from("pilgrims").insert(rows);
    if (error) return flash("Import failed");
    setParsed([]);
    setBulk("");
    setSheet(null);
    const dupes = selected.length - rows.length;
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

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      if (f.type === "application/pdf") {
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
        setParsed(parseLines(txt));
        setTab("paste");
        setFileStatus("Extracted — review below.");
      } else if (f.type.startsWith("image/")) {
        setFileStatus("Loading OCR engine…");
        const Tesseract: any = await import("tesseract.js");
        setFileStatus("Reading image (can take a moment)…");
        const { data } = await Tesseract.recognize(f, "eng");
        const text = data.text || "";
        setBulk(text.trim());
        setParsed(parseLines(text));
        setTab("paste");
        setFileStatus("OCR done — check it carefully, it is not perfect.");
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
    const head = ["name", "phone", "intl", "bus", "hotel", "room", "group", "notes"];
    const rows = pilgrims.map((p) =>
      [p.name, p.phone, "+" + normPhone(p.phone, cc), p.bus, p.hotel, p.room, p.grp, p.notes]
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
          <button className="icbtn" style={{ marginLeft: "auto" }} onClick={() => setSheet("set")} title="Settings">
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
              [p.bus && "Bus " + p.bus, p.hotel, p.room && "Rm " + p.room, p.grp]
                .filter(Boolean)
                .join(" · ") || p.phone || "no details";
            const open = openId === p.id;
            return (
              <div className={"row" + (open ? " open" : "")} key={p.id}>
                <div className="rhead" onClick={() => setOpenId(open ? null : p.id)}>
                  <div className="av">{ini}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="rname">{p.name || "Unnamed"}</div>
                    <div className="rmeta">{meta}</div>
                  </div>
                  <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="m9 6 6 6-6 6" />
                  </svg>
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

      <button className="fab" onClick={() => { setParsed([]); setSheet("add"); }}>
        ＋ Add hujjaj
      </button>

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
                  <button className="btn p sm" style={{ marginTop: 10 }} onClick={() => setParsed(parseLines(bulk))}>
                    Parse list
                  </button>
                </>
              )}

              {tab === "file" && (
                <>
                  <div className="hint">
                    <b>PDF with real text</b> extracts cleanly. A photo/scan uses on-device OCR (slower, review carefully).
                  </div>
                  <input type="file" accept="application/pdf,image/*" onChange={onFile} style={{ fontSize: 13, width: "100%" }} />
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
                      <div className="pitem" key={i}>
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
                          value={r.name}
                          onChange={(e) =>
                            setParsed(parsed.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                          }
                        />
                        <input
                          type="text"
                          value={r.phone}
                          inputMode="tel"
                          style={{ maxWidth: 140 }}
                          onChange={(e) =>
                            setParsed(parsed.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))
                          }
                        />
                      </div>
                    ))}
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
