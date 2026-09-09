import { Controller, Get, Param } from '@nestjs/common';
import { LocationsService } from './locations.service';
@Controller('locations') export class LocationsController { constructor(private readonly locations: LocationsService) {} @Get('states') states() { return this.locations.states(); } @Get('states/:uf/cities') cities(@Param('uf') uf: string) { return this.locations.cities(uf); } }
