import { Role } from '../common/roles';
import {
  closeLegacyConnection, membershipRoles, normalizedRestaurantObjectId,
  openLegacyCollections, restaurantLabel, safeText,
} from './legacy-restaurant-links';

async function main() {
  const apply = process.argv.includes('--apply');
  if (apply && process.argv.includes('--dry-run')) throw new Error('Use somente --dry-run ou --apply, nunca ambos.');
  const { users, restaurants } = await openLegacyCollections();
  const candidates = await users.find({ role: { $in: [...membershipRoles] }, restaurantId: { $type: 'string' } }).toArray();
  const owners = await users.find({ role: Role.RESTAURANT_ADMIN }, { projection: { restaurantId: 1 } }).toArray();
  const ownerCount = new Map<string, number>();
  for (const owner of owners) {
    const id = normalizedRestaurantObjectId(owner.restaurantId)?.toHexString();
    if (id) ownerCount.set(id, (ownerCount.get(id) ?? 0) + 1);
  }
  let eligible = 0;
  let changed = 0;
  let invalid = 0;
  let missingRestaurant = 0;
  let ambiguousOwners = 0;

  console.log(`LEGACY RESTAURANT LINK MIGRATION — ${apply ? 'APPLY' : 'DRY RUN'}\n`);
  for (const user of candidates) {
    const objectId = normalizedRestaurantObjectId(user.restaurantId);
    if (!objectId) { invalid += 1; console.log(`${user._id} | ${safeText(user.name)} | ${safeText(user.role)} | restaurantId legado inválido: ${JSON.stringify(user.restaurantId)}`); continue; }
    const restaurant = await restaurants.findOne({ _id: objectId }, { projection: { name: 1, tradeName: 1 } });
    if (!restaurant) { missingRestaurant += 1; console.log(`${user._id} | ${safeText(user.name)} | ${safeText(user.role)} | estabelecimento inexistente: ${user.restaurantId}`); continue; }
    if (user.role === Role.RESTAURANT_ADMIN && (ownerCount.get(objectId.toHexString()) ?? 0) > 1) {
      ambiguousOwners += 1;
      console.log(`${user._id} | ${safeText(user.name)} | RESTAURANT_ADMIN | ${restaurantLabel(restaurant)} | NÃO ALTERADO: MAIS DE UM LOJISTA`);
      continue;
    }
    eligible += 1;
    console.log(`${user._id} | ${safeText(user.name)} | ${safeText(user.role)} | ${restaurantLabel(restaurant)} | string → ObjectId${apply ? '' : ' (seria corrigido)'}`);
    if (apply) {
      const result = await users.updateOne({ _id: user._id, restaurantId: user.restaurantId }, { $set: { restaurantId: objectId } });
      changed += result.modifiedCount;
    }
  }
  console.log('\nRESUMO');
  console.log(`Strings analisadas: ${candidates.length}`);
  console.log(`Elegíveis: ${eligible}`);
  console.log(`${apply ? 'Usuários corrigidos' : 'Seriam corrigidos'}: ${apply ? changed : eligible}`);
  console.log(`Inválidos (não alterados): ${invalid}`);
  console.log(`Restaurant inexistente (não alterados): ${missingRestaurant}`);
  console.log(`Lojistas ambíguos (não alterados): ${ambiguousOwners}`);
  if (!apply) console.log('\nNenhuma alteração foi aplicada. Execute novamente com --apply somente após revisar este relatório.');
}

main().catch((error) => { console.error(`Falha na migração: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; })
  .finally(closeLegacyConnection);
