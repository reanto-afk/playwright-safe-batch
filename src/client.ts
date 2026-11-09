/**
 * Cliente tipado da API interna que o próprio front usa. Roda dentro do contexto autenticado do
 * Playwright (`context.request`), então usa os mesmos cookies da sessão: nada de senha no código.
 */
import type { APIRequestContext } from "playwright";
import { AuthError, BusinessError, NotSupportedError, TransientError } from "./errors.js";

export type IntegrationStatus = "connected" | "disconnected";
export interface Integration { id: string; type: string; status: IntegrationStatus }
export interface Project { id: string; name: string; integrations: Integration[] }
export interface ProjectSummary { id: string; name: string }
export interface ChangeResult { changed: boolean; integration: Integration }

export class RpcClient {
  constructor(
    private readonly request: APIRequestContext,
    private readonly baseUrl: string,
    private readonly relogin?: () => Promise<void>,
    private readonly timeoutMs = 15_000,
  ) {}

  async call<T>(method: string, params: Record<string, unknown> = {}, retriedAuth = false): Promise<T> {
    let res;
    try {
      res = await this.request.post(`${this.baseUrl}/rpc`, { data: { method, params }, timeout: this.timeoutMs });
    } catch (error) {
      throw new TransientError(`falha de rede em ${method}: ${(error as Error).message.split("\n")[0]}`);
    }
    const status = res.status();
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { code?: string; message?: string } };
    if (res.ok()) return body.result as T;

    const code = body.error?.code ?? `http_${status}`;
    const message = `${method}: ${body.error?.message ?? res.statusText()} (HTTP ${status})`;
    if (status === 401) {
      if (this.relogin && !retriedAuth) {
        await this.relogin();
        return this.call<T>(method, params, true);
      }
      throw new AuthError(message);
    }
    if (status === 429) {
      const seconds = Number(res.headers()["retry-after"]);
      throw new TransientError(message, Number.isFinite(seconds) ? seconds * 1000 : undefined);
    }
    if (status === 501) throw new NotSupportedError(message);
    if (status >= 500 || status === 408) throw new TransientError(message);
    throw new BusinessError(message, code, status);
  }

  listProjects(page: number, pageSize = 50) {
    return this.call<{ total: number; items: ProjectSummary[] }>("projects.list", { page, pageSize });
  }
  getProject(id: string) {
    return this.call<Project>("project.get", { id });
  }
  disconnect(projectId: string, integrationId: string) {
    return this.call<ChangeResult>("integration.disconnect", { projectId, integrationId });
  }
  connect(projectId: string, integrationId: string) {
    return this.call<ChangeResult>("integration.connect", { projectId, integrationId });
  }
}
