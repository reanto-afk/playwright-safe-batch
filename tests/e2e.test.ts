/** Ponta a ponta: Chromium de verdade contra o mini-SaaS falso, com caos ligado. */
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BatchAborted, plan, rollback, run, summarize, type Target } from "../src/batch.js";
import type { RpcClient } from "../src/client.js";
import { AuthError } from "../src/errors.js";
import { withRetry, type RetryOptions } from "../src/retry.js";
import { openSession } from "../src/session.js";
import { Checkpoint, Snapshots } from "../src/store.js";
import { startServer, type FakeOptions } from "../fake-saas/server.js";

const retry: RetryOptions = { attempts: 6, baseMs: 5, maxMs: 50, sleep: async () => {} };
const throttle = async () => {};
let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function setup(opts: FakeOptions = {}) {
  const server = await startServer({ projects: 40, ...opts });
  const dir = mkdtempSync(join(tmpdir(), "psb-e2e-"));
  const session = await openSession({ baseUrl: server.url, username: "demo", password: "demo", statePath: join(dir, "state.json") });
  cleanup.push(server.close, session.close);
  const stats = async () => (await (await fetch(`${server.url}/__stats`)).json()) as { mutations: number; uiMutations: number };
  const runOpts = (extra: Partial<Parameters<typeof run>[1]> = {}) => ({
    client: session.client, page: session.page, baseUrl: server.url, dryRun: false, retry, throttle,
    checkpoint: new Checkpoint(join(dir, "checkpoint.jsonl")), snapshots: new Snapshots(join(dir, "snapshots.jsonl")),
    evidenceDir: join(dir, "evidence"), ...extra,
  });
  return { server, dir, session, stats, runOpts };
}

async function statusOf(client: RpcClient, t: Target) {
  return (await withRetry(() => client.getProject(t.projectId), retry)).integrations.find((i) => i.id === t.integrationId)?.status;
}

describe("lote ponta a ponta", () => {
  it("plano → simulação → execução com caos → reexecução idempotente → rollback", async () => {
    const { session, stats, runOpts, dir } = await setup({ failRate: 0.3, rateLimitEvery: 7, lockedEvery: 9 });
    const targets = await plan(session.client, "legacy-ftp", retry);
    expect(targets.length).toBeGreaterThan(5);

    const dry = await run(targets, runOpts({ dryRun: true }));
    expect(summarize(dry).would_change).toBe(targets.length - dry.filter((r) => r.outcome === "failed").length);
    expect((await stats()).mutations).toBe(0); // simulação não muda nada

    const locked = new Set(targets.filter((t) => Number(t.projectId.slice(1)) % 9 === 0).map((t) => t.key));
    const free = targets.length - locked.size;

    // 1ª execução: travados falham por regra de negócio (com evidência); o resto é feito ou,
    // se o caos esgotar as tentativas, fica como falha transitória para a próxima execução
    const first = await run(targets, runOpts());
    const failed = first.filter((r) => r.outcome === "failed");
    const business = failed.filter((r) => locked.has(r.key));
    expect(business).toHaveLength(locked.size);
    expect(business.every((r) => r.detail?.includes("travado") && r.evidence)).toBe(true);
    expect(failed.filter((r) => !locked.has(r.key)).every((r) => /HTTP (429|503)/.test(r.detail ?? ""))).toBe(true);
    expect(readdirSync(join(dir, "evidence")).some((f) => f.endsWith(".json"))).toBe(true); // erro da API: resposta em JSON

    // 2ª execução: pula o que foi feito e completa o que ficou por instabilidade
    const c2 = summarize(await run(targets, runOpts()));
    expect(c2.skipped).toBe(summarize(first).done);
    expect(c2.skipped + c2.done).toBe(free);
    expect(c2.failed).toBe(locked.size);

    // 3ª execução: nada a mudar além dos travados
    const before = (await stats()).mutations;
    expect(summarize(await run(targets, runOpts())).skipped).toBe(free);
    expect((await stats()).mutations).toBe(before);

    // rollback também é idempotente: uma 2ª rodada completa o que o caos deixou para trás
    const back1 = summarize(await rollback({ ...runOpts(), maxItems: undefined }));
    const back2 = summarize(await rollback({ ...runOpts(), maxItems: undefined }));
    expect(back1.done + back2.done).toBe(free);
    expect(back2.failed).toBe(0);
    for (const t of targets) expect(await statusOf(session.client, t)).toBe("connected");

    // depois do rollback, o checkpoint não impede refazer
    expect(summarize(await run(targets, runOpts())).skipped).toBe(0);
  }, 120_000);

  it("--max limita o lote e a próxima execução continua de onde parou", async () => {
    const { session, runOpts } = await setup();
    const targets = await plan(session.client, "legacy-ftp", retry);
    const opts = runOpts({ maxItems: 3 });
    expect(summarize(await run(targets, opts)).done).toBe(3);
    const next = summarize(await run(targets, runOpts({ checkpoint: opts.checkpoint, maxItems: 3 })));
    expect(next.skipped).toBe(3);
    expect(next.done).toBe(3);
  }, 60_000);

  it("pela tela, erro de negócio deixa print e HTML como evidência", async () => {
    const { session, runOpts, dir } = await setup({ rpcDisconnect: false, lockedEvery: 1 });
    const [target] = await plan(session.client, "legacy-ftp", retry);
    const [result] = await run([target!], runOpts());
    expect(result).toMatchObject({ outcome: "failed", via: "ui" });
    expect(result!.detail).toContain("travado");
    const files = readdirSync(join(dir, "evidence"));
    expect(files.some((f) => f.endsWith(".png")) && files.some((f) => f.endsWith(".html"))).toBe(true);
  }, 60_000);

  it("API sem a operação (501): faz pela tela, com confirmação e conferência", async () => {
    const { session, stats, runOpts } = await setup({ rpcDisconnect: false });
    const targets = (await plan(session.client, "legacy-ftp", retry)).slice(0, 3);
    const results = await run(targets, runOpts());
    expect(results.map((r) => [r.outcome, r.via])).toEqual(targets.map(() => ["done", "ui"]));
    expect((await stats()).uiMutations).toBe(3);
    for (const t of targets) expect(await statusOf(session.client, t)).toBe("disconnected");
  }, 60_000);

  it("sessão vencida no meio do lote: faz login de novo e segue", async () => {
    const { server, session, runOpts } = await setup();
    const targets = (await plan(session.client, "legacy-ftp", retry)).slice(0, 2);
    await fetch(`${server.url}/__expire-sessions`, { method: "POST" });
    expect(summarize(await run(targets, runOpts())).done).toBe(2);
  }, 60_000);

  it("sistema alvo fora do ar: para o lote depois de N falhas transitórias seguidas", async () => {
    const { session, runOpts } = await setup({ failRate: 1 });
    const targets = await plan(session.client, "legacy-ftp", retry);
    const error = await run(targets, runOpts({ maxConsecutiveFailures: 3 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BatchAborted);
    expect((error as BatchAborted).results).toHaveLength(3);
  }, 60_000);

  it("senha errada: erro de sessão claro, sem tentar de novo", async () => {
    const server = await startServer({ projects: 5 });
    cleanup.push(server.close);
    const dir = mkdtempSync(join(tmpdir(), "psb-e2e-"));
    await expect(openSession({ baseUrl: server.url, username: "demo", password: "errada", statePath: join(dir, "s.json") }))
      .rejects.toBeInstanceOf(AuthError);
  }, 60_000);
});

