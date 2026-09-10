const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTypeName, typeSlug } = require('../dist/establishment-types/establishment-types.service');

test('normaliza nomes sem diferenciar caixa, acentos ou espaços', () => {
  assert.equal(normalizeTypeName('  RESTAURANTE  '), normalizeTypeName('Restaurante'));
  assert.equal(normalizeTypeName('Sorveteria  e  Açaí'), 'sorveteria e acai');
});

test('gera slug estável para tipos compostos', () => {
  assert.equal(typeSlug('Pet Shop'), 'pet-shop');
  assert.equal(typeSlug('Sorveteria e Açaí'), 'sorveteria-e-acai');
});
