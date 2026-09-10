import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { AuditLog, AuditLogSchema, HomeBanner, HomeBannerSchema } from '../common/schemas';
import { HomeBannersController, PublicHomeBannersController } from './home-banners.controller';
import { HomeBannersService } from './home-banners.service';
@Module({ imports: [AuthModule, MongooseModule.forFeature([{ name: HomeBanner.name, schema: HomeBannerSchema }, { name: AuditLog.name, schema: AuditLogSchema }])], controllers: [HomeBannersController, PublicHomeBannersController], providers: [HomeBannersService] })
export class HomeBannersModule {}
