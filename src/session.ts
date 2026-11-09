/**
 * Sessão: faz login pela tela uma vez, guarda o storageState (fora do git) e reaproveita nas
 * próximas execuções. Se a sessão vencer no meio do lote, o cliente chama `relogin`.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { RpcClient } from "./client.js";
import { AuthError } from "./errors.js";
import { withRetry } from "./retry.js";

export interface SessionOptions {
  baseUrl: string;
  username: string;
  password: string;
  statePath: string;
  headless?: boolean;
}

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  client: RpcClient;
  login: () => Promise<void>;
  close: () => Promise<void>;
}

export async function openSession(o: SessionOptions): Promise<Session> {
  const browser = await chromium.launch({ headless: o.headless ?? true });
  const context = await browser.newContext({ storageState: existsSync(o.statePath) ? o.statePath : undefined });
  const page = await context.newPage();

  const login = async () => {
    await page.goto(`${o.baseUrl}/login`);
    await page.getByLabel("Usuário").fill(o.username);
    await page.getByLabel("Senha").fill(o.password);
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/login"),
      page.getByRole("button", { name: "Entrar" }).click(),
    ]);
    await page.waitForLoadState("domcontentloaded");
    if (response.status() >= 400) throw new AuthError("login recusado: confira SAAS_USER e SAAS_PASSWORD");
    mkdirSync(dirname(o.statePath), { recursive: true });
    await context.storageState({ path: o.statePath });
  };

  const client = new RpcClient(context.request, o.baseUrl, login);
  try {
    // valida a sessão salva (se vencida, o cliente faz login); instabilidade aqui também tem retry
    await withRetry(() => client.listProjects(1, 1), { attempts: 4, baseMs: 500, maxMs: 4000 });
  } catch (error) {
    await browser.close();
    throw error;
  }
  return { browser, context, page, client, login, close: () => browser.close() };
}
