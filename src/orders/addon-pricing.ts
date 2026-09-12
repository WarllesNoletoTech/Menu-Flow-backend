export type AddonPricingGroup = { _id?: unknown; pricingMode?: 'SUM' | 'MAX' | string };

export type PricedAddon = {
  groupId: string;
  price: number;
  priceCents: number;
  [key: string]: unknown;
};

/**
 * Applies the charging rule of each option group without changing the customer's
 * selections. SUM keeps every selected option price. MAX keeps only the highest
 * priced option in that group and zeros the others.
 */
export function applyAddonPricing<T extends PricedAddon>(groups: AddonPricingGroup[], selected: T[]): T[] {
  const priced = selected.map((addon) => ({ ...addon })) as T[];

  for (const group of groups) {
    if (group.pricingMode !== 'MAX') continue;
    const groupId = group._id == null ? '' : String(group._id);
    if (!groupId) continue;

    const indexes = priced
      .map((addon, index) => ({ addon, index }))
      .filter(({ addon }) => addon.groupId === groupId)
      .map(({ index }) => index);

    if (indexes.length <= 1) continue;

    let winnerIndex = indexes[0];
    for (const index of indexes.slice(1)) {
      if (priced[index].priceCents > priced[winnerIndex].priceCents) winnerIndex = index;
    }

    for (const index of indexes) {
      if (index === winnerIndex) continue;
      priced[index] = { ...priced[index], price: 0, priceCents: 0 };
    }
  }

  return priced;
}
