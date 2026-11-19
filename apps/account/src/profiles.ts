import type { AccountBundle, AccountInfo, seal } from '@ultra-tasks/account-crypto';

/**
 * The encrypted offline-unlock cache. It holds the account's public profile, its
 * password-wrapped vault bundle and the refresh token sealed under the vault key; it
 * never holds a password, a recovery key or an unwrapped key.
 */
export interface CachedProfile {
  origin: string;
  accountId: string;
  serverId: string;
  account: AccountInfo;
  bundle: AccountBundle;
  refresh: Awaited<ReturnType<typeof seal>>;
}

const profiles = async <T>(
  action: (store: IDBObjectStore) => IDBRequest<T>,
  write = false,
): Promise<T> => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ultra-account-v2', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('profiles', {
        keyPath: ['origin', 'serverId', 'accountId'],
      });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('profiles', write ? 'readwrite' : 'readonly');
      const request = action(tx.objectStore('profiles'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
};

export const listProfiles = async (): Promise<CachedProfile[]> =>
  (await profiles((store) => store.getAll())) as CachedProfile[];
export const putProfile = async (profile: CachedProfile): Promise<void> => {
  await profiles((store) => store.put(profile), true);
};
export const deleteProfile = async (
  origin: string,
  serverId: string,
  accountId: string,
): Promise<void> => {
  await profiles((store) => store.delete([origin, serverId, accountId]), true);
};
/** True when this browser holds an encrypted copy of an account for this server. */
export const hasProfileFor = async (origin: string): Promise<boolean> => {
  try {
    return (await listProfiles()).some((profile) => profile.origin === origin);
  } catch {
    return false;
  }
};
