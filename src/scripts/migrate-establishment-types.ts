import mongoose, { Types } from 'mongoose';
import { normalizeTypeName, typeSlug } from '../establishment-types/establishment-types.service';
import { legacyStringToObjectId } from '../establishment-types/establishment-type-links';

const legacyNames: Record<string, string> = { RESTAURANT: 'Restaurante', STORE: 'Loja', PHARMACY: 'Farmácia', CLOTHING: 'Loja de roupas', OTHER: 'Loja' };

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const apply = process.argv.includes('--apply');
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const restaurants = db.collection('restaurants');
  const types = db.collection('establishmenttypedefinitions');
  const creator = await db.collection('users').findOne({ role: 'SUPER_ADMIN' }, { projection: { _id: 1 } });
  if (!creator && apply) throw new Error('A SUPER_ADMIN is required to attribute migrated types.');

  const legacyValues = await restaurants.distinct('establishmentType');
  if (await restaurants.countDocuments({ establishmentType: { $exists: false } })) legacyValues.push('RESTAURANT');
  const names = [...new Set(legacyValues.map(value => legacyNames[String(value)] ?? String(value).trim()).filter(Boolean))];
  if (apply) {
    for (const name of names) {
      const normalizedName = normalizeTypeName(name); const slug = typeSlug(name);
      await types.findOneAndUpdate({ normalizedName }, { $setOnInsert: { name, normalizedName, slug, active: true, sortOrder: 0, createdBy: creator!._id, createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
    }
  }

  const definitions = await types.find({}, { projection: { _id: 1, normalizedName: 1 } }).toArray();
  const definitionIds = new Set(definitions.map(item => item._id.toString()));
  const definitionByName = new Map(definitions.map(item => [String(item.normalizedName), item._id]));
  const records = await restaurants.find({}, { projection: { name: 1, establishmentType: 1, establishmentTypeId: 1 } }).toArray();
  const diagnostic = { restaurants: records.length, objectId: 0, string: 0, missing: 0, invalidFormat: 0, missingReference: 0, corrected: 0, unresolved: [] as Array<Record<string, unknown>> };

  for (const restaurant of records) {
    const link = restaurant.establishmentTypeId;
    if (link instanceof Types.ObjectId) diagnostic.objectId += 1;
    else if (typeof link === 'string') diagnostic.string += 1;
    else if (link == null) diagnostic.missing += 1;
    else diagnostic.invalidFormat += 1;

    const linkText = link instanceof Types.ObjectId || typeof link === 'string' ? link.toString() : undefined;
    const validFormat = Boolean(linkText && Types.ObjectId.isValid(linkText));
    const linkedDefinitionExists = Boolean(validFormat && definitionIds.has(linkText!));
    if (linkText && !validFormat) diagnostic.invalidFormat += 1;
    if (validFormat && !linkedDefinitionExists) diagnostic.missingReference += 1;

    let target: Types.ObjectId | undefined;
    // A valid legacy string keeps exactly the same identifier when its target exists.
    if (linkedDefinitionExists) target = legacyStringToObjectId(link);
    // Missing/dangling references are repaired only when the legacy value identifies
    // one definition unambiguously; never assign an arbitrary fallback.
    if (!linkedDefinitionExists) {
      const legacyName = legacyNames[String(restaurant.establishmentType)] ?? (typeof restaurant.establishmentType === 'string' ? restaurant.establishmentType.trim() : '');
      if (legacyName) target = definitionByName.get(normalizeTypeName(legacyName));
    }
    if (target && (!(link instanceof Types.ObjectId) || !link.equals(target))) {
      if (apply) await restaurants.updateOne({ _id: restaurant._id }, { $set: { establishmentTypeId: target } });
      diagnostic.corrected += 1;
    } else if (!linkedDefinitionExists) {
      diagnostic.unresolved.push({ _id: restaurant._id, name: restaurant.name, establishmentType: restaurant.establishmentType, establishmentTypeId: link, reason: validFormat ? 'referência inexistente' : link == null ? 'vínculo ausente sem inferência segura' : 'formato inválido' });
    }
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'diagnostic', ...diagnostic }, null, 2));
  if (apply) {
    await types.createIndex({ slug: 1 }, { unique: true });
    await types.createIndex({ normalizedName: 1 }, { unique: true });
  }
  await mongoose.disconnect();
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
