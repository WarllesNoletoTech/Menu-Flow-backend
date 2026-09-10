import { MongoClient, ObjectId } from 'mongodb';

type Finding = { collection: string; id: string; issue: string; action: string };

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI must be configured.');
  const apply = process.argv.includes('--apply');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db();
    const findings: Finding[] = [];
    const restaurantIds = new Set((await db.collection('restaurants').find({}, { projection: { _id: 1 } }).toArray()).map(({ _id }) => _id.toString()));
    for (const collection of ['restaurantsettings', 'deliveryzones', 'payments', 'orders']) {
      for await (const document of db.collection(collection).find({ restaurantId: { $type: 'string' } }, { projection: { restaurantId: 1 } })) {
        const value = document.restaurantId;
        const valid = typeof value === 'string' && ObjectId.isValid(value) && restaurantIds.has(value);
        findings.push({ collection, id: document._id.toString(), issue: `restaurantId is string (${valid ? 'valid' : 'invalid/orphan'})`, action: valid ? 'convert to ObjectId' : 'manual review' });
        if (apply && valid) await db.collection(collection).updateOne({ _id: document._id, restaurantId: value }, { $set: { restaurantId: new ObjectId(value) } });
      }
    }
    for await (const document of db.collection('orders').find({ customerId: { $type: 'string' } }, { projection: { customerId: 1 } })) {
      const value = document.customerId;
      const valid = typeof value === 'string' && ObjectId.isValid(value) && Boolean(await db.collection('users').findOne({ _id: new ObjectId(value) }, { projection: { _id: 1 } }));
      findings.push({ collection: 'orders', id: document._id.toString(), issue: `customerId is string (${valid ? 'valid' : 'invalid/orphan'})`, action: valid ? 'convert to ObjectId' : 'manual review' });
      if (apply && valid) await db.collection('orders').updateOne({ _id: document._id, customerId: value }, { $set: { customerId: new ObjectId(value) } });
    }
    for await (const document of db.collection('orders').find({ status: 'COMPLETED', completedAt: { $exists: false } }, { projection: { updatedAt: 1 } })) {
      const safe = document.updatedAt instanceof Date;
      findings.push({ collection: 'orders', id: document._id.toString(), issue: 'COMPLETED without completedAt', action: safe ? 'copy updatedAt to completedAt' : 'manual review' });
      if (apply && safe) await db.collection('orders').updateOne({ _id: document._id, status: 'COMPLETED', completedAt: { $exists: false } }, { $set: { completedAt: document.updatedAt, completedAtMigrationSource: 'updatedAt' } });
    }
    for (const collection of ['restaurantsettings', 'deliveryzones', 'payments']) {
      const key = collection === 'restaurantsettings' ? [] : [collection === 'deliveryzones' ? '$name' : '$method'];
      const duplicates = await db.collection(collection).aggregate([{ $group: { _id: ['$restaurantId', ...key], ids: { $push: '$_id' }, count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }]).toArray();
      for (const duplicate of duplicates) findings.push({ collection, id: duplicate.ids.map(String).join(','), issue: 'duplicate logical key', action: 'manual review; nothing changed' });
    }
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', findings, totals: { findings: findings.length, changedCandidates: findings.filter((item) => !item.action.startsWith('manual')).length } }, null, 2));
  } finally { await client.close(); }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
