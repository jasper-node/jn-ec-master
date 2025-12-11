export class EtherCatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtherCatError";
  }
}

export class PdoIntegrityError extends EtherCatError {
  constructor(message: string) {
    super(message);
    this.name = "PdoIntegrityError";
  }
}

export class StateTransitionError extends EtherCatError {
  constructor(message: string, public alStatusCode?: number) {
    super(message);
    this.name = "StateTransitionError";
  }
}

export class FfiError extends EtherCatError {
  constructor(message: string, public code: number) {
    super(`${message} (Code: ${code})`);
    this.name = "FfiError";
  }
}
