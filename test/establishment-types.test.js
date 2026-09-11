const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTypeName, typeSlug } = require('../dist/establishment-types/establishment-types.service');
const { legacyStringToObjectId } = require('../dist/establishment-types/establishment-type-links');
const { Types } = require('mongoose');

test('normaliza nomes sem diferenciar caixa, acentos ou espaços', () => {
  assert.equal(normalizeTypeName('  RESTAURANTE  '), normalizeTypeName('Restaurante'));
  assert.equal(normalizeTypeName('Sorveteria  e  Açaí'), 'sorveteria e acai');
});

test('gera slug estável para tipos compostos', () => {
  assert.equal(typeSlug('Pet Shop'), 'pet-shop');
  assert.equal(typeSlug('Sorveteria e Açaí'), 'sorveteria-e-acai');
});

test('converte vínculo string legado sem mudar o identificador e é idempotente', () => {
  const id = new Types.ObjectId();
  const converted = legacyStringToObjectId(id.toHexString());
  assert.equal(converted instanceof Types.ObjectId, true);
  assert.equal(converted.equals(id), true);
  assert.equal(legacyStringToObjectId(converted), undefined);
  assert.equal(legacyStringToObjectId('inválido'), undefined);
});
