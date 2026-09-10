import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Category, Product } from '../common/schemas';

type AddonGroupInput = {
  name: string;
  required?: boolean;
  min?: number;
  max?: number;
  addons: Array<{ name: string; price: number }>;
};

type CategoryInput = { name: string; order?: number; active?: boolean };
type CategoryUpdateInput = Partial<CategoryInput>;
type ProductInput = {
  categoryId: string;
  name: string;
  price: number;
  description?: string | null;
  imageUrl?: string | null;
  promotionalPrice?: number | null;
  available?: boolean;
  featured?: boolean;
  order?: number;
  addonGroups?: AddonGroupInput[];
};
type ProductUpdateInput = Partial<Omit<ProductInput, 'categoryId'>> & { categoryId?: string };

@Injectable()
export class CatalogService {
  constructor(
    @InjectModel(Category.name) private readonly categories: Model<Category>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
  ) {}

  categoriesFor(restaurantId: string) {
    const rid = this.restaurantObjectId(restaurantId);
    return this.categories.find({ restaurantId: rid, active: true }).sort({ order: 1, _id: 1 }).lean();
  }

  productsFor(restaurantId: string) {
    const rid = this.restaurantObjectId(restaurantId);
    return this.products.find({ restaurantId: rid, available: true }).sort({ order: 1, _id: 1 }).lean();
  }

  manageCategories(restaurantId: string) {
    const rid = this.restaurantObjectId(restaurantId);
    return this.categories.find({ restaurantId: rid }).sort({ order: 1, _id: 1 }).lean();
  }

  manageProducts(restaurantId: string) {
    const rid = this.restaurantObjectId(restaurantId);
    return this.products.find({ restaurantId: rid }).sort({ categoryId: 1, order: 1, _id: 1 }).lean();
  }

  async publicMenu(restaurantId: string) {
    const rid = this.restaurantObjectId(restaurantId);
    const categories = await this.categories.find({ restaurantId: rid, active: true }).sort({ order: 1, _id: 1 }).lean();
    const products = await this.products
      .find({ restaurantId: rid, available: true, categoryId: { $in: categories.map((category) => category._id) } })
      .sort({ order: 1, _id: 1 })
      .lean();
    return { categories, products };
  }

  async createCategory(restaurantId: string, input: CategoryInput) {
    const rid = this.restaurantObjectId(restaurantId);
    const name = this.cleanRequiredName(input.name, 'Informe o nome da categoria.');
    await this.ensureUniqueCategoryName(rid, name);

    const category = await this.categories.create({
      name,
      restaurantId: rid,
      order: input.order ?? await this.categories.countDocuments({ restaurantId: rid }),
      active: input.active ?? true,
    });
    return category.toObject();
  }

  async updateCategory(restaurantId: string, id: string, input: CategoryUpdateInput) {
    const rid = this.restaurantObjectId(restaurantId);
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Categoria não encontrada.');

    const changes: CategoryUpdateInput = {};
    if (input.name !== undefined) {
      const name = this.cleanRequiredName(input.name, 'Informe o nome da categoria.');
      await this.ensureUniqueCategoryName(rid, name, id);
      changes.name = name;
    }
    if (input.order !== undefined) changes.order = input.order;
    if (input.active !== undefined) changes.active = input.active;

    const category = await this.categories.findOneAndUpdate(
      { _id: new Types.ObjectId(id), restaurantId: rid },
      { $set: changes },
      { new: true, runValidators: true },
    ).lean();
    if (!category) throw new NotFoundException('Categoria não encontrada.');
    return category;
  }

  async createProduct(restaurantId: string, input: ProductInput) {
    const rid = this.restaurantObjectId(restaurantId);
    const normalized = await this.normalizeProductInput(rid, input, true);
    const categoryId = new Types.ObjectId(normalized.categoryId!);
    const order = normalized.order ?? await this.products.countDocuments({ restaurantId: rid, categoryId });
    const product = await this.products.create({ ...normalized, categoryId, order, restaurantId: rid });
    return product.toObject();
  }

  async updateProduct(restaurantId: string, id: string, input: ProductUpdateInput) {
    const rid = this.restaurantObjectId(restaurantId);
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Produto não encontrado.');

    const existing = await this.products.findOne({ _id: new Types.ObjectId(id), restaurantId: rid }).lean();
    if (!existing) throw new NotFoundException('Produto não encontrado.');

    const normalized = await this.normalizeProductInput(rid, input, false);
    const effectivePrice = normalized.price ?? existing.price;
    const effectivePromotionalPrice = normalized.promotionalPrice === null
      ? undefined
      : normalized.promotionalPrice ?? existing.promotionalPrice;
    if (effectivePromotionalPrice !== undefined && effectivePromotionalPrice > effectivePrice) {
      throw new BadRequestException('O preço promocional não pode superar o preço normal.');
    }

    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    for (const [key, value] of Object.entries(normalized)) {
      if (['promotionalPrice', 'description', 'imageUrl'].includes(key) && (value === null || value === '')) unset[key] = 1;
      else if (value !== undefined) set[key] = value;
    }

    const updated = await this.products.findOneAndUpdate(
      { _id: new Types.ObjectId(id), restaurantId: rid },
      {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { new: true, runValidators: true },
    ).lean();
    if (!updated) throw new NotFoundException('Produto não encontrado.');
    return updated;
  }

  reorderCategories(restaurantId: string, items: Array<{ id: string; order: number }>) {
    return this.reorder(this.categories, restaurantId, items);
  }

  reorderProducts(restaurantId: string, items: Array<{ id: string; order: number }>) {
    return this.reorder(this.products, restaurantId, items);
  }

  private async reorder(
    model: Model<Category> | Model<Product>,
    restaurantId: string,
    items: Array<{ id: string; order: number }>,
  ) {
    const rid = this.restaurantObjectId(restaurantId);
    const ids = items.map((item) => item.id);
    if (
      new Set(ids).size !== ids.length ||
      new Set(items.map((item) => item.order)).size !== items.length ||
      ids.some((id) => !Types.ObjectId.isValid(id))
    ) {
      throw new BadRequestException('A ordenação contém itens ou posições duplicadas.');
    }

    const objectIds = ids.map((id) => new Types.ObjectId(id));
    const owned = await model.countDocuments({ _id: { $in: objectIds }, restaurantId: rid });
    if (owned !== ids.length) throw new NotFoundException('Um ou mais itens não pertencem ao estabelecimento.');

    await (model as unknown as Model<Record<string, unknown>>).bulkWrite(
      items.map((item) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(item.id), restaurantId: rid },
          update: { $set: { order: item.order } },
        },
      })),
    );
    return { updated: items.length };
  }

  private restaurantObjectId(restaurantId: string) {
    if (!Types.ObjectId.isValid(restaurantId)) {
      throw new BadRequestException('Estabelecimento inválido para a operação de catálogo.');
    }
    return new Types.ObjectId(restaurantId);
  }

  private cleanRequiredName(value: string, message: string) {
    const name = value.trim();
    if (!name) throw new BadRequestException(message);
    return name;
  }

  private async ensureUniqueCategoryName(restaurantId: Types.ObjectId, name: string, exceptId?: string) {
    const nameFilter = { $regex: `^${escapeRegex(name)}$`, $options: 'i' };
    const duplicate = exceptId && Types.ObjectId.isValid(exceptId)
      ? await this.categories.exists({ restaurantId, name: nameFilter, _id: { $ne: new Types.ObjectId(exceptId) } })
      : await this.categories.exists({ restaurantId, name: nameFilter });
    if (duplicate) throw new ConflictException('Já existe uma categoria com esse nome.');
  }

  private async normalizeProductInput(
    restaurantId: Types.ObjectId,
    input: ProductUpdateInput,
    creating: boolean,
  ): Promise<ProductUpdateInput> {
    const normalized: ProductUpdateInput = {};

    if (input.categoryId !== undefined) {
      if (!Types.ObjectId.isValid(input.categoryId)) throw new BadRequestException('Categoria inválida para o produto.');
      const categoryId = new Types.ObjectId(input.categoryId);
      if (!(await this.categories.exists({ _id: categoryId, restaurantId }))) throw new NotFoundException('Categoria não encontrada.');
      normalized.categoryId = input.categoryId;
    } else if (creating) {
      throw new BadRequestException('Selecione uma categoria para o produto.');
    }

    if (input.name !== undefined) normalized.name = this.cleanRequiredName(input.name, 'Informe o nome do produto.');
    else if (creating) throw new BadRequestException('Informe o nome do produto.');

    if (input.price !== undefined) normalized.price = input.price;
    else if (creating) throw new BadRequestException('Informe o preço do produto.');

    if (input.description !== undefined) normalized.description = input.description?.trim() || null;
    if (input.imageUrl !== undefined) normalized.imageUrl = input.imageUrl?.trim() || null;
    if (input.promotionalPrice !== undefined) normalized.promotionalPrice = input.promotionalPrice;
    if (input.available !== undefined) normalized.available = input.available;
    if (input.featured !== undefined) normalized.featured = input.featured;
    if (input.order !== undefined) normalized.order = input.order;
    if (input.addonGroups !== undefined) normalized.addonGroups = this.normalizeAddonGroups(input.addonGroups);

    if (
      normalized.promotionalPrice !== undefined &&
      normalized.promotionalPrice !== null &&
      normalized.price !== undefined &&
      normalized.promotionalPrice > normalized.price
    ) {
      throw new BadRequestException('O preço promocional não pode superar o preço normal.');
    }

    return normalized;
  }

  private normalizeAddonGroups(groups: AddonGroupInput[]) {
    const groupNames = new Set<string>();
    const addonNames = new Set<string>();

    return groups.map((group) => {
      const groupName = this.cleanRequiredName(group.name, 'Informe o nome de todos os grupos de adicionais.');
      const normalizedGroupName = groupName.toLocaleLowerCase('pt-BR');
      if (groupNames.has(normalizedGroupName)) throw new BadRequestException('Os grupos de adicionais precisam ter nomes diferentes.');
      groupNames.add(normalizedGroupName);

      if (!group.addons.length) throw new BadRequestException(`O grupo “${groupName}” precisa ter pelo menos uma opção.`);
      const min = group.min ?? (group.required ? 1 : 0);
      const max = group.max ?? 1;
      if (min > max || max > group.addons.length) throw new BadRequestException(`Revise as quantidades do grupo “${groupName}”.`);

      const addons = group.addons.map((addon) => {
        const addonName = this.cleanRequiredName(addon.name, `Informe o nome de todas as opções do grupo “${groupName}”.`);
        const normalizedAddonName = addonName.toLocaleLowerCase('pt-BR');
        if (addonNames.has(normalizedAddonName)) throw new BadRequestException(`A opção “${addonName}” está duplicada neste produto.`);
        addonNames.add(normalizedAddonName);
        return { name: addonName, price: addon.price };
      });

      return { name: groupName, required: Boolean(group.required), min, max, addons };
    });
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
