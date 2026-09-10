const test = require('node:test');
const assert = require('node:assert/strict');
const { addressBelongsToRestaurant, deliveryAddressSnapshot, deliveryFeeForZone } = require('../dist/orders/orders.service');

const restaurant = { city: 'Redenção', state: 'PA' };
const all = { coverageType: 'ALL', name: 'Todos os bairros', feeCents: 900 };

test('ALL preserva Vila Paulista como bairro real e aplica R$ 9', () => {
  const address = deliveryAddressSnapshot({ zipCode:'68554-130', street:'Rua Graciliano Ramos', number:'632', neighborhood:' Vila Paulista ' }, restaurant);
  assert.equal(address.neighborhood, 'Vila Paulista');
  assert.equal(deliveryFeeForZone(all, address.neighborhood), 900);
});

test('ALL aceita Centro com a mesma taxa universal', () => assert.equal(deliveryFeeForZone(all, 'Centro'), 900));

test('SPECIFIC seleciona a taxa do bairro correspondente', () => {
  assert.equal(deliveryFeeForZone({ coverageType:'SPECIFIC', name:'Centro', feeCents:500 }, 'centro'), 500);
  assert.equal(deliveryFeeForZone({ coverageType:'SPECIFIC', name:'Jardim América', feeCents:800 }, 'Centro'), undefined);
});

test('snapshot ignora cidade e UF manipuladas e usa os dados do restaurante', () => {
  const address = deliveryAddressSnapshot({ zipCode:'68554-130', street:'Rua A', number:'1', neighborhood:'Centro', city:'Belém', state:'SP' }, restaurant);
  assert.equal(address.city, 'Redenção'); assert.equal(address.state, 'PA');
  assert.equal(addressBelongsToRestaurant({ city:'Belém', state:'PA' }, restaurant), false);
});

test('localidade retornada para CEP de outra cidade é recusada', () => {
  assert.equal(addressBelongsToRestaurant({ city:'Marabá', state:'PA' }, restaurant), false);
  assert.equal(addressBelongsToRestaurant({ city:'Redenção', state:'PA' }, restaurant), true);
});
