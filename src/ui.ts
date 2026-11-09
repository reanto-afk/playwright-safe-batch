/** Caminho pela tela, para quando a API não oferece a operação. Lê antes, confirma e confere depois. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { BusinessError, TransientError } from "./errors.js";

export async function disconnectViaUi(page: Page, baseUrl: string, projectId: string, integrationId: string) {
  const row = page.getByTestId(`integration-${integrationId}`);
  const status = async () => (await row.locator(".status").innerText()).trim();

  const res = await page.goto(`${baseUrl}/projects/${projectId}`);
  if (!res || res.status() >= 500) throw new TransientError(`tela do projeto respondeu ${res?.status()}`);
  if ((await row.count()) === 0) throw new BusinessError("integração não aparece na tela", "ui_not_found");
  if ((await status()) === "desconectada") return { changed: false };

  await Promise.all([page.waitForURL(`**/integrations/${integrationId}/disconnect`), row.getByRole("button", { name: "Desconectar" }).click()]);
  const [confirm] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/integrations/${integrationId}/disconnect`)),
    page.getByRole("button", { name: "Confirmar" }).click(),
  ]);
  if (confirm.status() === 409) throw new BusinessError("projeto travado para alterações (tela)", "locked", 409);
  if (confirm.status() >= 500) throw new TransientError(`confirmação respondeu ${confirm.status()}`);
  await page.waitForURL(`**/projects/${projectId}`);
  if ((await row.count()) === 0 || (await status()) !== "desconectada") {
    throw new BusinessError("depois de confirmar, a tela não mostra 'desconectada'", "ui_verify_failed");
  }
  return { changed: true };
}

/** Erro da API: guarda o que a API respondeu (sem cookies nem cabeçalhos). */
export function writeErrorEvidence(dir: string, key: string, error: unknown): string | undefined {
  try {
    const path = join(dir, `${key.replace(/[^\w.-]+/g, "_")}.json`);
    mkdirSync(dir, { recursive: true });
    const e = error as { name?: string; message?: string; code?: string; status?: number };
    writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), key, error: e.name, code: e.code, status: e.status, message: e.message }, null, 2), "utf8");
    return path;
  } catch {
    return undefined;
  }
}

/** Print e HTML da tela no momento da falha, para quem for investigar. */
export async function captureEvidence(page: Page, dir: string, key: string): Promise<string | undefined> {
  try {
    const base = join(dir, key.replace(/[^\w.-]+/g, "_"));
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    writeFileSync(`${base}.html`, await page.content(), "utf8");
    return `${base}.png`;
  } catch {
    return undefined;
  }
}
