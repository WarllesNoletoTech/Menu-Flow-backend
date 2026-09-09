import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Category, Product } from '../common/schemas';

type AddonGroupInput = { name: string; required?: boolean; min?: number; max?: number; addons: Array<{ name: string; price: number }> };
type ProductInput = { categoryId: string; name: string; price: number; description?: string; imageUrl?: string; promotionalPrice?: number; available?: boolean; featured?: boolean; order?: number; addonGroups?: AddonGroupInput[] };
type ProductUpdateInput = Partial<Omit<ProductInput, 'categoryId'>> & { categoryId?: string };

@Injectable()
export class CatalogService {
  constructor(@InjectModel(Category.name) private readonly categories: Model<Category>, @InjectModel(Product.name) private readonly products: Model<Product>) {}
  categoriesFor(restaurantId: string) { return this.categories.find({ restaurantId, active: true }).sort({ order: 1 }).lean(); }
  productsFor(restaurantId: string) { return this.products.find({ restaurantId, available: true }).sort({ order: 1 }).lean(); }
  async publicMenu(restaurantId: string) { const [categories, products] = await Promise.all([this.categoriesFor(restaurantId), this.productsFor(restaurantId)]); return { categories, products }; }
  createCategory(restaurantId: string, input: { name: string; order?: number; active?: boolean }) { return this.categories.create({ ...input, restaurantId: new Types.ObjectId(restaurantId) }); }
  async updateCategory(restaurantId: string, id: string, input: Partial<Category>) { const category = await this.categories.findOneAndUpdate({ _id: id, restaurantId }, input, { new: true, runValidators: true }); if (!category) throw new NotFoundException('Category not found'); return category; }
  async createProduct(restaurantId: string, input: ProductInput) { await this.ensureProductInput(restaurantId, input); return this.products.create({ ...input, restaurantId: new Types.ObjectId(restaurantId) }); }
  async updateProduct(restaurantId: string, id: string, input: ProductUpdateInput) { await this.ensureProductInput(restaurantId, input); const product = await this.products.findOneAndUpdate({ _id: id, restaurantId }, input, { new: true, runValidators: true }); if (!product) throw new NotFoundException('Product not found'); return product; }
  private async ensureProductInput(restaurantId: string, input: Partial<ProductInput>) {
    if (input.categoryId && !(await this.categories.exists({ _id: input.categoryId, restaurantId }))) throw new NotFoundException('Category not found');
    if (input.promotionalPrice !== undefined && input.price !== undefined && input.promotionalPrice > input.price) throw new BadRequestException('Promotional price cannot exceed the regular price');
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
