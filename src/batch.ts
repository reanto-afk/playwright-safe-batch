/**
 * O lote: planejar → simular → executar → (se preciso) desfazer.
 *
 * Por item: pula o que o checkpoint já marcou; lê o estado atual (não muda o que já está certo);
 * guarda snapshot; muda pela API (ou pela tela se a API não oferece); confere depois de mudar.
 * Erro de negócio registra e segue; erro transitório tenta de novo; muitos transitórios seguidos
 * param o lote (o sistema alvo provavelmente está com problema); erro de sessão para na hora.
 */
import type { Page } from "playwright";
import type { RpcClient } from "./client.js";
import { AuthError, BusinessError, NotSupportedError, TransientError } from "./errors.js";
import { withRetry, type RetryOptions } from "./retry.js";
import type { Checkpoint, Snapshots } from "./store.js";
import { captureEvidence, disconnectViaUi, writeErrorEvidence } from "./ui.js";

export interface Target { key: string; projectId: string; projectName: string; integrationId: string; type: string }

export type Outcome = "done" | "unchanged" | "skipped" | "would_change" | "failed";
export interface ItemResult { key: string; projectId: string; integrationId: string; outcome: Outcome; via?: "api" | "ui"; detail?: string; evidence?: string }

export interface RunOptions {
  client: RpcClient;
  page?: Page;
  baseUrl: string;
  checkpoint: Checkpoint;
  snapshots: Snapshots;
  dryRun: boolean;
  maxItems?: number;
  via?: "api" | "ui";
  retry: RetryOptions;
  throttle: () => Promise<void>;
  evidenceDir: string;
  maxConsecutiveFailures?: number;
  log?: (line: string) => void;
}

export class BatchAborted extends Error {
  constructor(message: string, readonly results: ItemResult[]) {
    super(message);
    this.name = "BatchAborted";
  }
}

/** Lista o que precisa mudar. Só leitura. */
export async function plan(client: RpcClient, type: string, retry: RetryOptions, log = (_: string) => {}): Promise<Target[]> {
  const targets: Target[] = [];
  for (let page = 1; ; page++) {
    const { items, total } = await withRetry(() => client.listProjects(page, 50), retry);
    for (const summary of items) {
      const project = await withRetry(() => client.getProject(summary.id), retry);
      for (const i of project.integrations) {
        if (i.type === type && i.status === "connected") {
          targets.push({ key: `${project.id}:${i.id}`, projectId: project.id, projectName: project.name, integrationId: i.id, type });
        }
      }
    }
    log(`planejando: ${Math.min(page * 50, total)}/${total} projetos lidos, ${targets.length} alvo(s)`);
    if (page * 50 >= total || items.length === 0) break;
  }
  return targets;
}

export async function run(targets: Target[], o: RunOptions): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  const log = o.log ?? (() => {});
  const limit = o.maxItems ?? Infinity;
  const maxFails = o.maxConsecutiveFailures ?? 5;
  let processed = 0;
  let consecutiveTransient = 0;

  for (const t of targets) {
    const base = { key: t.key, projectId: t.projectId, integrationId: t.integrationId };
    if (o.checkpoint.isDone(t.key)) {
      results.push({ ...base, outcome: "skipped", detail: "já feito (checkpoint)" });
      continue;
    }
    if (processed >= limit) break;
    processed++;
    let via: "api" | "ui" = o.via ?? "api";

    try {
      const current = await withRetry(() => o.client.getProject(t.projectId), o.retry);
      const integration = current.integrations.find((i) => i.id === t.integrationId);
      if (!integration) throw new BusinessError("integração sumiu desde o plano", "not_found");
      if (integration.status === "disconnected") {
        if (!o.dryRun) o.checkpoint.record({ key: t.key, status: "done", detail: "já estava desconectada" });
        results.push({ ...base, outcome: "unchanged", detail: "já estava desconectada" });
        consecutiveTransient = 0;
        continue;
      }
      if (o.dryRun) {
        results.push({ ...base, outcome: "would_change", detail: "desconectaria" });
        continue;
      }

      await o.throttle();
      o.snapshots.save({ key: t.key, projectId: t.projectId, integrationId: t.integrationId, before: integration.status });

      if (via === "api") {
        try {
          await withRetry(() => o.client.disconnect(t.projectId, t.integrationId), o.retry);
        } catch (error) {
          if (!(error instanceof NotSupportedError) || !o.page) throw error;
          via = "ui"; // a API não oferece: segue pela tela
        }
      }
      if (via === "ui") {
        if (!o.page) throw new BusinessError("caminho pela tela pedido sem navegador", "no_page");
        const page = o.page;
        await withRetry(() => disconnectViaUi(page, o.baseUrl, t.projectId, t.integrationId), o.retry);
      }

      const after = await withRetry(() => o.client.getProject(t.projectId), o.retry);
      if (after.integrations.find((i) => i.id === t.integrationId)?.status !== "disconnected") {
        throw new BusinessError("conferência depois da mudança falhou", "verify_failed");
      }
      o.checkpoint.record({ key: t.key, status: "done", detail: `via ${via}` });
      results.push({ ...base, outcome: "done", via });
      consecutiveTransient = 0;
      log(`✓ ${t.key} desconectada (via ${via})`);
    } catch (error) {
      if (error instanceof AuthError) throw new BatchAborted(`sessão inválida: ${error.message}`, results);
      const detail = error instanceof Error ? error.message : String(error);
      const evidence = o.dryRun ? undefined
        : via === "ui" && o.page ? await captureEvidence(o.page, o.evidenceDir, t.key)
        : writeErrorEvidence(o.evidenceDir, t.key, error);
      if (!o.dryRun) o.checkpoint.record({ key: t.key, status: "failed", detail });
      results.push({ ...base, outcome: "failed", via: o.dryRun ? undefined : via, detail, evidence });
      log(`✗ ${t.key} ${detail}`);
      consecutiveTransient = error instanceof TransientError ? consecutiveTransient + 1 : 0;
      if (consecutiveTransient >= maxFails) {
        throw new BatchAborted(`${maxFails} falhas transitórias seguidas: o sistema alvo parece instável, lote parado`, results);
      }
    }
  }
  return results;
}

/** Volta ao estado original e marca no checkpoint, para uma nova execução refazer o item. */
export async function rollback(o: Pick<RunOptions, "client" | "snapshots" | "dryRun" | "maxItems" | "retry" | "throttle" | "log"> & { checkpoint?: Checkpoint }): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  const log = o.log ?? (() => {});
  let processed = 0;
  for (const s of o.snapshots.originals()) {
    if (processed >= (o.maxItems ?? Infinity)) break;
    const base = { key: s.key, projectId: s.projectId, integrationId: s.integrationId };
    try {
      const current = await withRetry(() => o.client.getProject(s.projectId), o.retry);
      const status = current.integrations.find((i) => i.id === s.integrationId)?.status;
      if (status === s.before) {
        results.push({ ...base, outcome: "unchanged", detail: "já está no estado original" });
        continue;
      }
      processed++;
      if (o.dryRun) {
        results.push({ ...base, outcome: "would_change", detail: `voltaria para ${s.before}` });
        continue;
      }
      await o.throttle();
      const call = s.before === "connected" ? o.client.connect.bind(o.client) : o.client.disconnect.bind(o.client);
      await withRetry(() => call(s.projectId, s.integrationId), o.retry);
      o.checkpoint?.record({ key: s.key, status: "rolled_back", detail: `voltou para ${s.before}` });
      results.push({ ...base, outcome: "done", via: "api", detail: `voltou para ${s.before}` });
      log(`↺ ${s.key} voltou para ${s.before}`);
    } catch (error) {
      if (error instanceof AuthError) throw new BatchAborted(`sessão inválida: ${error.message}`, results);
      results.push({ ...base, outcome: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export function summarize(results: ItemResult[]) {
  const count: Record<Outcome, number> = { done: 0, unchanged: 0, skipped: 0, would_change: 0, failed: 0 };
  for (const r of results) count[r.outcome]++;
  return count;
}
