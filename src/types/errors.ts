export interface ErrorContext {
  [key: string]: string;
}

export class EtherCatError extends Error {
  public context?: ErrorContext;
  constructor(message: string, context?: ErrorContext) {
    super(message);
    this.name = "EtherCatError";
    this.context = context;
  }
}

export class PdoIntegrityError extends EtherCatError {
  constructor(message: string) {
    super(message);
    this.name = "PdoIntegrityError";
  }
}

export class StateTransitionError extends EtherCatError {
  constructor(
    message: string,
    public alStatusCode?: number,
    public fromState?: string,
    public toState?: string,
    context?: ErrorContext,
  ) {
    super(message, context);
    this.name = "StateTransitionError";
  }
}

export class FfiError extends EtherCatError {
  constructor(message: string, public code: number, context?: ErrorContext) {
    super(`${message} (Code: ${code})`, context);
    this.name = "FfiError";
  }
}
