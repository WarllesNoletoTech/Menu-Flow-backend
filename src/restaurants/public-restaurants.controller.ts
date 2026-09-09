import { Controller, Get, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { RestaurantsService } from './restaurants.service';

class PublicRestaurantsQuery {
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Transform(({ value }) => value === 'true') @IsBoolean() open?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 12;
}

@Controller('public')
export class PublicRestaurantsController {
  constructor(private readonly restaurants: RestaurantsService) {}
  @Get('cities') cities() { return this.restaurants.publicCities(); }
  @Get('restaurants') list(@Query() query: PublicRestaurantsQuery) { return this.restaurants.publicList(query); }
}
