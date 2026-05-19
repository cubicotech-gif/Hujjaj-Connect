// Normalise any messy number into a bare international form for wa.me
export function normPhone(raw: string, cc: string): string {
  if (!raw) return "";
  const plus = String(raw).trim().startsWith("+");
  let d = String(raw).replace(/[^\d]/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  else if (plus) { /* already international */ }
  else if (d.startsWith("0")) d = cc + d.replace(/^0+/, "");
  else if (!d.startsWith(cc)) d = cc + d;
  return d;
}
export function fillTemplate(body: string, p: Record<string, string>): string {
  return body.replace(/\{(\w+)\}/g, (_m, k: string) => (p[k] != null ? p[k] : ""));
}
