import { canonical } from './encoding';
import { verify } from './vault';
import type { OwnershipAcceptance, ScopeInfo } from './sync-types';

export const ownershipAcceptanceData = (
  acceptance: Pick<OwnershipAcceptance, 'offer' | 'members'>,
): object => ({
  action: 'accept-ownership',
  serverId: acceptance.offer.serverId,
  scopeId: acceptance.offer.scopeId,
  id: acceptance.offer.id,
  offer: acceptance.offer,
  members: acceptance.members,
});

/** Both parties authenticate the next owner and its epoch grants. No server root switch. */
export const verifyOwnershipAcceptance = async (
  value: OwnershipAcceptance,
): Promise<boolean> => {
  const { signature, ...offer } = value.offer;
  return (
    value.offer.previousOwnerId !== value.offer.recipientId &&
    (await verify(offer.previousOwnerKey, offer, signature)) &&
    (await verify(
      offer.recipientSigningKey,
      ownershipAcceptanceData(value),
      value.signature,
    ))
  );
};

export const verifyOwnershipChain = async (
  serverId: string,
  info: ScopeInfo,
  previous?: ScopeInfo,
): Promise<void> => {
  const chain = info.ownershipChain ?? [];
  const before = previous?.ownershipChain ?? [];
  if (
    chain.length > 100 ||
    chain.length < before.length ||
    canonical(chain.slice(0, before.length)) !== canonical(before)
  )
    throw new Error('Project ownership history changed');
  let ownerId = before.length ? before.at(-1)!.offer.recipientId : previous?.ownerId;
  let ownerKey = before.length
    ? before.at(-1)!.offer.recipientSigningKey
    : previous?.ownerKey;
  let epoch = 0;
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i];
    const offer = link.offer;
    const prior = chain[i - 1]?.offer;
    if (
      offer.serverId !== serverId ||
      offer.scopeId !== info.id ||
      offer.epoch <= epoch ||
      (prior &&
        (offer.previousOwnerId !== prior.recipientId ||
          canonical(offer.previousOwnerKey) !== canonical(prior.recipientSigningKey))) ||
      !(await verifyOwnershipAcceptance(link))
    )
      throw new Error('Project ownership authentication failed');
    if (i >= before.length) {
      if (
        (ownerId && offer.previousOwnerId !== ownerId) ||
        (ownerKey && canonical(offer.previousOwnerKey) !== canonical(ownerKey)) ||
        (i === before.length &&
          previous &&
          (offer.epoch < previous.epoch ||
            offer.controlVersion + 1 < previous.controlVersion))
      )
        throw new Error('Project owner changed without authorization');
      ownerId = offer.recipientId;
      ownerKey = offer.recipientSigningKey;
    }
    epoch = offer.epoch;
  }
  if (
    (ownerId && ownerId !== info.ownerId) ||
    (ownerKey && canonical(ownerKey) !== canonical(info.ownerKey)) ||
    (chain.length && info.epoch <= epoch)
  )
    throw new Error('Project owner changed without authorization');
};
