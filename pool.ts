export interface PoolRunContext {
  progress: (bytes: number) => void
}

export interface PoolTicket {
  setPriority(priority: number): void
  cancel(): void
  readonly started: boolean
}

export interface PoolClient {
  submit(priority: number, run: (context: PoolRunContext) => Promise<void>, onCancel?: () => void): PoolTicket
}
