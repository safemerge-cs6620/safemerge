const BASE = "http://127.0.0.1:3000";

export async function waitHealthy(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("scanner not healthy");
}

export const scanner = {
  async scanCode(code) {
    const r = await fetch(`${BASE}/scan/code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    if (!r.ok) throw new Error(`scanner ${r.status}`);
    return r.json();
  },
};
