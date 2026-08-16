export class SourceWatcher {
  async latestFinalizedHeight() {
    throw new Error("latestFinalizedHeight must be implemented");
  }

  async events() {
    throw new Error("events must be implemented");
  }

  async verifyCanonicalEvent() {
    throw new Error("verifyCanonicalEvent must be implemented");
  }
}

export class SignerClient {
  async approve() {
    throw new Error("approve must be implemented");
  }
}

export class DestinationSubmitter {
  async alreadyProcessed() {
    throw new Error("alreadyProcessed must be implemented");
  }

  async submit() {
    throw new Error("submit must be implemented");
  }

  async finalizedReceipt() {
    throw new Error("finalizedReceipt must be implemented");
  }
}
