/** ₹1,23,456.78 with Indian digit grouping. Paise are shown only when non-zero. */
export function formatInr(minor: number): string {
  const abs = Math.abs(Math.round(minor));
  const rupees = String(Math.floor(abs / 100));
  const paise = abs % 100;
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${minor < 0 ? "−" : ""}₹${rest ? `${rest},${last3}` : last3}${paise ? `.${String(paise).padStart(2, "0")}` : ""}`;
}

/** Local calendar parts of an instant in a time zone. */
export function localParts(d: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, month: `${p.year}-${p.month}`, hour: Number(p.hour) };
}
