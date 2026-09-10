import mongoose from 'mongoose';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const apply = process.argv.includes('--apply');
  await mongoose.connect(uri);
  const collection = mongoose.connection.collection('deliveryzones');

  // Lowercase "todos" was the exact sentinel emitted by the legacy setup. We do
  // not use a case-insensitive match, so a legitimate bairro named "Todos" is
  // deliberately preserved for manual review.
  const universal = { name: 'todos', coverageType: { $exists: false } };
  const legacyUniversal = await collection.countDocuments(universal);
  const untypedSpecific = await collection.countDocuments({ coverageType: { $exists: false }, name: { $ne: 'todos' } });
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', legacyUniversal, untypedSpecific }));
  if (apply) {
    const all = await collection.updateMany(universal, { $set: { coverageType: 'ALL', name: 'Todos os bairros' } });
    const specific = await collection.updateMany({ coverageType: { $exists: false } }, { $set: { coverageType: 'SPECIFIC' } });
    console.log(JSON.stringify({ allUpdated: all.modifiedCount, specificUpdated: specific.modifiedCount }));
  }
  await mongoose.disconnect();
}

main().catch(async (error) => { console.error(error); await mongoose.disconnect(); process.exitCode = 1; });
