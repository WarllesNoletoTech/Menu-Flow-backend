import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Category, Product } from '../common/schemas';

type AddonGroupInput = { name: string; required?: boolean; min?: number; max?: number; addons: Array<{ name: string; price: number }> };
type ProductInput = { categoryId: string; name: string; price: number; description?: string | null; imageUrl?: string | null; promotionalPrice?: number | null; available?: boolean; featured?: boolean; order?: number; addonGroups?: AddonGroupInput[] };
type ProductUpdateInput = Partial<Omit<ProductInput, 'categoryId'>> & { categoryId?: string };

@Injectable()
export class CatalogService {
  constructor(@InjectModel(Category.name) private readonly categories: Model<Category>, @InjectModel(Product.name) private readonly products: Model<Product>) {}
  categoriesFor(restaurantId: string) { return this.categories.find({ restaurantId, active: true }).sort({ order: 1 }).lean(); }
  productsFor(restaurantId: string) { return this.products.find({ restaurantId, available: true }).sort({ order: 1 }).lean(); }
  manageCategories(restaurantId: string) { return this.categories.find({ restaurantId }).sort({ order: 1, _id: 1 }).lean(); }
  manageProducts(restaurantId: string) { return this.products.find({ restaurantId }).sort({ categoryId: 1, order: 1, _id: 1 }).lean(); }
  async publicMenu(restaurantId: string) { const categories = await this.categoriesFor(restaurantId); const products = await this.products.find({ restaurantId, available: true, categoryId: { $in: categories.map(category => category._id) } }).sort({ order: 1 }).lean(); return { categories, products }; }
  createCategory(restaurantId: string, input: { name: string; order?: number; active?: boolean }) { this.ensureRestaurantId(restaurantId); return this.categories.create({ ...input, name: input.name.trim(), restaurantId: new Types.ObjectId(restaurantId) }); }
  async updateCategory(restaurantId: string, id: string, input: Partial<Category>) { const category = await this.categories.findOneAndUpdate({ _id: id, restaurantId }, input, { new: true, runValidators: true }); if (!category) throw new NotFoundException('Category not found'); return category; }
  async createProduct(restaurantId: string, input: ProductInput) { this.ensureRestaurantId(restaurantId); await this.ensureProductInput(restaurantId, input); return this.products.create({ ...input, restaurantId: new Types.ObjectId(restaurantId) }); }
  async updateProduct(restaurantId: string, id: string, input: ProductUpdateInput) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Product not found');
    const existing = await this.products.findOne({ _id: id, restaurantId }).lean();
    if (!existing) throw new NotFoundException('Product not found');
    await this.ensureProductInput(restaurantId, input);
    const effectivePrice = input.price ?? existing.price;
    const effectivePromotionalPrice = input.promotionalPrice === null ? undefined : input.promotionalPrice ?? existing.promotionalPrice;
    if (effectivePromotionalPrice !== undefined && effectivePromotionalPrice > effectivePrice) throw new BadRequestException('Promotional price cannot exceed the regular price');
    const set: Record<string, unknown> = {}; const unset: Record<string, 1> = {};
    for (const [key, value] of Object.entries(input)) { if (['promotionalPrice', 'description', 'imageUrl'].includes(key) && (value === null || value === '')) unset[key] = 1; else if (value !== undefined) set[key] = value; }
    return this.products.findOneAndUpdate({ _id: id, restaurantId }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true, runValidators: true });
  }
  reorderCategories(restaurantId: string, items: Array<{ id: string; order: number }>) { return this.reorder(this.categories, restaurantId, items); }
  reorderProducts(restaurantId: string, items: Array<{ id: string; order: number }>) { return this.reorder(this.products, restaurantId, items); }
  private async reorder(model: Model<Category> | Model<Product>, restaurantId: string, items: Array<{ id: string; order: number }>) { const ids = items.map(item => item.id); if (new Set(ids).size !== ids.length || new Set(items.map(item => item.order)).size !== items.length || ids.some(id => !Types.ObjectId.isValid(id))) throw new BadRequestException('A ordenação contém itens ou posições duplicadas.'); const owned = await model.countDocuments({ _id: { $in: ids }, restaurantId }); if (owned !== ids.length) throw new NotFoundException('Um ou mais itens não pertencem ao estabelecimento.'); await (model as unknown as Model<Record<string, unknown>>).bulkWrite(items.map(item => ({ updateOne: { filter: { _id: item.id, restaurantId }, update: { $set: { order: item.order } } } }))); return { updated: items.length }; }
  private ensureRestaurantId(restaurantId: string) { if (!Types.ObjectId.isValid(restaurantId)) throw new BadRequestException('Estabelecimento inválido para a operação de catálogo.'); }
  private async ensureProductInput(restaurantId: string, input: Partial<ProductInput>) {
    this.ensureRestaurantId(restaurantId);
    if (input.categoryId !== undefined && !Types.ObjectId.isValid(input.categoryId)) throw new BadRequestException('Categoria inválida para o produto.');
    if (input.categoryId && !(await this.categories.exists({ _id: input.categoryId, restaurantId }))) throw new NotFoundException('Category not found');
    if (input.promotionalPrice !== undefined && input.promotionalPrice !== null && input.price !== undefined && input.promotionalPrice > input.price) throw new BadRequestException('Promotional price cannot exceed the regular price');
    if (!input.addonGroups) return;
    const groupNames = new Set<string>(); const addonNames = new Set<string>();
    for (const group of input.addonGroups) {
      if (groupNames.has(group.name)) throw new BadRequestException('Add-on group names must be unique');
      groupNames.add(group.name);
      const min = group.min ?? (group.required ? 1 : 0); const max = group.max ?? 1;
      if (min > max || max > group.addons.length) throw new BadRequestException(`Invalid quantity rules for add-on group: ${group.name}`);
      for (const addon of group.addons) {
        if (addonNames.has(addon.name)) throw new BadRequestException('Add-on names must be unique within a product');
        addonNames.add(addon.name);
      }
    }
  }
}
