import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsMongoId, IsNumber, IsOptional, IsString, IsUrl, Min, ValidateIf, ValidateNested } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { TenantGuard } from '../common/tenant.guard';
import { CatalogService } from './catalog.service';

class AddonDto { @IsString() name!: string; @IsNumber() @Min(0) price!: number; }
class AddonGroupDto {
  @IsString() name!: string;
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsNumber() @Min(0) min?: number;
  @IsOptional() @IsNumber() @Min(1) max?: number;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AddonDto) addons!: AddonDto[];
}
class CreateCategoryDto { @IsString() name!: string; @IsOptional() @IsNumber() @Min(0) order?: number; @IsOptional() @IsBoolean() active?: boolean; }
class CreateProductDto {
  @IsMongoId() categoryId!: string; @IsString() name!: string; @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsString() description?: string | null; @IsOptional() @ValidateIf((_, value) => value !== null && value !== '') @IsUrl({ protocols: ['https'], require_protocol: true, require_valid_protocol: true }) imageUrl?: string | null;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsNumber() @Min(0) promotionalPrice?: number | null; @IsOptional() @IsBoolean() available?: boolean;
  @IsOptional() @IsBoolean() featured?: boolean; @IsOptional() @IsNumber() @Min(0) order?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => AddonGroupDto) addonGroups?: AddonGroupDto[];
}
class ReorderItemDto { @IsMongoId() id!: string; @IsNumber() @Min(0) order!: number; }
@Controller('restaurants/:restaurantId')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}
  @Get('categories') categories(@Param('restaurantId') id: string) { return this.catalog.categoriesFor(id); }
  @Get('products') products(@Param('restaurantId') id: string) { return this.catalog.productsFor(id); }
  @Get('menu') menu(@Param('restaurantId') id: string) { return this.catalog.publicMenu(id); }
  @Post('categories') @Roles(Role.RESTAURANT_ADMIN, Role.SUPER_ADMIN) @UseGuards(JwtGuard, TenantGuard, RolesGuard)
  createCategory(@Param('restaurantId') id: string, @Body() body: CreateCategoryDto) { return this.catalog.createCategory(id, body); }
  @Patch('categories/:categoryId') @Roles(Role.RESTAURANT_ADMIN, Role.SUPER_ADMIN) @UseGuards(JwtGuard, TenantGuard, RolesGuard)
  updateCategory(@Param('restaurantId') restaurantId: string, @Param('categoryId') categoryId: string, @Body() body: Partial<CreateCategoryDto>) { return this.catalog.updateCategory(restaurantId, categoryId, body); }
  @Post('products') @Roles(Role.RESTAURANT_ADMIN, Role.SUPER_ADMIN) @UseGuards(JwtGuard, TenantGuard, RolesGuard)
  create(@Param('restaurantId') id: string, @Body() body: CreateProductDto) { return this.catalog.createProduct(id, body); }
  @Patch('products/:productId') @Roles(Role.RESTAURANT_ADMIN, Role.SUPER_ADMIN) @UseGuards(JwtGuard, TenantGuard, RolesGuard)
  update(@Param('restaurantId') restaurantId: string, @Param('productId') productId: string, @Body() body: Partial<CreateProductDto>) { return this.catalog.updateProduct(restaurantId, productId, body); }
}

@Controller('restaurants/me/catalog') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
export class MerchantCatalogController {
  constructor(private readonly catalog: CatalogService) {}
  @Get('categories') categories(@Req() r: { user: { restaurantId: string } }) { return this.catalog.manageCategories(r.user.restaurantId); }
  @Get('products') products(@Req() r: { user: { restaurantId: string } }) { return this.catalog.manageProducts(r.user.restaurantId); }
  @Post('categories') createCategory(@Req() r: { user: { restaurantId: string } }, @Body() b: CreateCategoryDto) { return this.catalog.createCategory(r.user.restaurantId, b); }
  @Patch('categories/reorder') reorderCategories(@Req() r: { user: { restaurantId: string } }, @Body() b: ReorderItemDto[]) { return this.catalog.reorderCategories(r.user.restaurantId, b); }
  @Patch('categories/:categoryId') updateCategory(@Req() r: { user: { restaurantId: string } }, @Param('categoryId') id: string, @Body() b: Partial<CreateCategoryDto>) { return this.catalog.updateCategory(r.user.restaurantId, id, b); }
  @Post('products') createProduct(@Req() r: { user: { restaurantId: string } }, @Body() b: CreateProductDto) { return this.catalog.createProduct(r.user.restaurantId, b); }
  @Patch('products/reorder') reorderProducts(@Req() r: { user: { restaurantId: string } }, @Body() b: ReorderItemDto[]) { return this.catalog.reorderProducts(r.user.restaurantId, b); }
  @Patch('products/:productId') updateProduct(@Req() r: { user: { restaurantId: string } }, @Param('productId') id: string, @Body() b: Partial<CreateProductDto>) { return this.catalog.updateProduct(r.user.restaurantId, id, b); }
}
