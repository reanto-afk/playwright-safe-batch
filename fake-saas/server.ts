/**
 * Mini-SaaS falso para a demo e os testes: login com sessão, telas HTML e a API interna
 * (`POST /rpc`) que o próprio front usaria. Dados 100% sintéticos.
 *
 * Caos configurável: erro 5xx aleatório (com semente), 429 a cada N chamadas, projetos travados
 * (erro de negócio 409) e o método de desconectar desligado na API (força o caminho pela tela).
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

export type IntegrationType = "slack" | "email" | "webhook" | "legacy-ftp";
export interface Integration { id: string; type: IntegrationType; status: "connected" | "disconnected" }
export interface Project { id: string; name: string; integrations: Integration[] }

export interface FakeOptions {
  projects?: number;
  seed?: number;
  failRate?: number;        // 0..1: chance de 503 em métodos que mudam dados
  rateLimitEvery?: number;  // a cada N chamadas ao /rpc, uma 429 com Retry-After: 1
  lockedEvery?: number;     // projetos com número múltiplo de N recusam mudança (409 locked)
  rpcDisconnect?: boolean;  // false: integration.disconnect responde 501 (só pela tela)
  user?: string;
  password?: string;
}

const TYPES: IntegrationType[] = ["slack", "email", "webhook", "legacy-ftp"];

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function seedProjects(n: number, seed: number): Project[] {
  const rnd = prng(seed);
  return Array.from({ length: n }, (_, i) => {
    const id = `p${String(i + 1).padStart(3, "0")}`;
    const integrations = TYPES.filter(() => rnd() < 0.5).map((type, j) => ({
      id: `${id}-i${j + 1}`, type, status: (rnd() < 0.85 ? "connected" : "disconnected") as Integration["status"],
    }));
    return { id, name: `Projeto ${String(i + 1).padStart(3, "0")}`, integrations };
  });
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.3rem .6rem}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;

export function createApp(opts: FakeOptions = {}) {
  const o = { projects: 200, seed: 42, failRate: 0, rateLimitEvery: 0, lockedEvery: 0, rpcDisconnect: true,
    user: "demo", password: "demo", ...opts };
  let projects = seedProjects(o.projects, o.seed);
  const sessions = new Set<string>();
  const chaos = prng(o.seed + 1);
  const stats = { rpcCalls: 0, mutations: 0, uiMutations: 0 };

  const find = (id: string) => projects.find((p) => p.id === id);
  const isLocked = (p: Project) => o.lockedEvery > 0 && Number(p.id.slice(1)) % o.lockedEvery === 0;

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  const sid = (req: Request) => /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const auth = (req: Request, res: Response, next: NextFunction) => {
    const s = sid(req);
    if (s && sessions.has(s)) return next();
    if (req.path === "/rpc") return res.status(401).json({ error: { code: "unauthenticated", message: "faça login" } });
    return res.redirect("/login");
  };

  app.get("/login", (_req, res) => {
    res.send(page("Entrar", `<form method="post" action="/login">
<label>Usuário <input name="username" autocomplete="username"></label>
<label>Senha <input name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Entrar</button></form>`));
  });
  app.post("/login", (req, res) => {
    if (req.body.username !== o.user || req.body.password !== o.password) {
      return res.status(401).send(page("Entrar", `<p role="alert">Usuário ou senha inválidos</p><a href="/login">voltar</a>`));
    }
    const s = randomUUID();
    sessions.add(s);
    res.setHeader("Set-Cookie", `sid=${s}; HttpOnly; Path=/; SameSite=Lax`);
    res.redirect("/projects");
  });

  // rotas de teste (estado do servidor falso)
  app.post("/__reset", (_req, res) => { projects = seedProjects(o.projects, o.seed); Object.assign(stats, { rpcCalls: 0, mutations: 0, uiMutations: 0 }); res.json({ ok: true }); });
  app.post("/__expire-sessions", (_req, res) => { sessions.clear(); res.json({ ok: true }); });
  app.get("/__stats", (_req, res) => res.json(stats));

  app.use(auth);

  app.get("/projects", (req, res) => {
    const n = Math.max(1, Number(req.query.page ?? 1));
    const rows = projects.slice((n - 1) * 20, n * 20)
      .map((p) => `<tr><td><a href="/projects/${p.id}">${p.name}</a></td><td>${p.integrations.length}</td></tr>`).join("");
    res.send(page("Projetos", `<table><tr><th>Projeto</th><th>Integrações</th></tr>${rows}</table>
<p><a href="/projects?page=${n + 1}">próxima página</a></p>`));
  });

  app.get("/projects/:id", (req, res) => {
    const p = find(req.params.id);
    if (!p) return res.status(404).send(page("Não encontrado", ""));
    const rows = p.integrations.map((i) => `<tr data-testid="integration-${i.id}"><td>${i.type}</td>
<td class="status">${i.status === "connected" ? "conectada" : "desconectada"}</td>
<td>${i.status === "connected" ? `<a role="button" href="/projects/${p.id}/integrations/${i.id}/disconnect">Desconectar</a>` : ""}</td></tr>`).join("");
    res.send(page(p.name, `<table><tr><th>Tipo</th><th>Status</th><th></th></tr>${rows}</table>`));
  });

  // desconectar pela tela: pede confirmação antes (como num sistema real)
  app.get("/projects/:id/integrations/:iid/disconnect", (req, res) => {
    res.send(page("Confirmar", `<p>Desconectar a integração ${req.params.iid}?</p>
<form method="post"><button type="submit">Confirmar</button></form>`));
  });
  app.post("/projects/:id/integrations/:iid/disconnect", (req, res) => {
    const p = find(req.params.id);
    const i = p?.integrations.find((x) => x.id === req.params.iid);
    if (!p || !i) return res.status(404).send(page("Não encontrado", ""));
    if (isLocked(p)) return res.status(409).send(page("Erro", `<p role="alert">Projeto travado para alterações</p>`));
    i.status = "disconnected";
    stats.uiMutations++;
    res.redirect(`/projects/${p.id}`);
  });

  app.post("/rpc", (req, res) => {
    stats.rpcCalls++;
    const { method, params = {} } = req.body ?? {};
    const fail = (status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });
    if (o.rateLimitEvery > 0 && stats.rpcCalls % o.rateLimitEvery === 0) {
      res.setHeader("Retry-After", "1");
      return fail(429, "rate_limited", "muitas requisições");
    }
    const mutating = method === "integration.disconnect" || method === "integration.connect";
    if (mutating && chaos() < o.failRate) return fail(503, "unavailable", "instabilidade temporária");

    switch (method) {
      case "projects.list": {
        const size = Math.min(100, Number(params.pageSize ?? 50));
        const n = Math.max(1, Number(params.page ?? 1));
        return res.json({ result: { total: projects.length, items: projects.slice((n - 1) * size, n * size).map(({ id, name }) => ({ id, name })) } });
      }
      case "project.get": {
        const p = find(params.id);
        return p ? res.json({ result: p }) : fail(404, "not_found", "projeto não existe");
      }
      case "integration.disconnect":
      case "integration.connect": {
        if (method === "integration.disconnect" && !o.rpcDisconnect) return fail(501, "not_implemented", "use a tela");
        const p = find(params.projectId);
        const i = p?.integrations.find((x) => x.id === params.integrationId);
        if (!p || !i) return fail(404, "not_found", "integração não existe");
        if (isLocked(p)) return fail(409, "locked", "projeto travado para alterações");
        const target = method === "integration.disconnect" ? "disconnected" : "connected";
        const changed = i.status !== target;
        i.status = target;
        if (changed) stats.mutations++;
        return res.json({ result: { changed, integration: i } });
      }
      default:
        return fail(400, "unknown_method", `método desconhecido: ${method}`);
    }
  });

  return app;
}

export async function startServer(opts: FakeOptions = {}, port = 0) {
  const server = createApp(opts).listen(port, "127.0.0.1"); // só local: é um servidor de demo
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const env = process.env;
  const { url } = await startServer({
    failRate: Number(env.FAKE_FAIL_RATE ?? 0.1),
    rateLimitEvery: Number(env.FAKE_RATE_LIMIT_EVERY ?? 25),
    lockedEvery: Number(env.FAKE_LOCKED_EVERY ?? 37),
    rpcDisconnect: env.FAKE_RPC_DISCONNECT !== "off",
  }, Number(env.PORT ?? 3000));
  console.log(`mini-SaaS falso em ${url} (usuário demo / senha demo)`);
}
