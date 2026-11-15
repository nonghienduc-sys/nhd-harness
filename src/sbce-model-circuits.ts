import { SbceCircuit } from "./sbce-circuit.js";

export class SbceModelCircuits {
  private readonly circuits = new Map<string, SbceCircuit>();

  constructor(private readonly clock: () => number = Date.now) {}

  private for(id: string): SbceCircuit {
    let circuit = this.circuits.get(id);
    if (!circuit) {
      circuit = new SbceCircuit(this.clock);
      this.circuits.set(id, circuit);
    }
    return circuit;
  }

  beforeRequest(id: string): void {
    this.for(id).beforeRequest();
  }

  success(id: string): void {
    this.for(id).success();
  }

  failure(id: string, reason: number | "timeout"): void {
    this.for(id).failure(reason);
  }

  isOpen(id: string): boolean {
    return this.for(id).state.open;
  }

  openModels(): string[] {
    return Array.from(this.circuits)
      .filter(([, circuit]) => circuit.state.open)
      .map(([id]) => id);
  }
}
