/** Erros que a automação trata de jeitos diferentes. */

/** Vale tentar de novo: 5xx, 429, rede, timeout. */
export class TransientError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "TransientError";
  }
}

/** Regra de negócio recusou (4xx): tentar de novo não muda nada. Registra e segue. */
export class BusinessError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = "BusinessError";
  }
}

/** Sessão inválida mesmo depois de logar de novo: para o lote inteiro. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** A API não oferece a operação (501): usar o caminho pela tela. */
export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSupportedError";
  }
}
