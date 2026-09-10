import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EstablishmentTypeDefinition, EstablishmentTypeDefinitionDocument, Restaurant } from '../common/schemas';

export const normalizeTypeName = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
export const typeSlug = (value: string) => normalizeTypeName(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

@Injectable()
export class EstablishmentTypesService {
  constructor(
    @InjectModel(EstablishmentTypeDefinition.name) private readonly types: Model<EstablishmentTypeDefinitionDocument>,
    @InjectModel(Restaurant.name) private readonly restaurants: Model<Restaurant>,
  ) {}

  async adminList() {
    const items = await this.types.find().sort({ sortOrder: 1, name: 1 }).lean();
    const usage = await this.restaurants.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { establishmentTypeId: { $type: 'objectId' } } },
      { $group: { _id: '$establishmentTypeId', count: { $sum: 1 } } },
    ]);
    const counts = new Map(usage.map(item => [item._id.toString(), item.count]));
    return items.map(item => ({ id: item._id.toString(), name: item.name, slug: item.slug, active: item.active, sortOrder: item.sortOrder, usageCount: counts.get(item._id.toString()) ?? 0, createdAt: (item as { createdAt?: Date }).createdAt, updatedAt: (item as { updatedAt?: Date }).updatedAt }));
  }

  async publicList() {
    const items = await this.types.find({ active: true }).select('name slug').sort({ sortOrder: 1, name: 1 }).lean();
    return items.map(item => ({ id: item._id.toString(), name: item.name, slug: item.slug }));
  }

  async create(input: { name: string; active?: boolean; sortOrder?: number }, actorId: string) {
    const fields = this.fields(input.name);
    try { return await this.types.create({ ...fields, active: input.active ?? true, sortOrder: input.sortOrder ?? 0, createdBy: new Types.ObjectId(actorId) }); }
    catch (error) { if ((error as { code?: number }).code === 11000) throw new ConflictException('Já existe um tipo de estabelecimento com este nome.'); throw error; }
  }

  async update(id: string, input: { name?: string; active?: boolean; sortOrder?: number }) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Tipo de estabelecimento não encontrado.');
    const changes = { ...(input.name !== undefined ? this.fields(input.name) : {}), ...(input.active !== undefined ? { active: input.active } : {}), ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}) };
    try { const item = await this.types.findByIdAndUpdate(id, { $set: changes }, { new: true, runValidators: true }); if (!item) throw new NotFoundException('Tipo de estabelecimento não encontrado.'); return item; }
    catch (error) { if ((error as { code?: number }).code === 11000) throw new ConflictException('Já existe um tipo de estabelecimento com este nome.'); throw error; }
  }

  async remove(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Tipo de estabelecimento não encontrado.');
    const usageCount = await this.restaurants.countDocuments({ establishmentTypeId: new Types.ObjectId(id) });
    if (usageCount) throw new ConflictException(`Este tipo está sendo utilizado por ${usageCount} estabelecimento${usageCount === 1 ? '' : 's'} e não pode ser excluído.`);
    const item = await this.types.findByIdAndDelete(id);
    if (!item) throw new NotFoundException('Tipo de estabelecimento não encontrado.');
    return { message: 'Tipo de estabelecimento excluído.' };
  }

  async requireActive(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Selecione um tipo de estabelecimento válido.');
    const item = await this.types.findOne({ _id: id, active: true });
    if (!item) throw new BadRequestException('O tipo selecionado não existe ou está desativado.');
    return item;
  }

  private fields(name: string) { const clean = name.trim().replace(/\s+/g, ' '); const slug = typeSlug(clean); if (!clean || !slug) throw new BadRequestException('Informe um nome válido.'); return { name: clean, normalizedName: normalizeTypeName(clean), slug }; }
}
