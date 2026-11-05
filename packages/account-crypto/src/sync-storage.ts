import { canonical } from './encoding';
import { open, seal, type Envelope, type VaultContext } from './vault';
import type { StateStorage, SyncState } from './sync-types';

/** One encrypted atomic document per server/account. IndexedDB commits before resolving. */
export class EncryptedSyncStorage implements StateStorage {
  constructor(
    private readonly key: string,
    private readonly context: VaultContext,
    private readonly databaseName = 'ultra-native-sync-v2',
  ) {}

  private async db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('accounts');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  private identity(): string {
    return canonical({ ...this.context, purpose: 'native-sync-state-v2' });
  }

  async load(): Promise<SyncState | null> {
    const db = await this.db();
    try {
      const envelope = await new Promise<Envelope | undefined>((resolve, reject) => {
        const request = db
          .transaction('accounts')
          .objectStore('accounts')
          .get(this.identity());
        request.onsuccess = () => resolve(request.result as Envelope | undefined);
        request.onerror = () => reject(request.error);
      });
      if (!envelope) return null;
      const state = JSON.parse(
        await open(this.key, envelope, this.identity()),
      ) as SyncState;
      if (state.v !== 2) throw new Error('Unsupported native sync state');
      return state;
    } finally {
      db.close();
    }
  }

  async save(state: SyncState): Promise<void> {
    const envelope = await seal(this.key, JSON.stringify(state), this.identity());
    const db = await this.db();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('accounts', 'readwrite');
        tx.objectStore('accounts').put(envelope, this.identity());
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Sync storage aborted'));
      });
    } finally {
      db.close();
    }
  }
}
