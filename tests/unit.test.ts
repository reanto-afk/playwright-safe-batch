import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BusinessError, TransientError } from "../src/errors.js";
import { csvCell, toCsv } from "../src/report.js";
import { backoffMs, createThrottle, withRetry } from "../src/retry.js";
import { Checkpoint, Snapshots } from "../src/store.js";

const noSleep = async () => {};

describe("withRetry", () => {
  it("repete erro transitório e devolve o resultado", async () => {
    let calls = 0;
    const waits: number[] = [];
    const out = await withRetry(async () => {
      if (++calls < 3) throw new TransientError("503");
      return "ok";
    }, { attempts: 4, baseMs: 100, maxMs: 1000, random: () => 1, sleep: async (ms) => { waits.push(ms); } });
    expect(out).toBe("ok");
    expect(waits).toEqual([100, 200]);
  });

  it("não repete erro de negócio", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new BusinessError("travado", "locked"); },
      { attempts: 5, baseMs: 1, maxMs: 1, sleep: noSleep })).rejects.toBeInstanceOf(BusinessError);
    expect(calls).toBe(1);
  });

  it("desiste depois do limite", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new TransientError("503"); },
      { attempts: 3, baseMs: 1, maxMs: 1, sleep: noSleep })).rejects.toBeInstanceOf(TransientError);
    expect(calls).toBe(3);
  });

  it("respeita Retry-After e o teto", () => {
    expect(backoffMs(1, { baseMs: 100, maxMs: 5000 }, 1000)).toBe(1000);
    expect(backoffMs(1, { baseMs: 100, maxMs: 500 }, 9000)).toBe(500);
    expect(backoffMs(10, { baseMs: 100, maxMs: 800, random: () => 1 })).toBe(800);
    expect(backoffMs(2, { baseMs: 100, maxMs: 800, random: () => 0 })).toBe(100); // jitter: metade do exponencial
  });
});

describe("throttle", () => {
  it("garante intervalo mínimo entre ações", async () => {
    let now = 0;
    const waits: number[] = [];
    const t = createThrottle(150, () => now, async (ms) => { waits.push(ms); now += ms; });
    await t();
    now += 50;
    await t();
    now += 500;
    await t();
    expect(waits).toEqual([100]);
  });
});

describe("checkpoint e snapshot", () => {
  it("lembra o que foi feito entre execuções; falha não conta como feito", () => {
    const dir = mkdtempSync(join(tmpdir(), "psb-"));
    const a = new Checkpoint(join(dir, "c.jsonl"));
    a.record({ key: "p1:i1", status: "done" });
    a.record({ key: "p2:i1", status: "failed", detail: "travado" });
    const b = new Checkpoint(join(dir, "c.jsonl"));
    expect(b.isDone("p1:i1")).toBe(true);
    expect(b.isDone("p2:i1")).toBe(false);
    b.record({ key: "p2:i1", status: "done" });
    expect(new Checkpoint(join(dir, "c.jsonl")).isDone("p2:i1")).toBe(true);
  });

  it("o estado original é o primeiro snapshot de cada item", () => {
    const s = new Snapshots(join(mkdtempSync(join(tmpdir(), "psb-")), "s.jsonl"));
    s.save({ key: "p1:i1", projectId: "p1", integrationId: "i1", before: "connected" });
    s.save({ key: "p1:i1", projectId: "p1", integrationId: "i1", before: "disconnected" });
    expect(s.originals()).toEqual([expect.objectContaining({ key: "p1:i1", before: "connected" })]);
  });
});

describe("relatório CSV", () => {
  it("escapa vírgula e aspas e neutraliza fórmula", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(toCsv([{ key: "k", projectId: "p", integrationId: "i", outcome: "done", via: "api" }]))
      .toBe("key,projectId,integrationId,outcome,via,detail,evidence\nk,p,i,done,api,,\n");
  });
});
