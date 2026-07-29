export interface SessionConnection {
  id: string;
}

export type SessionConnectionPicker<T extends SessionConnection> = (
  connections: readonly T[],
  currentConnectionId: string | undefined
) => Promise<T | undefined>;

export interface SessionConnectionResolveOptions {
  alwaysPrompt?: boolean;
}

type RememberedConnectionChoice =
  | { kind: 'none' }
  | { kind: 'selected'; connectionId: string }
  | { kind: 'invalidated'; connectionId: string };

interface PaletteSelectionResult {
  selectedId: string | undefined;
  rememberedChoice: RememberedConnectionChoice;
}

type PaletteSelectionOutcome =
  | { kind: 'selected'; connectionId: string }
  | { kind: 'notSelected' };

interface PaletteSelectionBarrier {
  promise: Promise<PaletteSelectionOutcome>;
}

export interface FallbackConnectionIdentity {
  name?: unknown;
  driver?: unknown;
  group?: unknown;
  server?: unknown;
  port?: unknown;
  database?: unknown;
  username?: unknown;
}

export function fallbackConnectionId(
  connection: FallbackConnectionIdentity,
  defaultDriver: string
): string {
  return JSON.stringify([
    String(connection.name || 'kdb'),
    String(connection.driver || defaultDriver),
    String(connection.group || ''),
    String(connection.server || 'localhost'),
    String(connection.port || 5000),
    String(connection.database || '.'),
    String(connection.username || ''),
  ]);
}

export class KdbPanelConnectionSession<T extends SessionConnection> {
  private rememberedChoice: RememberedConnectionChoice = { kind: 'none' };
  private normalSelectionPromise: Promise<string | undefined> | undefined;
  private normalSelectionConnectionIdSets: ReadonlySet<string>[] | undefined;
  private pickerQueue: Promise<void> = Promise.resolve();
  // The latest tail includes earlier queued palettes; normal resolves snapshot its cutoff.
  private paletteSelectionBarrier: PaletteSelectionBarrier | undefined;

  public async resolve(
    connections: readonly T[],
    pickConnection: SessionConnectionPicker<T>,
    options: SessionConnectionResolveOptions = {}
  ): Promise<T | undefined> {
    if (options.alwaysPrompt) {
      return this.resolvePaletteSelection(connections, pickConnection);
    }

    const connectionIds = new Set(
      connections.map(connection => connection.id)
    );
    const paletteSelectionBarrier = this.paletteSelectionBarrier;
    if (paletteSelectionBarrier) {
      const paletteOutcome = await paletteSelectionBarrier.promise;
      if (paletteOutcome.kind === 'selected') {
        return this.connectionForSelectedId(
          connections,
          connectionIds,
          paletteOutcome.connectionId
        );
      }
    }

    const pendingNormalSelection = this.normalSelectionPromise;
    if (pendingNormalSelection) {
      this.normalSelectionConnectionIdSets!.push(connectionIds);
      return this.connectionForSelectedId(
        connections,
        connectionIds,
        await pendingNormalSelection
      );
    }

    this.invalidateMissingChoice(connections);

    const current = this.selectedConnection(connections);
    if (current) {
      return current;
    }
    if (connections.length === 1 && this.rememberedChoice.kind === 'none') {
      this.remember(connections[0].id);
      return connections[0];
    }

    if (connections.length === 0) {
      return undefined;
    }

    this.normalSelectionConnectionIdSets = [connectionIds];
    const normalSelection = this.resolveNormalSelection(
      connections,
      pickConnection
    );
    this.normalSelectionPromise = normalSelection;
    return this.connectionForSelectedId(
      connections,
      connectionIds,
      await normalSelection
    );
  }

  private resolvePaletteSelection(
    connections: readonly T[],
    pickConnection: SessionConnectionPicker<T>
  ): Promise<T | undefined> {
    const previousBarrier = this.paletteSelectionBarrier;
    const selection = this.enqueuePicker(async (): Promise<PaletteSelectionResult> => {
      this.invalidateMissingChoice(connections);
      if (connections.length === 0) {
        return {
          selectedId: undefined,
          rememberedChoice: this.rememberedChoiceSnapshot(),
        };
      }

      const currentAtPrompt = this.selectedConnection(connections);
      const pickedId = await this.pickAvailableConnectionId(
        connections,
        pickConnection,
        currentAtPrompt && currentAtPrompt.id
      );
      if (pickedId !== undefined) {
        this.remember(pickedId);
      } else {
        this.invalidateMissingChoice(connections);
      }
      return {
        selectedId: pickedId,
        rememberedChoice: this.rememberedChoiceSnapshot(),
      };
    });
    const barrier: PaletteSelectionBarrier = {
      promise: selection.then(
        result => this.paletteSelectionOutcome(
          result.selectedId,
          result.rememberedChoice,
          previousBarrier
        ),
        () => this.paletteSelectionOutcome(
          undefined,
          this.rememberedChoiceSnapshot(),
          previousBarrier
        )
      ),
    };
    this.paletteSelectionBarrier = barrier;
    void barrier.promise.then(() => {
      if (this.paletteSelectionBarrier === barrier) {
        this.paletteSelectionBarrier = undefined;
      }
    });

    return selection.then(result =>
      result.selectedId === undefined
        ? undefined
        : connections.find(connection => connection.id === result.selectedId)
    );
  }

  private async paletteSelectionOutcome(
    selectedId: string | undefined,
    rememberedChoice: RememberedConnectionChoice,
    previousBarrier: PaletteSelectionBarrier | undefined
  ): Promise<PaletteSelectionOutcome> {
    if (selectedId !== undefined) {
      return { kind: 'selected', connectionId: selectedId };
    }
    if (!previousBarrier) {
      return { kind: 'notSelected' };
    }

    const previousOutcome = await previousBarrier.promise;
    if (
      previousOutcome.kind === 'selected' &&
      rememberedChoice.kind === 'selected' &&
      rememberedChoice.connectionId === previousOutcome.connectionId
    ) {
      return previousOutcome;
    }
    return { kind: 'notSelected' };
  }

  private async resolveNormalSelection(
    connections: readonly T[],
    pickConnection: SessionConnectionPicker<T>
  ): Promise<string | undefined> {
    try {
      const selection = await this.enqueuePicker(async () => {
        this.invalidateMissingChoice(connections);
        const currentAtPrompt = this.selectedConnection(connections);
        if (currentAtPrompt) {
          return {
            connectionId: currentAtPrompt.id,
            reusedCurrent: true,
          };
        }

        return {
          connectionId: await this.pickAvailableConnectionId(
            connections,
            pickConnection,
            undefined
          ),
          reusedCurrent: false,
        };
      });

      const selectedId = selection.connectionId;
      if (selectedId === undefined || !this.normalSelectionIncludes(selectedId)) {
        if (selection.reusedCurrent) {
          this.invalidateSelectedChoice();
        } else {
          this.invalidateMissingChoice(connections);
        }
        return undefined;
      }
      if (!selection.reusedCurrent) {
        this.remember(selectedId);
      }
      return selectedId;
    } finally {
      this.normalSelectionPromise = undefined;
      this.normalSelectionConnectionIdSets = undefined;
    }
  }

  private connectionForSelectedId(
    connections: readonly T[],
    connectionIds: ReadonlySet<string>,
    selectedId: string | undefined
  ): T | undefined {
    if (selectedId === undefined || !connectionIds.has(selectedId)) {
      return undefined;
    }
    return connections.find(connection => connection.id === selectedId);
  }

  private selectedConnection(connections: readonly T[]): T | undefined {
    const rememberedChoice = this.rememberedChoice;
    if (rememberedChoice.kind !== 'selected') {
      return undefined;
    }
    return connections.find(
      connection => connection.id === rememberedChoice.connectionId
    );
  }

  private invalidateMissingChoice(connections: readonly T[]): void {
    const rememberedChoice = this.rememberedChoice;
    if (
      rememberedChoice.kind === 'selected' &&
      !connections.some(connection => connection.id === rememberedChoice.connectionId)
    ) {
      this.invalidateSelectedChoice();
    }
  }

  private invalidateSelectedChoice(): void {
    if (this.rememberedChoice.kind === 'selected') {
      this.rememberedChoice = {
        kind: 'invalidated',
        connectionId: this.rememberedChoice.connectionId,
      };
    }
  }

  private remember(connectionId: string): void {
    this.rememberedChoice = { kind: 'selected', connectionId };
  }

  private rememberedChoiceSnapshot(): RememberedConnectionChoice {
    const rememberedChoice = this.rememberedChoice;
    if (rememberedChoice.kind === 'none') {
      return { kind: 'none' };
    }
    return { ...rememberedChoice };
  }

  private enqueuePicker<R>(pick: () => Promise<R>): Promise<R> {
    const result = this.pickerQueue.then(pick);
    this.pickerQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private normalSelectionIncludes(connectionId: string): boolean {
    return this.normalSelectionConnectionIdSets !== undefined &&
      this.normalSelectionConnectionIdSets.every(connectionIds =>
        connectionIds.has(connectionId)
      );
  }

  private async pickAvailableConnectionId(
    connections: readonly T[],
    pickConnection: SessionConnectionPicker<T>,
    currentConnectionId: string | undefined
  ): Promise<string | undefined> {
    const picked = await pickConnection(connections, currentConnectionId);
    if (!picked) {
      return undefined;
    }

    const selected = connections.find(connection => connection.id === picked.id);
    if (!selected) {
      return undefined;
    }

    return selected.id;
  }
}
