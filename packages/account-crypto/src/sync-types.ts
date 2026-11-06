import type { KeyGrant, SignedRecord } from './sharing';

export type Role = 'owner' | 'editor' | 'viewer';
export interface MemberAuthorization {
  serverId: string;
  scopeId: string;
  ownerId: string;
  accountId: string;
  role: Role;
  epoch: number;
  inviteId: string;
  encryptionPublicKey: JsonWebKey;
  signingPublicKey: JsonWebKey;
  grant: KeyGrant;
}
export interface Membership {
  authorization: MemberAuthorization;
  signature: string;
}
export interface DeviceCertificate {
  serverId: string;
  accountId: string;
  deviceId: string;
  publicKey: JsonWebKey;
  signature: string;
}
export interface SyncWrite {
  record: SignedRecord;
  deleted: boolean;
  restore?: boolean;
}
export interface Mutation {
  v: 2;
  serverId: string;
  scopeId: string;
  epoch: number;
  generation: number;
  controlVersion: number;
  deviceId: string;
  counter: number;
  mutationId: string;
  certificate: DeviceCertificate;
  membership: Membership;
  writes: SyncWrite[];
  signature: string;
}
export interface OwnershipOffer {
  action: 'transfer-ownership';
  serverId: string;
  scopeId: string;
  id: string;
  previousOwnerId: string;
  previousOwnerKey: JsonWebKey;
  recipientId: string;
  recipientSigningKey: JsonWebKey;
  recipientEncryptionKey: JsonWebKey;
  epoch: number;
  controlVersion: number;
  expiresAt: number;
  signature: string;
}
export interface OwnershipAcceptance {
  offer: OwnershipOffer;
  members: Membership[];
  signature: string;
}
export interface ScopeRotation {
  id: string;
  members: Membership[];
  kind?: 'remove' | 'transfer' | 'restore' | 'member-left';
  controllerId?: string;
  transfer?: OwnershipAcceptance;
  checkpointSequence?: number;
}
export interface ScopeInfo {
  id: string;
  kind: 'personal' | 'project';
  ownerId: string;
  ownerKey: JsonWebKey;
  epoch: number;
  generation: number;
  controlVersion: number;
  sequence: number;
  state: 'active' | 'migrating' | 'rotating';
  members: Membership[];
  rotation?: ScopeRotation;
  ownershipChain?: OwnershipAcceptance[];
}
export interface ScopeSnapshot {
  controlUnchanged?: boolean;
  scope: ScopeInfo;
  heads: SyncWrite[];
  manifests: Mutation[];
}
export interface Recipient {
  id: string;
  username: string | null;
  encryptionPublicKey: JsonWebKey;
  signingPublicKey: JsonWebKey;
}
export interface Invitation {
  id: string;
  scopeId: string;
  role: 'editor' | 'viewer';
  expiresAt: number;
  membership: Membership | null;
  ownerKey: JsonWebKey;
  state: 'pending' | 'provisioning';
}
export interface PlainHead {
  entityId: string;
  entityType: string;
  revision: number;
  deleted: boolean;
  value: unknown;
}
export interface Intent {
  id: string;
  changes: {
    entityId: string;
    entityType: string;
    base: PlainHead | null;
    value: unknown;
    deleted: boolean;
    restore?: boolean;
  }[];
}
export interface ConflictDraft {
  id: string;
  entityId: string;
  value: unknown;
  createdAt: number;
  reason: 'overlap' | 'deleted' | 'permission';
}
export interface LocalScope {
  revoked?: boolean;
  downloaded?: boolean;
  info: ScopeInfo;
  key: string;
  counter: number;
  heads: Record<string, PlainHead>;
  intents: Intent[];
  uncertain?: Mutation;
  uncertainKey?: string;
  conflicts: ConflictDraft[];
}
export interface SyncState {
  v: 2;
  device: { id: string; privateKey: JsonWebKey; certificate: DeviceCertificate };
  scopes: Record<string, LocalScope>;
  pins: Record<string, string>;
  migrations: Record<
    string,
    {
      scopeId: string;
      records: { entityId: string; entityType: string; value: unknown }[];
      offset: number;
      complete: boolean;
    }
  >;
}
export interface StateStorage {
  load(): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
}
