const test = require('node:test');
const assert = require('node:assert/strict');
const { BadRequestException } = require('@nestjs/common');
const { expectedChangeCents } = require('../dist/orders/orders.service');

test('calcula o troco em centavos no servidor', () => {
  assert.equal(expectedChangeCents('CASH', true, 5000, 4500), 500);
  assert.equal(expectedChangeCents('CASH', false, undefined, 4500), undefined);
});

test('rejeita troco abaixo do total e troco para pagamento não-dinheiro', () => {
  assert.throws(() => expectedChangeCents('CASH', true, 3000, 4000), (error) => error instanceof BadRequestException && error.message === 'O valor para troco não pode ser menor que o total do pedido.');
  assert.throws(() => expectedChangeCents('PIX', true, 5000, 4000), /Troco só está disponível/);
});
