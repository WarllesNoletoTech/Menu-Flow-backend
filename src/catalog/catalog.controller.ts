import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { TenantGuard } from '../common/tenant.guard';
import { CatalogService } from './catalog.service';

class AddonDto {
  @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @IsNumber() @Min(0) price!: number;
}

class AddonGroupDto {
  @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsNumber() @Min(0) min?: number;
  @IsOptional() @IsNumber() @Min(1) max?: number;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AddonDto) addons!: AddonDto[];
}

class CreateCategoryDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name!: string;
  @IsOptional() @IsNumber() @Min(0) order?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}

class CreateProductDto {
  @IsMongoId() categoryId!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsString() @MaxLength(600) description?: string | null;
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsUrl({ protocols: ['https'], require_protocol: true, require_valid_protocol: true })
  imageUrl?: string | null;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsNumber() @Min(0) promotionalPrice?: number | null;
  @IsOptional() @IsBoolean() available?: boolean;
  @IsOptional() @IsBoolean() featured?: boolean;
  @IsOptional() @IsNumber() @Min(0) order?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => AddonGroupDto) addonGroups?: AddonGroupDto[];
}
class UpdateProductDto extends PartialType(CreateProductDto) {}

class ReorderItemDto {
  @IsMongoId() id!: string;
  @IsNumber() @Min(0) order!: number;
}

type MerchantRequest = { user: { restaurantId: string } };

@Controller('restaurants/:restaurantId')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  categories(@Param('restaurantId') id: string) { return this.catalog.categoriesFor(id); }

  @Get('products')
  products(@Param('restaurantId') id: string) { return this.catalog.productsFor(id); }

  @Get('menu')
  menu(@Param('restaurantId') id: string) { return this.catalog.publicMenu(id); }

  @Post('categories')
  @Roles(Role.RESTAURANT_ADMIN, Role.SUPER_ADMIN)
  @UseGuards(JwtGuard, TenantGuard, RolesGuard)
  createCategory(@Param('restaurantId') id: string, @Body() body: CreateCategoryDto) {
    return this.catalog.createCategory(id, body);
  }

  @Patch('categories/:categoryId')
  @Roles(Role.RESTAURANT_ADMIN, Role.SUPER_ADMIN)
  @UseGuards(JwtGuard, TenantGuard, RolesGuard)
  updateCategory(
    @Param('restaurantId') restaurantId: string,
    @Param('categoryId') categoryId: string,
    @Body() body: UpdateCategoryDto,
  ) {
    return this.catalog.updateCategory(restaurantId, categoryId, body);
  }

  @Patch('categories/:categoryId/archive')
  @Roles(Role.RESTAURANT_ADMIN, Role.SUPER_ADMIN)
  @UseGuards(JwtGuard, TenantGuard, RolesGuard)
  archiveCategory(@Param('restaurantId') restaurantId: string, @Param('categoryId') id: string) {
    return this.catalog.archiveCategory(restaurantId, id);
  }

  @Post('products')
  @Roles(Role.RESTAURANT_ADMIN, Role.SUPER_ADMIN)
  @UseGuards(JwtGuard, TenantGuard, RolesGuard)
  create(@Param('restaurantId') id: string, @Body() body: CreateProductDto) {
    return this.catalog.createProduct(id, body);
  }

  @Patch('products/:productId')
  @Roles(Role.RESTAURANT_ADMIN, Role.SUPER_ADMIN)
  @UseGuards(JwtGuard, TenantGuard, RolesGuard)
  update(
    @Param('restaurantId') restaurantId: string,
    @Param('productId') productId: string,
    @Body() body: UpdateProductDto,
  ) {
    return this.catalog.updateProduct(restaurantId, productId, body);
  }


  @Patch('products/:productId/archive')
  @Roles(Role.RESTAURANT_ADMIN, Role.SUPER_ADMIN)
  @UseGuards(JwtGuard, TenantGuard, RolesGuard)
  archiveProduct(@Param('restaurantId') restaurantId: string, @Param('productId') id: string) {
    return this.catalog.archiveProduct(restaurantId, id);
  }
}

@Controller('restaurants/me/catalog')
@Roles(Role.RESTAURANT_ADMIN)
@UseGuards(JwtGuard, RolesGuard)
export class MerchantCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  categories(@Req() request: MerchantRequest) { return this.catalog.manageCategories(request.user.restaurantId); }

  @Get('products')
  products(@Req() request: MerchantRequest) { return this.catalog.manageProducts(request.user.restaurantId); }

  @Post('categories')
  createCategory(@Req() request: MerchantRequest, @Body() body: CreateCategoryDto) {
    return this.catalog.createCategory(request.user.restaurantId, body);
  }

  @Patch('categories/reorder')
  reorderCategories(@Req() request: MerchantRequest, @Body() body: ReorderItemDto[]) {
    return this.catalog.reorderCategories(request.user.restaurantId, body);
  }

  @Patch('categories/:categoryId')
  updateCategory(@Req() request: MerchantRequest, @Param('categoryId') id: string, @Body() body: UpdateCategoryDto) {
    return this.catalog.updateCategory(request.user.restaurantId, id, body);
  }

  @Patch('categories/:categoryId/archive')
  archiveCategory(@Req() request: MerchantRequest, @Param('categoryId') id: string) {
    return this.catalog.archiveCategory(request.user.restaurantId, id);
  }

  @Post('products')
  createProduct(@Req() request: MerchantRequest, @Body() body: CreateProductDto) {
    return this.catalog.createProduct(request.user.restaurantId, body);
  }

  @Patch('products/reorder')
  reorderProducts(@Req() request: MerchantRequest, @Body() body: ReorderItemDto[]) {
    return this.catalog.reorderProducts(request.user.restaurantId, body);
  }

  @Patch('products/:productId')
  updateProduct(@Req() request: MerchantRequest, @Param('productId') id: string, @Body() body: UpdateProductDto) {
    return this.catalog.updateProduct(request.user.restaurantId, id, body);
  }

  @Patch('products/:productId/archive')
  archiveProduct(@Req() request: MerchantRequest, @Param('productId') id: string) {
    return this.catalog.archiveProduct(request.user.restaurantId, id);
  }
}

@Controller('restaurants/:restaurantId/manage-catalog')
@Roles(Role.SUPER_ADMIN)
@UseGuards(JwtGuard, RolesGuard)
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories') categories(@Param('restaurantId') id: string) { return this.catalog.manageCategories(id); }
  @Get('products') products(@Param('restaurantId') id: string) { return this.catalog.manageProducts(id); }
  @Post('categories') createCategory(@Param('restaurantId') id: string, @Body() body: CreateCategoryDto) { return this.catalog.createCategory(id, body); }
  @Patch('categories/reorder') reorderCategories(@Param('restaurantId') id: string, @Body() body: ReorderItemDto[]) { return this.catalog.reorderCategories(id, body); }
  @Patch('categories/:categoryId') updateCategory(@Param('restaurantId') id: string, @Param('categoryId') categoryId: string, @Body() body: UpdateCategoryDto) { return this.catalog.updateCategory(id, categoryId, body); }
  @Post('products') createProduct(@Param('restaurantId') id: string, @Body() body: CreateProductDto) { return this.catalog.createProduct(id, body); }
  @Patch('products/reorder') reorderProducts(@Param('restaurantId') id: string, @Body() body: ReorderItemDto[]) { return this.catalog.reorderProducts(id, body); }
  @Patch('products/:productId') updateProduct(@Param('restaurantId') id: string, @Param('productId') productId: string, @Body() body: UpdateProductDto) { return this.catalog.updateProduct(id, productId, body); }
}
