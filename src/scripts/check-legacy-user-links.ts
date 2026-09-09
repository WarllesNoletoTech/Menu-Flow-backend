import { Role } from '../common/roles';
import {
  bsonType, closeLegacyConnection, membershipRoles, normalizedRestaurantObjectId,
  openLegacyCollections, restaurantLabel, rawValue, safeText,
} from './legacy-restaurant-links';

async function main() {
  const { users, restaurants } = await openLegacyCollections();
  const [allUsers, allRestaurants] = await Promise.all([
    users.find({}, { projection: { passwordHash: 0, addresses: 0 } }).toArray(),
    restaurants.find({}, { projection: { name: 1, tradeName: 1 } }).toArray(),
  ]);
  const restaurantById = new Map(allRestaurants.map((item) => [item._id.toHexString(), item]));
  const validRoles = new Set(Object.values(Role));
  const counters = { objectId: 0, string: 0, missing: 0, null: 0, invalid: 0, missingRestaurant: 0, admin: 0, employee: 0 };
  const ownerIds = new Map<string, string[]>();

  console.log('LEGACY USER LINK CHECK\n');
  for (const user of allUsers) {
    const membership = membershipRoles.includes(user.role as (typeof membershipRoles)[number]);
    const present = Object.prototype.hasOwnProperty.call(user, 'restaurantId');
    const type = bsonType(user.restaurantId, present);
    const normalizedId = normalizedRestaurantObjectId(user.restaurantId);
    const restaurant = normalizedId ? restaurantById.get(normalizedId.toHexString()) : undefined;
    const problems: string[] = [];

    if (!validRoles.has(user.role as Role)) problems.push('ROLE INVÁLIDA/LEGADA');
    if (membership) {
      if (user.role === Role.RESTAURANT_ADMIN) counters.admin += 1;
      if (user.role === Role.EMPLOYEE) counters.employee += 1;
      if (!present) { counters.missing += 1; problems.push('RESTAURANT_ID AUSENTE'); }
      else if (user.restaurantId === null) { counters.null += 1; problems.push('RESTAURANT_ID NULL'); }
      else if (type === 'string') { counters.string += 1; problems.push(normalizedId ? 'RESTAURANT_ID STRING LEGADO' : 'RESTAURANT_ID INVÁLIDO'); }
      else if (type === 'objectId') counters.objectId += 1;
      else { counters.invalid += 1; problems.push('RESTAURANT_ID INVÁLIDO'); }
      if (present && user.restaurantId !== null && !normalizedId) counters.invalid += type === 'string' ? 1 : 0;
      if (normalizedId && !restaurant) { counters.missingRestaurant += 1; problems.push('RESTAURANT INEXISTENTE'); }
      if (user.role === Role.RESTAURANT_ADMIN && normalizedId) {
        const id = normalizedId.toHexString();
        ownerIds.set(id, [...(ownerIds.get(id) ?? []), user._id.toHexString()]);
      }
    } else if (present && user.restaurantId !== null) {
      problems.push('ROLE SEM VÍNCULO POSSUI RESTAURANT_ID');
    }
    if (user.deletedAt === null) problems.push('DELETED_AT NULL (TRATADO COMO NÃO EXCLUÍDO)');

    if (membership || problems.length) {
      console.log(`User ID: ${user._id.toHexString()}`);
      console.log(`Nome: ${safeText(user.name)}`);
      console.log(`E-mail: ${safeText(user.email)}`);
      console.log(`Role: ${safeText(user.role)}`);
      console.log(`restaurantId bruto: ${rawValue(user.restaurantId, present)}`);
      console.log(`tipo BSON: ${type}`);
      console.log(`Restaurant encontrado?: ${restaurantLabel(restaurant)}`);
      console.log(`deletedAt: ${rawValue(user.deletedAt, Object.prototype.hasOwnProperty.call(user, 'deletedAt'))}`);
      console.log(`Problema: ${problems.length ? problems.join('; ') : 'OK'}`);
      if (type === 'string' && restaurant) console.log('Ação recomendada: converter string → ObjectId');
      console.log('');
    }
  }

  console.log('INTEGRIDADE DOS ESTABELECIMENTOS\n');
  for (const restaurant of allRestaurants) {
    const owners = ownerIds.get(restaurant._id.toHexString()) ?? [];
    const status = owners.length === 0 ? 'SEM LOJISTA' : owners.length > 1 ? 'MAIS DE UM LOJISTA' : 'OK';
    console.log(`${restaurantLabel(restaurant)} (${restaurant._id.toHexString()}): ${status}${owners.length > 1 ? ` (${owners.length})` : ''}`);
  }
  console.log('\nRESUMO');
  console.log(`Users analisados: ${allUsers.length}`);
  console.log(`RESTAURANT_ADMIN analisados: ${counters.admin}`);
  console.log(`EMPLOYEE analisados: ${counters.employee}`);
  console.log(`ObjectId correto: ${counters.objectId}`);
  console.log(`restaurantId string legado: ${counters.string}`);
  console.log(`sem vínculo (ausente): ${counters.missing}`);
  console.log(`sem vínculo (null): ${counters.null}`);
  console.log(`inválidos: ${counters.invalid}`);
  console.log(`Restaurant inexistente: ${counters.missingRestaurant}`);
}

main().catch((error) => { console.error(`Falha no diagnóstico: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; })
  .finally(closeLegacyConnection);
