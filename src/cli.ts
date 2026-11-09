/**
 * CLI: login · plan · run [--dry] [--max N] [--via api|ui] · rollback [--dry] [--max N]
 *
 * Ambiente: BASE_URL, SAAS_USER, SAAS_PASSWORD (use `node --env-file=.env`), STATE_DIR (padrão runs/),
 * HEADLESS=false para ver o navegador, TARGET_TYPE (padrão legacy-ftp), THROTTLE_MS (padrão 150).
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BatchAborted, plan, rollback, run, summarize, type ItemResult, type Target } from "./batch.js";
import { AuthError } from "./errors.js";
import { writeReport } from "./report.js";
import { createThrottle, type RetryOptions } from "./retry.js";
import { openSession } from "./session.js";
import { Checkpoint, readJson, Snapshots, writeJson } from "./store.js";

const env = process.env;
const baseUrl = (env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const stateDir = env.STATE_DIR ?? "runs";
const paths = {
  session: join(".auth", "storageState.json"),
  plan: join(stateDir, "plan.json"),
  checkpoint: join(stateDir, "checkpoint.jsonl"),
  snapshots: join(stateDir, "snapshots.jsonl"),
  evidence: join(stateDir, "evidence"),
};

const retry: RetryOptions = {
  attempts: 4, baseMs: 500, maxMs: 8000,
  onRetry: (e, n, ms) => console.log(`  ↻ tentativa ${n + 1} em ${ms} ms (${e.message})`),
};

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function printSummary(label: string, results: ItemResult[], reportPath?: string) {
  const c = summarize(results);
  console.log(`\n${label}: ${c.done} feito(s) · ${c.unchanged} já certo(s) · ${c.skipped} pulado(s) pelo checkpoint · ` +
    `${c.would_change} mudaria(m) · ${c.failed} falha(s)`);
  for (const r of results.filter((x) => x.outcome === "failed")) console.log(`  ✗ ${r.key}: ${r.detail}`);
  if (reportPath) console.log(`relatório: ${reportPath}`);
  return c.failed > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { dry: { type: "boolean", default: false }, max: { type: "string" }, via: { type: "string" } },
  });
  const command = positionals[0];
  if (!command || !["login", "plan", "run", "rollback"].includes(command)) {
    console.log("uso: batch <login | plan | run [--dry] [--max N] [--via api|ui] | rollback [--dry] [--max N]>");
    return 2;
  }
  const maxItems = values.max ? Number(values.max) : undefined;
  if (maxItems !== undefined && !(maxItems > 0)) throw new Error("--max precisa ser um número > 0");
  const via = values.via as "api" | "ui" | undefined;
  if (via && via !== "api" && via !== "ui") throw new Error("--via aceita api ou ui");
  if (!env.SAAS_USER || !env.SAAS_PASSWORD) throw new AuthError("defina SAAS_USER e SAAS_PASSWORD (ex.: node --env-file=.env)");

  const session = await openSession({
    baseUrl, username: env.SAAS_USER, password: env.SAAS_PASSWORD, statePath: paths.session, headless: env.HEADLESS !== "false",
  });
  try {
    if (command === "login") {
      await session.login();
      console.log(`sessão salva em ${paths.session} (fora do git)`);
      return 0;
    }
    if (command === "plan") {
      const targets = await plan(session.client, env.TARGET_TYPE ?? "legacy-ftp", retry, console.log);
      writeJson(paths.plan, { createdAt: new Date().toISOString(), baseUrl, targets });
      console.log(`\nplano: ${targets.length} integração(ões) para desconectar → ${paths.plan}`);
      console.log("próximo passo: batch run --dry");
      return 0;
    }
    const throttle = createThrottle(Number(env.THROTTLE_MS ?? 150));
    if (command === "run") {
      const { targets } = readJson<{ targets: Target[] }>(paths.plan);
      const results = await run(targets, {
        client: session.client, page: session.page, baseUrl, dryRun: values.dry ?? false, maxItems, via,
        checkpoint: new Checkpoint(paths.checkpoint), snapshots: new Snapshots(paths.snapshots),
        retry, throttle, evidenceDir: paths.evidence, log: console.log,
      });
      const report = join(stateDir, `report-${values.dry ? "dry-" : ""}${stamp()}.csv`);
      writeReport(report, results);
      return printSummary(values.dry ? "simulação (nada foi alterado)" : "execução", results, report);
    }
    const results = await rollback({
      client: session.client, snapshots: new Snapshots(paths.snapshots), checkpoint: new Checkpoint(paths.checkpoint),
      dryRun: values.dry ?? false,
      maxItems, retry, throttle, log: console.log,
    });
    const report = join(stateDir, `rollback-${values.dry ? "dry-" : ""}${stamp()}.csv`);
    writeReport(report, results);
    return printSummary(values.dry ? "rollback simulado" : "rollback", results, report);
  } finally {
    await session.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof BatchAborted) {
      printSummary("LOTE PARADO", error.results);
      console.error(`\n${error.message}. O checkpoint guarda o que já foi feito: rode de novo depois de resolver.`);
    } else {
      console.error(`erro: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(2);
  },
);
