const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAddonPricing } = require('../dist/orders/addon-pricing');

test('grupo MAX cobra somente a opção selecionada mais cara', () => {
  const groups = [{ _id: 'sabores', pricingMode: 'MAX' }];
  const selected = [
    { groupId: 'sabores', name: 'Calabresa', price: 5, priceCents: 500 },
    { groupId: 'sabores', name: 'Portuguesa', price: 8, priceCents: 800 },
  ];
  const priced = applyAddonPricing(groups, selected);
  assert.equal(priced.reduce((sum, addon) => sum + addon.priceCents, 0), 800);
  assert.equal(priced.find((addon) => addon.name === 'Calabresa').priceCents, 0);
  assert.equal(priced.find((addon) => addon.name === 'Portuguesa').priceCents, 800);
});

test('grupo SUM continua somando normalmente', () => {
  const groups = [{ _id: 'extras', pricingMode: 'SUM' }];
  const selected = [
    { groupId: 'extras', name: 'Bacon', price: 4, priceCents: 400 },
    { groupId: 'extras', name: 'Queijo', price: 3, priceCents: 300 },
  ];
  const priced = applyAddonPricing(groups, selected);
  assert.equal(priced.reduce((sum, addon) => sum + addon.priceCents, 0), 700);
});
