import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { corsOptions } from './common/cors';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(corsOptions());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const config = new DocumentBuilder().setTitle('Menu Flow API').setVersion('1.0').addBearerAuth().build();
  SwaggerModule.setup('api', app, SwaggerModule.createDocument(app, config));
  const port = Number.parseInt(process.env.PORT ?? '3001', 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  await app.listen(port, '0.0.0.0');
}
void bootstrap();
